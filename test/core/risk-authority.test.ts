import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app.js';
import {
  openTestDatabase,
  seedPrincipal,
  TEST_WORKSPACE,
} from '../helpers/tower.js';
import { FakeClock } from './helpers.js';

/** The production wiring: createApp builds the core, and the update route records refusals. */
function server() {
  const db = openTestDatabase();
  const clock = new FakeClock();
  const app = createApp({ db, now: clock.now });
  const owner = seedPrincipal(db, { kind: 'human' });
  const cos = seedPrincipal(db, { kind: 'chief_of_staff' });
  const call = async (
    token: string,
    method: string,
    path: string,
    body?: unknown,
  ) => {
    const res = await app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return {
      status: res.status,
      // biome-ignore lint/suspicious/noExplicitAny: test responses are untyped JSON
      body: (text === '' ? undefined : JSON.parse(text)) as any,
    };
  };
  return { db, call, owner, cos };
}

async function highRiskMission(
  s: ReturnType<typeof server>,
): Promise<{ id: string; version: number }> {
  const created = await s.call(s.owner.token, 'POST', '/missions', {
    title: 'Launch',
    intent: 'Launch the product',
    outcome: 'It is live',
    risk: 'high',
  });
  expect(created.status).toBe(201);
  return {
    id: created.body.mission.id as string,
    version: created.body.mission.version as number,
  };
}

describe('mission risk can only be lowered by a human', () => {
  it('refuses a chief of staff who lowers risk, and records the refusal', async () => {
    const s = server();
    const m = await highRiskMission(s);
    const refused = await s.call(s.cos.token, 'PATCH', `/missions/${m.id}`, {
      expectedVersion: m.version,
      risk: 'low',
    });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('risk_lowering_refused');

    const after = await s.call(s.owner.token, 'GET', `/missions/${m.id}`);
    expect(after.body.mission.risk).toBe('high');

    const receipts = s.db.all<{
      action: string;
      effect: string;
      code: string;
      resource: string;
    }>(
      'SELECT action, effect, code, resource, risk FROM policy_receipts WHERE workspace_id = ?',
      [TEST_WORKSPACE],
    );
    expect(receipts).toEqual([
      {
        action: 'mission.risk.lower',
        effect: 'deny',
        code: 'risk_lowering_refused',
        resource: `mission:${m.id}`,
        // The risk the mission holds, which the refused change would have lowered.
        risk: 'high',
      },
    ]);
  });

  it('lets a chief of staff raise risk', async () => {
    const s = server();
    const created = await s.call(s.owner.token, 'POST', '/missions', {
      title: 'Launch',
      intent: 'Launch the product',
      outcome: 'It is live',
      risk: 'low',
    });
    const id = created.body.mission.id as string;
    const raised = await s.call(s.cos.token, 'PATCH', `/missions/${id}`, {
      expectedVersion: created.body.mission.version,
      risk: 'high',
    });
    expect(raised.status).toBe(200);
    expect(raised.body.mission.risk).toBe('high');
  });

  it('lets a human lower risk', async () => {
    const s = server();
    const m = await highRiskMission(s);
    const lowered = await s.call(s.owner.token, 'PATCH', `/missions/${m.id}`, {
      expectedVersion: m.version,
      risk: 'low',
    });
    expect(lowered.status).toBe(200);
    expect(lowered.body.mission.risk).toBe('low');
  });

  it('leaves no refusal receipt for an allowed change', async () => {
    const s = server();
    const m = await highRiskMission(s);
    await s.call(s.owner.token, 'PATCH', `/missions/${m.id}`, {
      expectedVersion: m.version,
      risk: 'low',
    });
    const count = s.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM policy_receipts WHERE action = 'mission.risk.lower'",
    );
    expect(count?.n).toBe(0);
  });
});
