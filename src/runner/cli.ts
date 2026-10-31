import { statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { OfficeCliEngine } from '../adapters/office/cli-engine.js';
import { officeRunnerEngine } from '../adapters/office/engine.js';
import { TowerRunner } from './runner.js';
import { createFileStateStore } from './state.js';
import { createHttpTransport } from './transport.js';

export const USAGE = `usage:
  tower-runner register --url <origin> --state <file> --version <x.y.z> --digest <sha256:...> [--capability <name>]...
      reads the enrollment token from TOWER_ENROLLMENT_TOKEN, redeems it once, stores the credential in <file>
  tower-runner run --url <origin> --state <file> --version <x.y.z> --digest <sha256:...> --repo <path> [--office-bin <path>] [--capability <name>]...
      polls Tower and runs granted work with the Office CLI until interrupted`;

export class UsageError extends Error {
  override readonly name = 'UsageError';
}

export interface CliOptions {
  command: 'register' | 'run';
  url: string;
  statePath: string;
  version: string;
  buildDigest: string;
  capabilities: string[];
  repoPath: string | undefined;
  officeBinary: string;
}

const VALUE_FLAGS = new Set([
  '--url',
  '--state',
  '--version',
  '--digest',
  '--capability',
  '--repo',
  '--office-bin',
]);

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Tower over https, or plain http only to a loopback address. The credential never crosses cleartext. */
function checkUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError('--url must be an absolute URL');
  }
  if (url.protocol === 'https:') {
    return;
  }
  if (url.protocol === 'http:' && LOOPBACK.has(url.hostname)) {
    return;
  }
  throw new UsageError('--url must use https, except for a loopback address');
}

/** The device and inode of an existing path, which identify a directory whatever it is called. */
function identityOf(path: string): { dev: number; ino: number } | undefined {
  try {
    const info = statSync(path);
    return { dev: info.dev, ino: info.ino };
  } catch {
    return undefined;
  }
}

/**
 * Whether `child` is `parent` or lies under it. Identity is compared rather than the path text, so a
 * symlink, a different spelling of the same folder (case on macOS), or a directory that does not exist
 * yet cannot hide the state file inside the repository. The state file's ancestors are checked
 * upward until one of them is the repository.
 */
function isInside(child: string, parent: string): boolean {
  const target = identityOf(resolve(parent));
  if (target === undefined) {
    // No repository to compare with yet. Fall back to the path text, which only ever refuses more.
    const rel = relative(resolve(parent), resolve(child));
    return (
      rel === '' ||
      (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
    );
  }
  for (let current = resolve(child); ; current = dirname(current)) {
    const id = identityOf(current);
    if (id !== undefined && id.dev === target.dev && id.ino === target.ino) {
      return true;
    }
    if (dirname(current) === current) {
      return false;
    }
  }
}

/** Reads the arguments. Unknown flags and missing required values are refused, not ignored. */
export function parseCli(argv: readonly string[]): CliOptions {
  const [command, ...rest] = argv;
  if (command !== 'register' && command !== 'run') {
    throw new UsageError(`unknown command ${JSON.stringify(command ?? '')}`);
  }
  const values = new Map<string, string[]>();
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i] ?? '';
    if (!VALUE_FLAGS.has(flag)) {
      throw new UsageError(`unknown argument ${JSON.stringify(flag)}`);
    }
    const value = rest[i + 1];
    if (value === undefined || value === '' || value.startsWith('--')) {
      throw new UsageError(`${flag} needs a value`);
    }
    values.set(flag, [...(values.get(flag) ?? []), value]);
    i += 1;
  }
  const one = (flag: string): string | undefined => values.get(flag)?.at(-1);
  const required = (flag: string): string => {
    const value = one(flag);
    if (value === undefined) {
      throw new UsageError(`${flag} is required`);
    }
    return value;
  };
  const url = required('--url');
  checkUrl(url);
  const statePath = required('--state');
  const repoPath = one('--repo');
  // The engine runs in the repository, or in the working directory when none is given.
  if (isInside(statePath, repoPath ?? process.cwd())) {
    // The engine runs with the same user, so the credential must live outside its repository.
    throw new UsageError(
      '--state must be outside the repository the engine runs in',
    );
  }
  return {
    command,
    url,
    statePath,
    version: required('--version'),
    buildDigest: required('--digest'),
    capabilities: values.get('--capability') ?? [],
    repoPath,
    officeBinary: one('--office-bin') ?? 'office',
  };
}

export interface CliIo {
  log(line: string): void;
  error(line: string): void;
}

/** Runs the CLI and returns the process exit code. */
export async function main(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  io: CliIo = { log: console.log, error: console.error },
  signal: AbortSignal = new AbortController().signal,
): Promise<number> {
  let options: CliOptions;
  try {
    options = parseCli(argv);
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    io.error(USAGE);
    return 2;
  }
  try {
    return await run(options, env, io, signal);
  } catch (error) {
    // A fatal refusal or a failed write ends the runner. Say why, and exit non-zero.
    io.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function run(
  options: CliOptions,
  env: Readonly<Record<string, string | undefined>>,
  io: CliIo,
  signal: AbortSignal,
): Promise<number> {
  const transport = createHttpTransport(options.url);
  const store = createFileStateStore(options.statePath);
  const engine = officeRunnerEngine(
    new OfficeCliEngine({
      repoPath: options.repoPath ?? process.cwd(),
      binary: options.officeBinary,
    }),
  );
  const runner = new TowerRunner({
    transport,
    engine,
    store,
    binding: { version: options.version, buildDigest: options.buildDigest },
    capabilities: options.capabilities,
    log: io.log,
  });

  if (options.command === 'register') {
    const token = env.TOWER_ENROLLMENT_TOKEN;
    if (token === undefined || token === '') {
      io.error('TOWER_ENROLLMENT_TOKEN must be set to register');
      return 2;
    }
    await runner.register(token);
    io.log(`registered as ${runner.runnerId ?? 'unknown runner'}`);
    return 0;
  }

  runner.start();
  const stop = () => runner.stop();
  signal.addEventListener('abort', stop, { once: true });
  try {
    await runner.run(signal);
    return 0;
  } finally {
    // Whatever ends the loop, the running jobs stop before the process exits.
    signal.removeEventListener('abort', stop);
    runner.stop();
    await runner.drain();
  }
}
