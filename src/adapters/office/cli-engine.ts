import { spawn } from 'node:child_process';
import type { EngineHooks } from '../../runner/engine.js';
import { ClassifiedFailure } from '../../runner/failure.js';
import { ContractError } from './contract.js';
import type { OfficePacket } from './packet.js';
import { type OfficeReceipt, parseOfficeReceipt } from './receipt.js';

/** Longest goal argv Tower will pass. Larger packets are refused, not truncated. */
export const MAX_GOAL_CHARS = 32_000;

/** Two hours. A packet that runs longer is stopped and classed as a runner failure. */
export const DEFAULT_TIMEOUT_MS = 2 * 60 * 60 * 1_000;

export interface ProcessRequest {
  argv: readonly string[];
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs one program with an argv array. Implementations must not hand the argv to a shell. Tests
 * stub this; the real `execProcess` below is the only place a child process starts.
 */
export type ProcessRunner = (request: ProcessRequest) => Promise<ProcessResult>;

/** The goal text Office receives as one positional argument. Nothing in it is interpreted by a shell. */
export function goalFor(packet: OfficePacket): string {
  const lines = [
    packet.title,
    '',
    `Outcome: ${packet.outcome}`,
    `Intent: ${packet.intent}`,
  ];
  if (packet.constraints.length > 0) {
    lines.push('Constraints:', ...packet.constraints.map((c) => `- ${c}`));
  }
  lines.push('', 'Instructions:', packet.instructions);
  return lines.join('\n');
}

/**
 * The argv for one packet. The goal follows `--`, so text that starts with a dash is a positional
 * value and never an option. Office's own publishing is off (`--no-prs`), and it stops at a
 * question to a human rather than deciding to merge.
 */
export function buildOfficeArgv(
  packet: OfficePacket,
  binary = 'office',
): string[] {
  const goal = goalFor(packet);
  if (goal.includes('\0')) {
    // A NUL cannot be passed in argv. The packet is at fault, not the runner.
    throw new ClassifiedFailure(
      'adapter',
      'the packet goal contains a NUL byte',
    );
  }
  if (goal.length > MAX_GOAL_CHARS) {
    throw new ClassifiedFailure(
      'adapter',
      `the packet goal is ${goal.length} characters; the limit is ${MAX_GOAL_CHARS}`,
    );
  }
  return [
    binary,
    'start',
    '--json',
    '--no-prs',
    '--end-state',
    'ask',
    '--blast-radius',
    'repo',
    '--',
    goal,
  ];
}

/** Longest output kept from one run. Anything past it is dropped, so a runaway child cannot exhaust memory. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
/** Time between SIGTERM to the group and SIGKILL to the group, for a child that ignores SIGTERM. */
const KILL_GRACE_MS = 5_000;
/**
 * After the leader exits, how long to wait for its output pipes to close. A background child may
 * hold a pipe open, so the run does not wait for it beyond this.
 */
const PIPE_GRACE_MS = 2_000;

/**
 * Environment for the child. Tower's own variables are removed, so an engine cannot read the
 * runner's enrollment or credential variables.
 */
export function childEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && !key.startsWith('TOWER_')) {
      env[key] = value;
    }
  }
  return env;
}

/**
 * The real process runner. The child leads its own process group. An abort or the timeout signals
 * the whole group, and so does the end of the run, so no child the engine started outlives it.
 * It is started without a shell.
 */
