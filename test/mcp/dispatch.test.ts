import { describe, expect, it } from 'vitest';
import { key } from './helpers.js';
import { createMcpEnv, MISSION } from './setup.js';

async function post(
  env: ReturnType<typeof createMcpEnv>,
  token: string,
  path: string,
  body: unknown,
) {
  const res = await env.http(token, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    body: (await res.json()) as {
      mission: { version: number; packets: Array<{ id: string }> };
    },
  };
}

/** A ready mission with one packet in scope src/app, made through the HTTP API. */
async function readyMission(env: ReturnType<typeof createMcpEnv>) {
  const s = await env.session(env.owner);
  const created = await s.ok('create_mission', {
    ...MISSION,
    idempotencyKey: key(),
  });
  const id = created.mission.id as string;
  const added = await post(env, env.owner, `/missions/${id}/work-packets`, {
    expectedVersion: 1,
    title: 'Build it',
    instructions: 'do',
    scope: ['src/app'],
  });
  expect(added.status).toBe(201);
  const ready = await post(env, env.owner, `/missions/${id}/transitions`, {
    expectedVersion: added.body.mission.version,
    to: 'ready',
  });
  return {
    s,
    id,
    packetId: added.body.mission.packets[0]?.id as string,
    version: ready.body.mission.version,
  };
}

describe('dispatch', () => {
  it('previews without changing anything, then dispatches on confirm and reports waiting-runner', async () => {
    const env = createMcpEnv();
    const { s, id, packetId, version } = await readyMission(env);
    const preview = await s.ok('preview_dispatch', { missionId: id });
    expect(preview.packets[0]).toMatchObject({
      id: packetId,
      authorized: false,
      next: 'needs-authorization',
    });
    expect(
      (await s.ok('read_mission', { missionId: id })).mission.version,
    ).toBe(version);

    const k = key('dispatch');
    const args = {
      missionId: id,
      packetId,
      expectedVersion: version,
      idempotencyKey: k,
    };
    expect((await s.call('request_dispatch', args)).data.error.code).toBe(
      'confirmation_required',
    );
    expect(
      (await s.ok('read_mission', { missionId: id })).mission.packets[0]
        .authorization,
    ).toBeNull();

    const sent = await s.ok('request_dispatch', { ...args, confirm: true });
    expect(sent.mission.packets[0].authorization.by).toBe(env.principals.owner);
    // No runner is online, so the mission waits and never claims execution.
    expect(sent.mission.state).toBe('waiting-runner');
    expect(sent.mission.attempts).toEqual([]);

    const replay = await s.call('request_dispatch', { ...args, confirm: true });
    expect(replay.meta?.['tower/replayed']).toBe(true);
    expect(replay.data.mission.id).toBe(id);

    const after = await s.ok('preview_dispatch', { missionId: id });
    expect(after.packets[0].next).toBe('will-be-offered-to-a-runner');
    expect((await s.ok('list_runs', { missionId: id })).runs).toEqual([]);
    expect((await s.ok('list_runners')).runners).toEqual([]);
  });

  it('makes a chief of staff cite a policy that covers the packet', async () => {
    const env = createMcpEnv();
    const { id, packetId, version } = await readyMission(env);
    const owner = await env.session(env.owner);
    const cos = await env.session(env.cos);
    const refusal = await cos.call('request_dispatch', {
      missionId: id,
      packetId,
      expectedVersion: version,
      idempotencyKey: key(),
      confirm: true,
    });
    expect(refusal.isError).toBe(true);
    expect(
      (await owner.ok('read_mission', { missionId: id })).mission.packets[0]
        .authorization,
    ).toBeNull();

    const grant = await owner.ok('grant_policy', {
      action: 'work.execute',
      resource: 'repo:app',
      scope: 'src/*',
      maxRisk: 'medium',
      grantee: { kind: 'chief_of_staff' },
      idempotencyKey: key(),
      confirm: true,
    });
    const ref = `policy:v${grant.policyVersion}:rule:${grant.rule.id}@${grant.rule.version}`;
    const wrong = await cos.ok('preview_dispatch', {
      missionId: id,
      packetId,
      policyRefs: ['policy:v1:rule:nope@1'],
    });
    expect(wrong.packets[0].citedPolicy.accepted).toBe(false);
    const right = await cos.ok('preview_dispatch', {
      missionId: id,
      packetId,
      policyRefs: [ref],
    });
    expect(right.packets[0].citedPolicy).toEqual({ accepted: true });

    const sent = await cos.ok('request_dispatch', {
      missionId: id,
      packetId,
      expectedVersion: version,
      policyRefs: [ref],
      idempotencyKey: key(),
      confirm: true,
    });
    expect(sent.mission.packets[0].authorization.policyRefs).toEqual([ref]);
  });

  it('refuses a stale version and an unknown packet', async () => {
    const env = createMcpEnv();
    const { s, id, packetId, version } = await readyMission(env);
    const stale = await s.call('request_dispatch', {
      missionId: id,
      packetId,
      expectedVersion: version - 1,
      idempotencyKey: key(),
      confirm: true,
    });
    expect(stale.data.error.code).toBe('version_conflict');
    const missing = await s.call('preview_dispatch', {
      missionId: id,
      packetId: 'pkt_nope',
    });
    expect(missing.data.error.code).toBe('packet_not_found');
  });
});

