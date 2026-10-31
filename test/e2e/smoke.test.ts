import { existsSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runScenario } from './scenario.js';

describe('pnpm smoke scenario', () => {
  it('runs end to end in one process, restores from backup, and reads everything back', async () => {
    const lines: string[] = [];
    const report = await runScenario((line) => lines.push(line));
    try {
      expect(lines).toEqual([
        expect.stringMatching(/created mission msn_/),
        'answered the decision through the inbox',
        'two fake runners completed one packet each',
        'reconciled the required issue and completed the mission',
        'restored from backup and read the mission back unchanged',
      ]);
      expect(existsSync(report.backupPath)).toBe(true);
      expect(report.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      rmSync(dirname(report.backupPath), { recursive: true, force: true });
    }
  });

  it('opens no network connection', async () => {
    const real = globalThis.fetch;
    const calls: unknown[] = [];
    globalThis.fetch = ((...args: unknown[]) => {
      calls.push(args);
      throw new Error('smoke must not use the network');
    }) as typeof fetch;
    try {
      const report = await runScenario();
      rmSync(dirname(report.backupPath), { recursive: true, force: true });
    } finally {
      globalThis.fetch = real;
    }
    expect(calls).toEqual([]);
  });
});