export const execProcess: ProcessRunner = ({ argv, cwd, timeoutMs, signal }) =>
  new Promise((resolve, reject) => {
    const [file, ...args] = argv;
    if (file === undefined) {
      reject(new Error('empty argv'));
      return;
    }
    const child = spawn(file, args, {
      cwd,
      detached: true,
      env: childEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    // setEncoding decodes across chunk boundaries, so a multi-byte character is not split.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    let stopped: string | undefined;
    let exitCode: number | null = null;
    let settled = false;
    const timers: NodeJS.Timeout[] = [];
    const group = (sig: NodeJS.Signals) => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, sig);
        } catch {
          // The group has already ended.
        }
      }
    };
    const stop = (reason: string) => {
      // A leader that already exited cleanly has finished its work. A late stop must not undo that.
      if (stopped !== undefined || settled || exitCode !== null) {
        return;
      }
      stopped = reason;
      group('SIGTERM');
      timers.push(setTimeout(() => group('SIGKILL'), KILL_GRACE_MS));
    };
    const timeout = setTimeout(() => stop('timed out'), timeoutMs);
    timers.push(timeout);
    const onAbort = () => stop('aborted');
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const settle = (code: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      for (const timer of timers) {
        clearTimeout(timer);
      }
      signal.removeEventListener('abort', onAbort);
      // Whatever the run left behind goes too, so nothing keeps working in the repository.
      group('SIGKILL');
      child.stdout.destroy();
      child.stderr.destroy();
      if (stopped !== undefined) {
        // Not a spawn error, so the caller classes it as a runner failure.
        reject(
          Object.assign(new Error(`office ${stopped}`), { code: 'STOPPED' }),
        );
        return;
      }
      resolve({ exitCode: code ?? exitCode ?? 1, stdout, stderr });
    };
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < MAX_OUTPUT_BYTES) {
        stdout += chunk;
      }
    });
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < MAX_OUTPUT_BYTES) {
        stderr += chunk;
      }
    });
    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      for (const timer of timers) {
        clearTimeout(timer);
      }
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
    // The leader's exit can come before its pipes have drained, so wait briefly for them to close.
    child.on('exit', (code) => {
      exitCode = code;
      timers.push(setTimeout(() => settle(code), PIPE_GRACE_MS));
    });
    child.on('close', (code) => settle(code));
  });

export interface OfficeCliOptions {
  /** The repository Office runs in. It is the working directory for the child process. */
  repoPath: string;
  binary?: string;
  timeoutMs?: number;
  runProcess?: ProcessRunner;
}

const QUOTA = /quota|rate.?limit|usage limit|too many requests/i;

function spawnFailureClass(error: unknown): 'environment' | 'runner' {
  const code = (error as { code?: unknown }).code;
  return code === 'ENOENT' || code === 'EACCES' ? 'environment' : 'runner';
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : 'unknown error';
}

/**
 * Turns one process result into a receipt, or a classified failure. The receipt is trusted only
 * when it is for this attempt, and an exit code that contradicts it is refused.
 */
export function receiptFrom(
  result: ProcessResult,
  packet: OfficePacket,
): OfficeReceipt {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    if (result.exitCode !== 0) {
      const text = `${result.stderr}\n${result.stdout}`;
      throw new ClassifiedFailure(
        result.exitCode === 127
          ? 'environment'
          : QUOTA.test(text)
            ? 'quota'
            : 'adapter',
        `office exited ${result.exitCode} without a receipt`,
      );
    }
    throw new ClassifiedFailure('adapter', 'office printed no JSON receipt');
  }
  let receipt: OfficeReceipt;
  try {
    receipt = parseOfficeReceipt(parsed);
  } catch (error) {
    const reason = error instanceof ContractError ? error.code : 'unreadable';
    throw new ClassifiedFailure(
      'adapter',
      `office receipt was refused (${reason})`,
    );
  }
  if (receipt.correlationId !== packet.correlationId) {
    throw new ClassifiedFailure(
      'adapter',
      'office receipt is for another attempt',
    );
  }
  if (result.exitCode !== 0 && receipt.outcome === 'succeeded') {
    throw new ClassifiedFailure(
      'adapter',
      `office exited ${result.exitCode} but reported success`,
    );
  }
  return receipt;
}

/** Runs one packet as an Office run through the `office` CLI. */
export class OfficeCliEngine {
  constructor(private readonly options: OfficeCliOptions) {}

  async run(
    packet: OfficePacket,
    hooks: Pick<EngineHooks, 'signal'>,
  ): Promise<OfficeReceipt> {
    const argv = buildOfficeArgv(packet, this.options.binary);
    const runProcess = this.options.runProcess ?? execProcess;
    let result: ProcessResult;
    try {
      result = await runProcess({
        argv,
        cwd: this.options.repoPath,
        timeoutMs: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        signal: hooks.signal,
      });
    } catch (error) {
      throw new ClassifiedFailure(
        spawnFailureClass(error),
        `office did not run: ${errorCode(error)}`,
      );
    }
    return receiptFrom(result, packet);
  }
}
