import { describe, expect, it } from 'vitest';
import { ROUTES } from '../../src/api/app.js';
import { SCOPES_BY_KIND } from '../../src/auth/principals.js';
import { issueToken } from '../../src/auth/tokens.js';
import {
  clientFor,
  createFleetHarness,
  DIGEST,
  VERSION,
} from '../fleet/helpers.js';
import { seedPrincipal } from '../helpers/tower.js';

const BIND = { version: VERSION, buildDigest: DIGEST };
const fill = (path: string) => path.replace(/:\w+/g, 'x');
const FLEET = ROUTES.filter((r) => r.path.startsWith('/runners'));

describe('runner routes are declared', () => {
  it('every fleet route is scoped, and registration is not public', () => {
    expect(FLEET.length).toBeGreaterThanOrEqual(16);
    for (const route of FLEET) {
      expect('scopes' in route.access, `${route.method} ${route.path}`).toBe(
        true,
      );
    }
  });

  it('demands a bearer token on every fleet route', async () => {
    const h = createFleetHarness();
    for (const route of FLEET) {
      const res = await h.call(
        undefined,
        route.method.toUpperCase(),
        fill(route.path),
        {},
      );
      expect(res.status, `${route.method} ${route.path}`).toBe(401);
    }
  });
});

describe('runner credentials cannot reach authority routes', () => {
  it('answers 403 on every route needing a scope outside the runner ceiling, even with the whole ceiling', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    const full = issueToken(h.db, {
      principalId: runner.id,
      scopes: SCOPES_BY_KIND.runner,
    });
    const ceiling = new Set<string>(SCOPES_BY_KIND.runner);
    const forbidden = ROUTES.filter(
      (r) =>
        'scopes' in r.access && r.access.scopes.some((s) => !ceiling.has(s)),
    );
    // Policy, decision and any write route are among them.
    const paths = forbidden.map((r) => r.path);
    expect(paths.some((p) => p.startsWith('/policy'))).toBe(true);
    expect(paths.some((p) => p.startsWith('/decisions'))).toBe(true);
    expect(paths).toContain('/missions/:id/transitions');
    expect(paths).toContain('/runners/enrollments');

    for (const token of [runner.token, full.token]) {
      for (const route of forbidden) {
        const res = await h.call(
          token,
          route.method.toUpperCase(),
          fill(route.path),
          {},
        );
        expect(res.status, `${route.method} ${route.path}`).toBe(403);
      }
    }
  });

  it('cannot issue itself a broader token or a policy scope', () => {
    const h = createFleetHarness();
    return h.runner().then((runner) => {
      expect(() =>
        issueToken(h.db, { principalId: runner.id, scopes: ['policy:write'] }),
      ).toThrow(/not allowed/);
      expect(() =>
        issueToken(h.db, {
          principalId: runner.id,
          scopes: ['decision:write'],
        }),
      ).toThrow(/not allowed/);
      expect(() =>
        issueToken(h.db, { principalId: runner.id, scopes: ['provider:sync'] }),
      ).toThrow(/not allowed/);
    });
  });

  it('gives the enrollment token no way to read missions or claim work', async () => {
    const h = createFleetHarness();
    const enrolled = await h.enroll();
    const token = enrolled.body.enrollment.token as string;
    expect((await h.call(token, 'GET', '/missions')).status).toBe(403);
    expect((await h.call(token, 'POST', '/runners/claims', BIND)).status).toBe(
      403,
    );
    expect((await h.call(token, 'GET', '/policy')).status).toBe(403);
  });
});

describe('who may call which fleet route', () => {
  it('keeps operator routes for humans: a runner is refused even though it holds runner:write', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    const other = await h.runner({ name: 'other' });
    const operator: Array<[string, string, unknown]> = [
      ['PATCH', `/runners/${other.id}`, { maxConcurrent: 1 }],
      ['POST', `/runners/${other.id}/quarantine`, {}],
      ['POST', `/runners/${other.id}/unquarantine`, undefined],
      ['POST', '/runners/leases/x/release', {}],
      ['GET', '/runners/leases', undefined],
      ['GET', '/runners/audit', undefined],
    ];
    for (const [method, path, body] of operator) {
      const res = await runner.call(method, path, body);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.body.error.code).toBe('human_required');
    }
    expect(
      (await h.call(h.owner.token, 'GET', `/runners`)).body.runners.find(
        (r: { id: string }) => r.id === other.id,
      ).status,
    ).toBe('active');
  });

  it('refuses a chief of staff every fleet route', async () => {
    const h = createFleetHarness();
    for (const route of FLEET) {
      const res = await h.call(
        h.cos.token,
        route.method.toUpperCase(),
        fill(route.path),
        {},
      );
      expect(res.status, `${route.method} ${route.path}`).toBe(403);
    }
  });

  it('refuses a human the runner-side routes', async () => {
    const h = createFleetHarness();
    const runnerSide: Array<[string, string, unknown]> = [
      ['POST', '/runners/claims', BIND],
      ['POST', '/runners/heartbeat', BIND],
      ['POST', '/runners/leases/x/progress', { fence: 1, seq: 1 }],
      [
        'POST',
        '/runners/leases/x/checkpoints',
        { fence: 1, ref: 'refs/heads/x' },
      ],
      [
        'POST',
        '/runners/leases/x/receipts',
        { receiptId: 'r', fence: 1, outcome: 'succeeded' },
      ],
      [
        'POST',
        '/runners/leases/x/reconcile',
        { ...BIND, fence: 1, progressSeq: 0 },
      ],
    ];
    for (const [method, path, body] of runnerSide) {
      const res = await h.call(h.owner.token, method, path, body);
      expect(res.status, path).toBe(403);
      expect(res.body.error.code).toBe('runner_required');
    }
  });

  it('shows a runner only itself, and never a credential', async () => {
    const h = createFleetHarness();
    const a = await h.runner({ name: 'a' });
    await h.runner({ name: 'b' });
    const own = await a.call('GET', '/runners');
    expect(own.body.runners.map((r: { id: string }) => r.id)).toEqual([a.id]);
    const all = await h.call(h.owner.token, 'GET', '/runners');
    expect(all.body.runners).toHaveLength(2);
    const text = JSON.stringify(all.body);
    expect(text).not.toContain(a.token);
    expect(text).not.toContain('tokenId');
    expect(all.body.runners[0]).toMatchObject({
      boundVersion: VERSION,
      boundDigest: DIGEST,
      status: 'active',
    });
  });
});

