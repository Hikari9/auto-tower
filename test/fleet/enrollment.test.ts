import { describe, expect, it } from 'vitest';
import { issueToken } from '../../src/auth/tokens.js';
import {
  auditKinds,
  clientFor,
  createFleetHarness,
  DIGEST,
  OTHER_DIGEST,
  OTHER_VERSION,
  VERSION,
} from './helpers.js';

const BIND = {
  version: VERSION,
  buildDigest: DIGEST,
  capabilities: [] as string[],
};

describe('enrollment is attested', () => {
  it('refuses a runner that was never enrolled', async () => {
    const h = createFleetHarness();
    expect(
      (await h.call(undefined, 'POST', '/runners/claims', BIND)).status,
    ).toBe(401);
    expect(
      (
        await h.call(
          'twr_notarealtoken0000000000000000',
          'POST',
          '/runners/claims',
          BIND,
        )
      ).status,
    ).toBe(401);
    // A human holds runner:write but is not a runner.
    const human = await h.call(h.owner.token, 'POST', '/runners/claims', BIND);
    expect(human.status).toBe(403);
    expect(human.body.error.code).toBe('runner_required');
    // Nor can a human register: only an enrollment token redeems.
    const asHuman = await h.call(
      h.owner.token,
      'POST',
      '/runners/register',
      BIND,
    );
    expect(asHuman.status).toBe(401);
    expect(asHuman.body.error.code).toBe('enrollment_invalid');
  });

  it('only a human may issue an enrollment', async () => {
    const h = createFleetHarness();
    const body = { name: 'r', version: VERSION, buildDigest: DIGEST };
    expect(
      (await h.call(h.cos.token, 'POST', '/runners/enrollments', body)).status,
    ).toBe(403);
    const runner = await h.runner();
    expect(
      (await runner.call('POST', '/runners/enrollments', body)).status,
    ).toBe(403);
    expect(
      (await h.call(undefined, 'POST', '/runners/enrollments', body)).status,
    ).toBe(401);
    expect(
      (await h.call(h.owner.token, 'POST', '/runners/enrollments', body))
        .status,
    ).toBe(201);
  });

  it('pins the version and digest the human chose, inside the supported range', async () => {
    const h = createFleetHarness();
    const out = await h.call(h.owner.token, 'POST', '/runners/enrollments', {
      name: 'r',
      version: '9.0.0',
      buildDigest: DIGEST,
    });
    expect(out.status).toBe(403);
    expect(out.body.error.code).toBe('version_unsupported');
    const bad = await h.call(h.owner.token, 'POST', '/runners/enrollments', {
      name: 'r',
      version: '1.2',
      buildDigest: 'abc',
    });
    expect(bad.status).toBe(400);
  });

  it('stores only a digest and returns the token once', async () => {
    const h = createFleetHarness();
    const enrolled = await h.enroll();
    const token = enrolled.body.enrollment.token as string;
    const stored = JSON.stringify(h.db.all('SELECT * FROM runner_enrollments'));
    expect(stored).not.toContain(token);
    expect(JSON.stringify(h.db.all('SELECT * FROM api_tokens'))).not.toContain(
      token,
    );
  });

  it('lets an enrollment token register once and use up its token', async () => {
    const h = createFleetHarness();
    const enrolled = await h.enroll();
    const token = enrolled.body.enrollment.token as string;
    // It cannot do anything else first: it holds runner:read only.
    expect((await h.call(token, 'POST', '/runners/claims', BIND)).status).toBe(
      403,
    );

    const first = await h.call(token, 'POST', '/runners/register', BIND);
    expect(first.status).toBe(201);
    expect(first.body.bound).toEqual({ version: VERSION, buildDigest: DIGEST });

    const second = await h.call(token, 'POST', '/runners/register', BIND);
    expect(second.status).toBe(401);
    expect(h.db.all('SELECT id FROM runners')).toHaveLength(1);
  });

  it('refuses a registered runner presenting its own credential as an enrollment', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    const again = await runner.call('POST', '/runners/register', BIND);
    expect(again.status).toBe(401);
    expect(again.body.error.code).toBe('enrollment_invalid');
  });

  it('refuses an expired enrollment', async () => {
    const h = createFleetHarness();
    const enrolled = await h.enroll({ expiresInSeconds: 60 });
    h.clock.advance(61_000);
    const res = await h.call(
      enrolled.body.enrollment.token,
      'POST',
      '/runners/register',
      BIND,
    );
    expect(res.status).toBe(401);
    expect(h.db.all('SELECT id FROM runners')).toHaveLength(0);
  });

  it('caps the enrollment lifetime', async () => {
    const h = createFleetHarness();
    const enrolled = await h.enroll({ expiresInSeconds: 86_400 });
    const issued = Date.parse('2026-03-01T00:00:00.000Z');
    expect(
      Date.parse(enrolled.body.enrollment.expiresAt) - issued,
    ).toBeLessThanOrEqual(24 * 60 * 60_000);
  });

  it('rejects any version or digest other than the pinned pair, including another supported version', async () => {
    const h = createFleetHarness();
    const enrolled = await h.enroll();
    const token = enrolled.body.enrollment.token as string;
    for (const wrong of [
      { version: OTHER_VERSION, buildDigest: DIGEST },
      { version: VERSION, buildDigest: OTHER_DIGEST },
      { version: OTHER_VERSION, buildDigest: OTHER_DIGEST },
    ]) {
      const res = await h.call(token, 'POST', '/runners/register', {
        ...wrong,
        capabilities: [],
      });
      expect(res.status, JSON.stringify(wrong)).toBe(403);
      expect(res.body.error.code).toBe('version_mismatch');
    }
    expect(h.db.all('SELECT id FROM runners')).toHaveLength(0);
    // The attempts did not burn the token and are on record.
    expect(
      (await h.call(token, 'POST', '/runners/register', BIND)).status,
    ).toBe(201);
    expect(
      auditKinds(h).filter((k) => k === 'enrollment.rejected'),
    ).toHaveLength(3);
  });

  it('binds the credential to the enrolled version and digest', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    const stored = h.db.get<{ bound_version: string; bound_digest: string }>(
      'SELECT bound_version, bound_digest FROM runners',
    );
    expect(stored).toEqual({ bound_version: VERSION, bound_digest: DIGEST });
    expect(() =>
      h.db.run('UPDATE runners SET bound_version = ?', [OTHER_VERSION]),
    ).toThrow(/bound/);
    expect(() =>
      h.db.run('UPDATE runners SET bound_digest = ?', [OTHER_DIGEST]),
    ).toThrow(/bound/);
    expect((await runner.claim()).status).toBe(200);
  });

  it('keeps a pinned enrollment immutable even through SQL', async () => {
    const h = createFleetHarness();
    const enrolled = await h.enroll();
    expect(() =>
      h.db.run('UPDATE runner_enrollments SET pinned_version = ?', [
        OTHER_VERSION,
      ]),
    ).toThrow(/pinned/);
    await h.call(
      enrolled.body.enrollment.token,
      'POST',
      '/runners/register',
      BIND,
    );
    expect(() =>
      h.db.run(
        'UPDATE runner_enrollments SET used_at = NULL, runner_id = NULL',
      ),
    ).toThrow(/pinned/);
  });
});

