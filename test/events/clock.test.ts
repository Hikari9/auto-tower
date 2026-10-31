import { describe, expect, it } from 'vitest';
import { createEventLog } from '../../src/events/event-log.js';
import { openTestDatabase, seedPrincipal } from '../helpers/tower.js';

describe('event log time', () => {
  it('stamps events and idempotency keys with the injected clock', () => {
    const db = openTestDatabase();
    const { principalId } = seedPrincipal(db, { kind: 'human' });
    const at = new Date('2031-05-06T07:08:09.000Z');
    const log = createEventLog(db, () => at);
    const { event } = log.append({
      workspaceId: 'ws_test',
      streamId: 's1',
      expectedVersion: 0,
      type: 't',
      payload: {},
      actorId: principalId,
      correlationId: 'c1',
      idempotencyKey: 'k1',
    });
    expect(event.recordedAt).toBe(at.toISOString());
    expect(
      db.get<{ created_at: string }>('SELECT created_at FROM idempotency_keys'),
    ).toEqual({ created_at: at.toISOString() });
  });

  it('keeps the system clock when none is given', () => {
    const db = openTestDatabase();
    const { principalId } = seedPrincipal(db, { kind: 'human' });
    const before = Date.now();
    const { event } = createEventLog(db).append({
      workspaceId: 'ws_test',
      streamId: 's1',
      expectedVersion: 0,
      type: 't',
      payload: {},
      actorId: principalId,
      correlationId: 'c1',
    });
    expect(Date.parse(event.recordedAt)).toBeGreaterThanOrEqual(before);
  });
});
