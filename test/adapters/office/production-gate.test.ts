import { describe, expect, it } from 'vitest';
import { officeRunnerEngine } from '../../../src/adapters/office/engine.js';
import { createApp } from '../../../src/api/app.js';
import { TowerRunner } from '../../../src/runner/runner.js';
import { createMemoryStateStore } from '../../../src/runner/state.js';
import type { Transport } from '../../../src/runner/transport.js';
import { FakeClock } from '../../core/helpers.js';
import { DIGEST, VERSION } from '../../fleet/helpers.js';
import {
  openTestDatabase,
  seedPrincipal,
  TEST_WORKSPACE,
} from '../../helpers/tower.js';
import { FakeOfficeEngine, FakeWorld } from './fake-engine.js';

/**
 * The production wiring, with no core or fleet injected: createApp builds both, and the high-risk
 * gate and receipt ingestion are the ones it registers. Every step goes through a route, and the
 * runner talks to the app over HTTP.
 */
function server() {
  const db = openTestDatabase();
  const clock = new FakeClock();
  const app = createApp({ db, now: clock.now });
  const owner = seedPrincipal(db, { kind: 'human' });
  const cos = seedPrincipal(db, { kind: 'chief_of_staff' });
  const call = async (
    token: string | undefined,
    method: string,
    path: string,
    body?: unknown,
  ) => {
    const res = await app.request(path, {
      method,
      headers: {
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
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
  return { db, clock, call, owner, cos };
}

describe('the high-risk gate in production wiring', () => {
  it('refuses a high-risk mission without an independent review, and completes it with one', async () => {
    const s = server();
    const { call, owner, cos } = s;

    // One runner, enrolled and registered through the routes.
    const enrolled = await call(owner.token, 'POST', '/runners/enrollments', {
      name: 'runner',
      version: VERSION,
      buildDigest: DIGEST,
      allowedScopes: ['*'],
      maxConcurrent: 1,
    });
    expect(enrolled.status).toBe(201);
    let reviewer: string | undefined;
    const world = new FakeWorld();
    const engine = officeRunnerEngine({
      run: (packet, hooks) =>
        new FakeOfficeEngine(world, {
          steps: 1,
          ...(reviewer === undefined ? {} : { reviewer }),
        }).run(packet, hooks),
    });
    const transport: Transport = async ({ method, path, body, token }) =>
      call(token, method, path, body);
    const runner = new TowerRunner({
      transport,
      engine,
      store: createMemoryStateStore(),
      binding: { version: VERSION, buildDigest: DIGEST },
    });
    await runner.register(enrolled.body.enrollment.token);

    async function completeMission(
      reviewerName: string | undefined,
      // biome-ignore lint/suspicious/noExplicitAny: test responses are untyped JSON
    ): Promise<{ status: number; body: any }> {
      reviewer = reviewerName;
      const created = await call(owner.token, 'POST', '/missions', {
        title: 'Launch',
        intent: 'Launch the product',
        outcome: 'It is live',
        risk: 'high',
      });
      expect(created.status).toBe(201);
      const id = created.body.mission.id as string;
      await call(owner.token, 'POST', `/missions/${id}/transitions`, {
        expectedVersion: 1,
        to: 'ready',
      });
      const added = await call(
        owner.token,
        'POST',
        `/missions/${id}/work-packets`,
        {
          expectedVersion: 2,
          title: 'Build',
          instructions: 'do it',
          scope: ['repo:a'],
        },
      );
      const packetId = added.body.mission.packets[0].id as string;
      const authorized = await call(
        owner.token,
        'POST',
        `/missions/${id}/work-packets/${packetId}/authorize`,
        {
          expectedVersion: 3,
          policyRefs: [],
        },
      );
      expect(authorized.status).toBe(200);

      await runner.pollOnce();
      await runner.drain();

      let version = (await call(owner.token, 'GET', `/missions/${id}`)).body
        .mission.version as number;
      const verified = await call(
        cos.token,
        'POST',
        `/missions/${id}/work-packets/${packetId}/verify`,
        {
          expectedVersion: version,
          evidenceRefs: ['ci:run/1'],
        },
      );
      expect(verified.status).toBe(200);
      version += 1;
      const verifying = await call(
        owner.token,
        'POST',
        `/missions/${id}/transitions`,
        {
          expectedVersion: version,
          to: 'verifying',
        },
      );
      expect(verifying.status).toBe(200);
      version += 1;
      const outcome = await call(
        cos.token,
        'POST',
        `/missions/${id}/outcome-verification`,
        {
          expectedVersion: version,
          evidenceRefs: ['ci:run/2'],
        },
      );
      expect(outcome.status).toBe(200);
      version += 1;
      return call(owner.token, 'POST', `/missions/${id}/transitions`, {
        expectedVersion: version,
        to: 'completed',
      });
    }

    const refused = await completeMission(undefined);
    expect(refused.status).toBe(409);
    const guards = (
      refused.body.error.details.failures as Array<{ guard: string }>
    ).map((f) => f.guard);
    expect(guards).toContain('office-high-risk-review');

    const done = await completeMission('reviewer-session');
    expect(done.status).toBe(200);
    expect(done.body.mission.state).toBe('completed');

    const rows = s.db.all<{ independent_review: string }>(
      'SELECT independent_review FROM office_receipts WHERE workspace_id = ? ORDER BY rowid',
      [TEST_WORKSPACE],
    );
    expect(rows.map((r) => r.independent_review)).toEqual([
      'missing',
      'satisfied',
    ]);
  });

  it('does not accept the runner itself as the reviewer', async () => {
    const s = server();
    const enrolled = await s.call(
      s.owner.token,
      'POST',
      '/runners/enrollments',
      {
        name: 'runner',
        version: VERSION,
        buildDigest: DIGEST,
        allowedScopes: ['*'],
        maxConcurrent: 1,
      },
    );
    let reviewer: string | undefined;
    const world = new FakeWorld();
    const engine = officeRunnerEngine({
      run: (packet, hooks) =>
        new FakeOfficeEngine(world, {
          steps: 1,
          ...(reviewer === undefined ? {} : { reviewer }),
        }).run(packet, hooks),
    });
    const runner = new TowerRunner({
      transport: async ({ method, path, body, token }) =>
        s.call(token, method, path, body),
      engine,
      store: createMemoryStateStore(),
      binding: { version: VERSION, buildDigest: DIGEST },
    });
    await runner.register(enrolled.body.enrollment.token);
    // The runner names its own principal as the reviewer. That is not independent review.
    reviewer = runner.runnerId;
    const created = await s.call(s.owner.token, 'POST', '/missions', {
      title: 'Self review',
      intent: 'Check the gate',
      outcome: 'Refused',
      risk: 'high',
    });
    const id = created.body.mission.id as string;
    await s.call(s.owner.token, 'POST', `/missions/${id}/transitions`, {
      expectedVersion: 1,
      to: 'ready',
    });
    const added = await s.call(
      s.owner.token,
      'POST',
      `/missions/${id}/work-packets`,
      {
        expectedVersion: 2,
        title: 'Build',
        instructions: 'do it',
        scope: ['repo:b'],
      },
    );
    const packetId = added.body.mission.packets[0].id as string;
    await s.call(
      s.owner.token,
      'POST',
      `/missions/${id}/work-packets/${packetId}/authorize`,
      {
        expectedVersion: 3,
        policyRefs: [],
      },
    );
    await runner.pollOnce();
    await runner.drain();
    const rows = s.db.all<{ independent_review: string }>(
      'SELECT independent_review FROM office_receipts WHERE workspace_id = ? ORDER BY rowid',
      [TEST_WORKSPACE],
    );
    expect(rows.map((r) => r.independent_review)).toEqual(['self-reviewed']);
  });
});