describe('reading', () => {
  it('summarizes missions, blockers and open decisions in the briefing, and hides decisions from a caller who may not read them', async () => {
    const env = createMcpEnv();
    const { s, id, packetId, version } = await readyMission(env);
    await s.ok('request_dispatch', {
      missionId: id,
      packetId,
      expectedVersion: version,
      idempotencyKey: key(),
      confirm: true,
    });
    const cos = await env.session(env.cos);
    await cos.ok('propose_policy_change', {
      missionId: id,
      action: 'deploy.staging',
      resource: 'repo:app',
      scope: 'env:staging',
      maxRisk: 'low',
      rationale: 'because',
      idempotencyKey: key(),
    });
    const brief = await s.ok('briefing');
    expect(brief.missions.byState['waiting-runner']).toBe(1);
    expect(brief.blockers[0]).toMatchObject({
      missionId: id,
      state: 'waiting-runner',
    });
    expect(brief.decisions.open).toHaveLength(1);
    expect(brief.decisions.open[0]).toMatchObject({
      requiredAuthority: 'human',
      blockedBranches: 1,
    });

    const noDecisions = env.seed('human', ['mission:read']);
    const limited = await env.session(noDecisions.token);
    const narrow = await limited.ok('briefing');
    expect(narrow.missions.byState['waiting-runner']).toBe(1);
    expect('decisions' in narrow).toBe(false);
  });

  it('labels runner claims as self-reported and shows receipt facts without free text', async () => {
    const env = createMcpEnv();
    const { s, id } = await readyMission(env);
    const evidence = await s.ok('inspect_evidence', { missionId: id });
    expect(evidence).toMatchObject({
      missionId: id,
      runnerClaims: [],
      officeReceipts: [],
      outcomeVerification: null,
    });
    expect(
      (
        await s.call('inspect_evidence', {
          missionId: id,
          packetId: 'pkt_nope',
        })
      ).data.error.code,
    ).toBe('packet_not_found');
    expect(
      (await s.call('inspect_evidence', { missionId: 'msn_nope' })).data.error
        .code,
    ).toBe('mission_not_found');
  });

  it('refuses malformed arguments rather than guessing', async () => {
    const env = createMcpEnv();
    const s = await env.session(env.owner);
    for (const [name, args] of [
      ['search_missions', { state: ['nope'] }],
      ['search_missions', { limit: 1000 }],
      ['search_missions', { q: { a: 1 } }],
      ['list_decisions', { status: 'weird' }],
      ['list_runs', { status: 'weird' }],
      ['recent_activity', { after: 3 }],
      ['recent_activity', { limit: 0 }],
      ['read_mission', {}],
      ['read_mission', { missionId: 5 }],
    ] as const) {
      const reply = await s.call(name, args);
      expect(reply.data.error.code, `${name} ${JSON.stringify(args)}`).toBe(
        'validation_failed',
      );
    }
  });
});
