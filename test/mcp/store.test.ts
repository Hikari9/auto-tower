import { describe, expect, it } from 'vitest';
import { McpToolError } from '../../src/mcp/errors.js';
import {
  findSession,
  IDEMPOTENCY_RETENTION_MS,
  MAX_OPEN_SESSIONS,
  openSession,
  replayFor,
  requestHash,
  storeResult,
} from '../../src/mcp/store.js';
import { openTestDatabase, seedPrincipal } from '../helpers/tower.js';

describe('idempotency store', () => {
  it('binds a stored result to the tool as well as the arguments', () => {
    const db = openTestDatabase();
    const { principalId } = seedPrincipal(db, { kind: 'human' });
    const owner = { workspaceId: 'ws_test', principalId };
    const args = { missionId: 'msn_1', expectedVersion: 2 };
    const hash = requestHash('close_mission', args);
    storeResult(
      db,
      owner,
      'k1',
      'close_mission',
      hash,
      { ok: true },
      new Date(),
    );

    expect(replayFor(db, owner, 'k1', 'close_mission', hash)).toEqual({
      ok: true,
    });
    // Same arguments and hash, another tool: refused, the first result is not replayed.
    expect(() => replayFor(db, owner, 'k1', 'update_mission', hash)).toThrow(
      McpToolError,
    );
    expect(requestHash('update_mission', args)).not.toBe(hash);
    expect(() =>
      replayFor(
        db,
        owner,
        'k1',
        'update_mission',
        requestHash('update_mission', args),
      ),
    ).toThrow(/different call/);
  });

  it('hashes the same arguments the same however the keys are ordered', () => {
    expect(requestHash('t', { a: 1, b: { c: 2, d: [1, 2] } })).toBe(
      requestHash('t', { b: { d: [1, 2], c: 2 }, a: 1 }),
    );
    expect(requestHash('t', { a: 1 })).not.toBe(requestHash('t', { a: '1' }));
    expect(requestHash('t', { a: undefined })).toBe(requestHash('t', {}));
  });
});

describe('growth limits', () => {
  it('closes the least recently used session beyond the cap, for that principal only', () => {
    const db = openTestDatabase();
    const a = seedPrincipal(db, { kind: 'human' });
    const b = seedPrincipal(db, { kind: 'human' });
    const base = new Date('2026-01-01T00:00:00Z').getTime();
    const open = (principalId: string, i: number) =>
      openSession(db, {
        workspaceId: 'ws_test',
        principalId,
        protocolVersion: '2025-06-18',
        clientName: null,
        now: new Date(base + i * 1000),
      });
    const own = { workspaceId: 'ws_test', principalId: a.principalId };
    const first = open(a.principalId, 0);
    const theirs = open(b.principalId, 0);
    const rest = Array.from({ length: MAX_OPEN_SESSIONS }, (_, i) =>
      open(a.principalId, i + 1),
    );
    const at = new Date(base + 100_000);
    expect(findSession(db, first.id, own, at)).toBeUndefined();
    expect(findSession(db, rest[0]?.id ?? '', own, at)).toBeDefined();
    expect(
      findSession(db, rest[MAX_OPEN_SESSIONS - 1]?.id ?? '', own, at),
    ).toBeDefined();
    expect(
      findSession(
        db,
        theirs.id,
        { workspaceId: 'ws_test', principalId: b.principalId },
        at,
      ),
    ).toBeDefined();
  });

  it('forgets stored results older than the retention window', () => {
    const db = openTestDatabase();
    const { principalId } = seedPrincipal(db, { kind: 'human' });
    const owner = { workspaceId: 'ws_test', principalId };
    const old = new Date('2026-01-01T00:00:00Z');
    storeResult(db, owner, 'old', 't', 'h', { n: 1 }, old);
    expect(replayFor(db, owner, 'old', 't', 'h')).toEqual({ n: 1 });
    storeResult(
      db,
      owner,
      'new',
      't',
      'h',
      { n: 2 },
      new Date(old.getTime() + IDEMPOTENCY_RETENTION_MS + 1000),
    );
    expect(replayFor(db, owner, 'old', 't', 'h')).toBeUndefined();
    expect(replayFor(db, owner, 'new', 't', 'h')).toEqual({ n: 2 });
  });
});
