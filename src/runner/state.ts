import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { Assignment, ReceiptBody } from './protocol.js';

/**
 * Where a lease is in the runner's own life. `running` needs an engine; after a restart no engine
 * is alive, so the runner moves it to `reconcile` before doing anything else with it.
 */
export type LocalPhase = 'running' | 'reconcile' | 'finishing';

export interface LocalLease {
  leaseId: string;
  attemptId: string;
  missionId: string;
  packetId: string;
  scopeKey: string;
  /** The fence this runner last heard from Tower. Presented on every write. */
  fence: number;
  /** Last step Tower confirmed. A step is confirmed once Tower returned 200 or 201 for it. */
  progressSeq: number;
  packet: Assignment['packet'];
  mission: Assignment['mission'];
  phase: LocalPhase;
  /** Written before the first send, so a receipt lost on the way is resent unchanged. */
  receipt: ReceiptBody | null;
}

export interface RunnerState {
  runnerId: string;
  token: string;
  leases: Record<string, LocalLease>;
}

/** Persistence for the runner's state. Written after every change that Tower must not forget. */
export interface StateStore {
  load(): RunnerState | undefined;
  save(state: RunnerState): void;
}

export function createMemoryStateStore(): StateStore {
  let stored: RunnerState | undefined;
  return {
    load: () => (stored === undefined ? undefined : structuredClone(stored)),
    save: (state) => {
      stored = structuredClone(state);
    },
  };
}

/**
 * A JSON file holding the runner's credential and lease records. It is written to a temporary
 * file and renamed, so a crash leaves the old state or the new state, never a torn one. The file
 * is owner-only, since it holds the runner credential.
 */
export function createFileStateStore(path: string): StateStore {
  return {
    load() {
      let text: string;
      try {
        text = readFileSync(path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return undefined;
        }
        throw error;
      }
      return JSON.parse(text) as RunnerState;
    },
    save(state) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const temp = `${path}.tmp`;
      // A stale temp file, or a symlink planted at its name, is removed. Exclusive create then
      // never writes through a link.
      rmSync(temp, { force: true });
      const fd = openSync(temp, 'wx', 0o600);
      try {
        writeSync(fd, `${JSON.stringify(state, null, 2)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, path);
      // Make the rename itself durable, so a power loss cannot bring back the old file.
      const dirFd = openSync(dirname(path), 'r');
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    },
  };
}
