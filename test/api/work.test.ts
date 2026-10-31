import { describe, expect, it } from 'vitest';
import {
  type Api,
  createApi,
  grant,
  missionWith,
  packetStatus,
} from '../policy/helpers.js';

function pending(api: Api, scope = ['env:staging']) {
  const m = missionWith(api.h, [{ title: 'one', scope }]);
  return { ...m, packetId: m.ids[0] as string };
}

function authorize(
  api: Api,
  token: string,
  m: { driver: { id: string; state: { version: number } }; packetId: string },
  policyRefs: string[],
) {
  return api.call(
    token,
    'POST',
    `/missions/${m.driver.id}/work-packets/${m.packetId}/authorize`,
    { expectedVersion: m.driver.state.version, policyRefs },
  );
}

describe('POST /missions/:id/work-packets/:packetId/authorize as a chief of staff', () => {
  it('refuses a fabricated policy ref and leaves the packet unauthorized', async () => {
    const api = createApi();
    const m = pending(api);
    grant(api.h);
    const res = await authorize(api, api.cos.token, m, [
      'policy:v1:rule:rul_fabricated@1',
    ]);
    expect([403, 409]).toContain(res.status);
    expect(res.body.error.message).toMatch(/does not name a current rule/);
    expect(packetStatus(m.driver, m.packetId).authorized).toBe(false);
  });

  it.each([
    ['a bare label', ['policy:1']],
    ['only a decision link', ['decision:dec_1@1']],
    ['no ref at all', []],
  ])('refuses %s', async (_name, refs) => {
    const api = createApi();
    const m = pending(api);
    grant(api.h);
    const res = await authorize(api, api.cos.token, m, refs);
    expect([403, 409]).toContain(res.status);
    expect(packetStatus(m.driver, m.packetId).authorized).toBe(false);
  });

  it('authorizes under a current rule that covers the packet, and records the ref', async () => {
    const api = createApi();
    const m = pending(api);
    const rule = grant(api.h);
    const ref = `policy:v1:rule:${rule.id}@1`;
    const res = await authorize(api, api.cos.token, m, [ref]);
    expect(res.status).toBe(200);
    expect(res.body.mission.packets[0].authorization).toMatchObject({
      by: api.cos.principalId,
      policyRefs: [ref],
    });
  });

  it('refuses a rule that was revoked after the ref was issued', async () => {
    const api = createApi();
    const m = pending(api);
    const rule = grant(api.h);
    const revoked = await api.call(
      api.owner.token,
      'POST',
      `/policy/rules/${rule.id}/revoke`,
      { expectedVersion: 1, reason: 'stop' },
    );
    expect(revoked.status).toBe(200);
    const res = await authorize(api, api.cos.token, m, [
      `policy:v1:rule:${rule.id}@1`,
    ]);
    expect([403, 409]).toContain(res.status);
    expect(packetStatus(m.driver, m.packetId).authorized).toBe(false);
  });

  it('refuses a rule that does not cover the packet scope', async () => {
    const api = createApi();
    const m = pending(api, ['env:production']);
    const rule = grant(api.h);
    const res = await authorize(api, api.cos.token, m, [
      `policy:v1:rule:${rule.id}@1`,
    ]);
    expect([403, 409]).toContain(res.status);
    expect(packetStatus(m.driver, m.packetId).authorized).toBe(false);
  });

  it('still lets a person authorize without citing anything', async () => {
    const api = createApi();
    const m = pending(api);
    const res = await authorize(api, api.owner.token, m, []);
    expect(res.status).toBe(200);
    expect(packetStatus(m.driver, m.packetId).authorized).toBe(true);
  });
});