describe('every claim re-checks the binding', () => {
  it('rejects a claim that reports another version than the bound one', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    // OTHER_VERSION is inside the supported range, so only the binding can stop it.
    const res = await runner.claim({ version: OTHER_VERSION });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('version_mismatch');
    const digest = await runner.claim({ buildDigest: OTHER_DIGEST });
    expect(digest.status).toBe(403);
    expect(digest.body.error.code).toBe('version_mismatch');
    expect(auditKinds(h).filter((k) => k === 'runner.rejected')).toHaveLength(
      2,
    );
  });

  it('refuses work once the bound version drops out of the supported range', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    const { id } = h.mission([{}]);
    expect((await runner.claim()).body.assignments).toHaveLength(1);

    h.setRange({ min: '1.3.0', max: '1.9.9' });
    const res = await runner.claim();
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('version_unsupported');
    expect((await runner.heartbeat()).status).toBe(403);
    // It is not dispatched anything new either.
    const second = h.mission([{ scope: ['repo:other'] }]);
    h.tick();
    expect(h.getMission(second.id).attempts).toHaveLength(0);
    expect(h.getMission(id).attempts).toHaveLength(1);
  });

  it('refuses another credential issued to the same principal', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    const stray = issueToken(h.db, {
      principalId: runner.id,
      scopes: ['runner:read', 'runner:write'],
    });
    const res = await clientFor(h.call, runner.id, stray.token).claim();
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('credential_not_bound');
  });

  it('has no route that rebinds a runner: an upgrade is a new enrollment', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    for (const field of [
      { version: OTHER_VERSION },
      { buildDigest: OTHER_DIGEST },
      { boundVersion: OTHER_VERSION },
    ]) {
      const res = await h.call(
        h.owner.token,
        'PATCH',
        `/runners/${runner.id}`,
        { maxConcurrent: 1, ...field },
      );
      expect(res.status).toBe(400);
    }
    const upgraded = await h.runner({
      version: OTHER_VERSION,
      name: 'upgraded',
    });
    expect(upgraded.id).not.toBe(runner.id);
    expect((await upgraded.claim()).status).toBe(200);
    expect(
      h.db.all('SELECT bound_version FROM runners ORDER BY created_at'),
    ).toHaveLength(2);
  });

  it('accepts no callback address: runners only ever connect outbound', async () => {
    const h = createFleetHarness();
    const enrolled = await h.enroll();
    const token = enrolled.body.enrollment.token as string;
    for (const field of ['callbackUrl', 'endpoint', 'url', 'host', 'port']) {
      const res = await h.call(token, 'POST', '/runners/register', {
        ...BIND,
        [field]: 'http://10.0.0.5:9000',
      });
      expect(res.status, field).toBe(400);
    }
  });
});