describe('workspaces are separate', () => {
  it("never dispatches or shows another workspace's work", async () => {
    const h = createFleetHarness();
    const human = seedPrincipal(h.db, {
      kind: 'human',
      workspaceId: 'ws_other',
    });
    const enrolled = await h.call(human.token, 'POST', '/runners/enrollments', {
      name: 'outsider',
      version: VERSION,
      buildDigest: DIGEST,
      allowedScopes: ['*'],
    });
    const registered = await h.call(
      enrolled.body.enrollment.token,
      'POST',
      '/runners/register',
      { ...BIND, capabilities: [] },
    );
    const outsider = clientFor(
      h.call,
      registered.body.runnerId,
      registered.body.token,
    );

    const mine = await h.runner();
    h.mission([{ scope: ['repo:app'] }]);
    const lease = (await mine.claim()).body.assignments[0];
    expect((await outsider.claim()).body.assignments).toEqual([]);
    expect(
      (await outsider.call('GET', `/runners/leases/${lease.leaseId}`)).status,
    ).toBe(404);
    expect(
      (
        await outsider.progress(lease.leaseId, {
          fence: 1,
          seq: 1,
          message: 'x',
        })
      ).status,
    ).toBe(404);
    expect(
      (await h.call(human.token, 'GET', `/runners/leases/${lease.leaseId}`))
        .status,
    ).toBe(404);
    expect(
      (await h.call(human.token, 'GET', '/runners')).body.runners,
    ).toHaveLength(1);
  });
});

describe('request validation', () => {
  it('rejects unknown fields and malformed input with 400', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    const bad: Array<[string, unknown]> = [
      ['/runners/claims', { ...BIND, extra: 1 }],
      ['/runners/claims', { version: 'v1', buildDigest: DIGEST }],
      ['/runners/claims', { ...BIND, capabilities: ['Bad Cap'] }],
      ['/runners/claims', { ...BIND, active: [{ leaseId: 'x' }] }],
      ['/runners/heartbeat', {}],
      ['/runners/leases/x/progress', { fence: 0, seq: 1 }],
      ['/runners/leases/x/progress', { fence: 1, seq: 1, data: [] }],
      [
        '/runners/leases/x/receipts',
        { receiptId: 'has space', fence: 1, outcome: 'succeeded' },
      ],
      [
        '/runners/leases/x/receipts',
        { receiptId: 'r', fence: 1, outcome: 'verified' },
      ],
    ];
    for (const [path, body] of bad) {
      const res = await runner.call('POST', path, body);
      expect(res.status, `${path} ${JSON.stringify(body)}`).toBe(400);
      expect(res.body.error.code).toBe('validation_failed');
    }
    const big = await runner.call('POST', '/runners/leases/x/receipts', {
      receiptId: 'r',
      fence: 1,
      outcome: 'succeeded',
      evidence: { blob: 'x'.repeat(20_000) },
    });
    expect(big.status).toBe(400);
    expect(
      (await h.call(h.owner.token, 'PATCH', `/runners/${runner.id}`, {}))
        .status,
    ).toBe(400);
    expect(
      (await h.call(h.owner.token, 'GET', '/runners/leases?status=bogus'))
        .status,
    ).toBe(400);
    expect(
      (await h.call(h.owner.token, 'GET', '/runners/audit?limit=0')).status,
    ).toBe(400);
  });

  it('answers 404 for a runner that does not exist', async () => {
    const h = createFleetHarness();
    const res = await h.call(
      h.owner.token,
      'POST',
      '/runners/prn_missing/quarantine',
      {},
    );
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('runner_not_found');
  });
});
