import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildOfficeArgv,
  childEnvironment,
  execProcess,
} from '../../../src/adapters/office/cli-engine.js';
import { buildOfficePacket } from '../../../src/adapters/office/packet.js';
import { ClassifiedFailure } from '../../../src/runner/failure.js';

async function waitUntil(check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error('condition not met in time');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('execProcess stops the whole process group', () => {
  it('an abort also stops the engine’s own child processes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'office-group-'));
    const pidFile = join(dir, 'pid');
    const controller = new AbortController();
    const run = execProcess({
      argv: ['/bin/sh', '-c', `sleep 30 & echo $! > "${pidFile}"; wait`],
      cwd: dir,
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    await waitUntil(
      () => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '',
    );
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(alive(pid)).toBe(true);
    controller.abort();
    await expect(run).rejects.toThrow(/aborted/);
    await waitUntil(() => !alive(pid));
    expect(alive(pid)).toBe(false);
  });
});

describe('the engine environment', () => {
  it('drops Tower variables and keeps the rest', () => {
    const env = childEnvironment({
      PATH: '/usr/bin',
      TOWER_ENROLLMENT_TOKEN: 'tk_secret',
      TOWER_STATE: '/x',
      HOME: '/home/u',
    });
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/u' });
  });

  it('does not pass a Tower variable from the runner into the engine process', async () => {
    process.env.TOWER_ENROLLMENT_TOKEN = 'tk_secret';
    try {
      const result = await execProcess({
        argv: [
          process.execPath,
          '-e',
          'process.stdout.write(String(process.env.TOWER_ENROLLMENT_TOKEN))',
        ],
        cwd: process.cwd(),
        timeoutMs: 10_000,
        signal: new AbortController().signal,
      });
      expect(result.stdout).toBe('undefined');
    } finally {
      delete process.env.TOWER_ENROLLMENT_TOKEN;
    }
  });
});

describe('a NUL byte in the packet', () => {
  it('is refused as an adapter failure, since the packet is at fault', () => {
    const packet = buildOfficePacket({
      missionId: 'mis_1',
      packetId: 'pkt_1',
      attemptId: 'att_1',
      leaseId: 'lse_1',
      fence: 1,
      scopeKey: 'repo:a#worktree:default',
      packet: { title: 'T', instructions: 'a\0b', scope: ['repo:a'] },
      mission: { intent: 'I', outcome: 'O', constraints: [] },
      resume: { progressSeq: 0, checkpoint: null },
    });
    let failure: unknown;
    try {
      buildOfficeArgv(packet);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ClassifiedFailure);
    expect((failure as ClassifiedFailure).failureClass).toBe('adapter');
  });
});

describe('a background child does not outlive a normal run', () => {
  it('is stopped with the run, even when the leader exits 0', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'office-normal-'));
    const pidFile = join(dir, 'pid');
    const result = await execProcess({
      argv: ['/bin/sh', '-c', `sleep 30 & echo $! > "${pidFile}"; exit 0`],
      cwd: dir,
      timeoutMs: 60_000,
      signal: new AbortController().signal,
    });
    expect(result.exitCode).toBe(0);
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    await waitUntil(() => !alive(pid));
    expect(alive(pid)).toBe(false);
  });
});
