import { describe, expect, it } from 'vitest';
import { backoffMs } from '../../src/fleet/backoff.js';
import { requirementsOf, scopeAllowed } from '../../src/fleet/scope.js';
import {
  compareVersions,
  inSupportedRange,
  isDigest,
  isVersion,
} from '../../src/fleet/version.js';

describe('versions', () => {
  it('accepts only plain major.minor.patch', () => {
    for (const ok of ['1.2.3', '0.0.1', '10.20.30']) {
      expect(isVersion(ok), ok).toBe(true);
    }
    for (const bad of [
      '1.2',
      '1.2.3-beta',
      'v1.2.3',
      '01.2.3',
      '1.2.3.4',
      '',
      ' 1.2.3',
    ]) {
      expect(isVersion(bad), bad).toBe(false);
    }
  });

  it('compares numerically, not as text', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('1.2.3', 'nope')).toBeUndefined();
  });

  it('treats the range as inclusive and fails closed on bad input', () => {
    const range = { min: '1.0.0', max: '1.5.0' };
    expect(inSupportedRange('1.0.0', range)).toBe(true);
    expect(inSupportedRange('1.5.0', range)).toBe(true);
    expect(inSupportedRange('1.5.1', range)).toBe(false);
    expect(inSupportedRange('0.9.9', range)).toBe(false);
    expect(inSupportedRange('garbage', range)).toBe(false);
    expect(inSupportedRange('1.2.0', { min: 'x', max: '2.0.0' })).toBe(false);
  });

  it('requires a lowercase sha256 digest', () => {
    expect(isDigest(`sha256:${'a'.repeat(64)}`)).toBe(true);
    expect(isDigest(`sha256:${'A'.repeat(64)}`)).toBe(false);
    expect(isDigest(`sha256:${'a'.repeat(63)}`)).toBe(false);
    expect(isDigest('a'.repeat(64))).toBe(false);
  });
});

describe('backoff', () => {
  const policy = { baseMs: 1_000, capMs: 30_000 };

  it('doubles from the base and never passes the cap', () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => backoffMs(n, policy))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000,
    ]);
    expect(backoffMs(10_000, policy)).toBe(30_000);
    expect(backoffMs(Number.MAX_SAFE_INTEGER, policy)).toBe(30_000);
  });

  it('is zero before any failure', () => {
    expect(backoffMs(0, policy)).toBe(0);
    expect(backoffMs(-3, policy)).toBe(0);
    expect(backoffMs(Number.NaN, policy)).toBe(0);
  });
});

describe('packet scope conventions', () => {
  const packet = (scope: string[]) => ({ id: 'pkt_1', scope });

  it('keys the execution scope by repo and worktree', () => {
    expect(
      requirementsOf('m', packet(['repo:app', 'worktree:feat'])).scopeKey,
    ).toBe('repo:app#worktree:feat');
    expect(requirementsOf('m', packet(['repo:app'])).scopeKey).toBe(
      'repo:app#worktree:default',
    );
  });

  it('isolates a packet that names no repo', () => {
    expect(requirementsOf('m', packet(['docs'])).scopeKey).toBe(
      'packet:m/pkt_1',
    );
    expect(requirementsOf('m', packet(['docs'])).scopeKey).not.toBe(
      requirementsOf('m2', packet(['docs'])).scopeKey,
    );
  });

  it('separates capabilities from scopes', () => {
    const need = requirementsOf('m', packet(['cap:docker', 'repo:app']));
    expect(need.capabilities).toEqual(['docker']);
    expect(need.scopes).toEqual(['repo:app']);
  });

  it('matches exact, prefix and wildcard allowances', () => {
    expect(scopeAllowed(['repo:app'], 'repo:app')).toBe(true);
    expect(scopeAllowed(['repo:app'], 'repo:app2')).toBe(false);
    expect(scopeAllowed(['repo:*'], 'repo:app')).toBe(true);
    expect(scopeAllowed(['*'], 'anything')).toBe(true);
    expect(scopeAllowed([], 'repo:app')).toBe(false);
  });
});
