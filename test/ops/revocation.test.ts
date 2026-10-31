import { describe, expect, it } from 'vitest';
import { runOpsCli } from '../../src/ops/cli.js';
import {
  disablePrincipal,
  RevocationError,
  revocationHistory,
  revokeTokenById,
} from '../../src/ops/index.js';
import { createWorld, WORLD_DIGEST, WORLD_VERSION } from '../e2e/world.js';
import { seedPrincipal, TEST_WORKSPACE } from '../helpers/tower.js';
import { key } from '../mcp/helpers.js';

const RULE = {
  action: 'work.execute',
  resource: 'repo:app',
  scope: 'repo:app',
  maxRisk: 'medium',
  grantee: { kind: 'chief_of_staff' },
};

function cli(args: string[], dbPath: string) {
  const out: string[] = [];
  const err: string[] = [];
  const code = runOpsCli(
    [...args, '--db', dbPath, '--workspace', TEST_WORKSPACE],
    {},
    {
      stdout: (l) => out.push(l),
      stderr: (l) => err.push(l),
    },
  );
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** A runner enrolled and registered over HTTP, as in the field. */
async function enrollRunner(
  world: Awaited<ReturnType<typeof incident>>['world'],
) {
  const enrolled = await world.call(
    world.principals.owner.token,
    'POST',
    '/runners/enrollments',
    {
      name: 'r',
      version: WORLD_VERSION,
      buildDigest: WORLD_DIGEST,
      allowedScopes: ['*'],
      maxConcurrent: 1,
    },
  );
  const registered = await world.call(
    enrolled.body.enrollment.token,
    'POST',
    '/runners/register',
    {
      version: WORLD_VERSION,
      buildDigest: WORLD_DIGEST,
      capabilities: [],
    },
  );
  const token = registered.body.token as string;
  return {
    id: registered.body.runnerId as string,
    token,
    claim: () =>
      world.call(token, 'POST', '/runners/claims', {
        version: WORLD_VERSION,
        buildDigest: WORLD_DIGEST,
      }),
  };
}

/** An authorized packet that a chief of staff approved under a delegated rule, and a runner to run it. */
async function incident() {
  const world = createWorld();
  const second = seedPrincipal(world.db, { kind: 'human', name: 'second' });
  const owner = await world.mcp(world.principals.owner.token);
  const cos = await world.mcp(world.principals.cos.token);
  const { rule } = await owner.ok('grant_policy', {
    ...RULE,
    idempotencyKey: key(),
    confirm: true,
  });
  const created = await owner.ok('create_mission', {
    title: 'Incident drill',
    intent: 'i',
    outcome: 'o',
    risk: 'medium',
    idempotencyKey: key(),
  });
  const missionId = created.mission.id as string;
  let state = world.core.missions.transitionMission(
    world.ownerCtx(),
    missionId,
    created.mission.version,
    'ready',
    null,
  ).mission;
  state = world.core.missions.addPacket(
    world.ownerCtx(),
    missionId,
    state.version,
    {
      title: 'p',
      instructions: 'do',
      scope: ['repo:app'],
      required: true,
      dependsOn: [],
    },
  ).mission;
  const packetId = state.packets[0]?.id ?? '';
  const approved = await cos.ok('request_expansion', {
    missionId,
    packetId,
    action: 'work.execute',
    resource: 'repo:app',
    scope: 'repo:app',
    risk: 'medium',
    question: 'May this run?',
    confirm: true,
    idempotencyKey: key(),
  });
  expect(approved.outcome).toBe('approved');
  return { world, owner, cos, rule, missionId, packetId, second };
}

describe('revocation runbook (docs/policy-revocation.md)', () => {
  it('step 1, halt: stops dispatch at once and keeps every row', async () => {
    const { world, owner, missionId } = await incident();
    const runner = await enrollRunner(world);
    await owner.ok('halt_workspace', {
      reason: 'cos token leaked',
      confirm: true,
      idempotencyKey: key(),
    });
    const before = JSON.stringify(
      world.db.all('SELECT id, status FROM work_packets'),
    );
    const poll = await runner.claim();
    expect(poll.status).toBe(200);
    expect(poll.body.assignments).toEqual([]);
    expect(
      world.core.missions.getMission(TEST_WORKSPACE, missionId)?.attempts,
    ).toEqual([]);
    expect(
      JSON.stringify(world.db.all('SELECT id, status FROM work_packets')),
    ).toBe(before);
    world.close();
  });

  it('step 2, revoke the rule: work approved under it is withheld at the next claim, even after the halt is lifted', async () => {
    const { world, owner, rule } = await incident();
    const runner = await enrollRunner(world);
    await owner.ok('halt_workspace', {
      reason: 'drill',
      confirm: true,
      idempotencyKey: key(),
    });
    await owner.ok('revoke_policy', {
      ruleId: rule.id,
      expectedVersion: rule.version,
      reason: 'leaked',
      confirm: true,
      idempotencyKey: key(),
    });
    await owner.ok('resume_workspace', {
      confirm: true,
      idempotencyKey: key(),
    });
    const poll = await runner.claim();
    expect(poll.status).toBe(200);
    expect(poll.body.assignments).toEqual([]);
    expect(poll.body.withheld).toHaveLength(1);
    expect(poll.body.withheld[0].reason).toMatch(/^authority: /);
    // The runner is told why, without the rule id.
    expect(poll.body.withheld[0].reason).not.toContain(rule.id);
    expect(
      world.db.all(
        "SELECT id FROM runner_leases WHERE status IN ('held','recovering')",
      ),
    ).toEqual([]);
    world.close();
  });

  it('step 3, quarantine the runner: its credential is refused and its work is not handed on', async () => {
    const { world, owner } = await incident();
    const runner = await enrollRunner(world);
    expect((await runner.claim()).status).toBe(200);
    const quarantined = await world.call(
      world.principals.owner.token,
      'POST',
      `/runners/${runner.id}/quarantine`,
      { reason: 'host compromised' },
    );
    expect(quarantined.status).toBe(200);
    const after = await runner.claim();
    expect(after.status).toBe(403);
    expect(after.body.error.code).toBe('runner_quarantined');
    expect(owner).toBeDefined();
    world.close();
  });

  it('step 4, disable the principal and revoke its tokens: the next request is refused, and the action is on record', async () => {
    const { world, cos, second } = await incident();
    expect(
      (await world.call(world.principals.cos.token, 'GET', '/missions')).status,
    ).toBe(200);
    const result = cli(
      [
        'disable-principal',
        '--actor',
        world.principals.owner.id,
        '--principal',
        world.principals.cos.id,
        '--reason',
        'token leaked',
      ],
      world.dbPath,
    );
    expect(result.out).toMatch(/is disabled; \d+ token\(s\) revoked/);
    expect(
      (await world.call(world.principals.cos.token, 'GET', '/missions')).status,
    ).toBe(401);
    // An open MCP session does not outlive its credential.
    expect((await cos.call('briefing', {})).status).toBe(401);
    expect(
      revocationHistory(world.db, TEST_WORKSPACE, { afterSeq: 0, limit: 10 }),
    ).toMatchObject([
      {
        kind: 'principal',
        targetId: world.principals.cos.id,
        actorId: world.principals.owner.id,
        reason: 'token leaked',
      },
    ]);
    expect(second.principalId).toBeDefined();
    world.close();
  });

  it('revokes a single token by id and leaves the principal working on its other credentials', async () => {
    const { world } = await incident();
    const other = seedPrincipal(world.db, {
      kind: 'human',
      name: 'two-tokens',
    });
    const id = world.db.get<{ id: string }>(
      'SELECT id FROM api_tokens WHERE principal_id = ?',
      [other.principalId],
    )?.id as string;
    expect((await world.call(other.token, 'GET', '/missions')).status).toBe(
      200,
    );
    const result = cli(
      ['revoke-token', '--actor', world.principals.owner.id, '--token-id', id],
      world.dbPath,
    );
    expect(result.out).toBe(`Token ${id} is revoked`);
    expect((await world.call(other.token, 'GET', '/missions')).status).toBe(
      401,
    );
    expect(
      cli(
        [
          'revoke-token',
          '--actor',
          world.principals.owner.id,
          '--token-id',
          id,
        ],
        world.dbPath,
      ).out,
    ).toMatch(/already revoked/);
    expect(
      cli(
        [
          'revoke-token',
          '--actor',
          world.principals.owner.id,
          '--token-id',
          'tok_nope',
        ],
        world.dbPath,
      ).err,
    ).toMatch(/No token/);
    world.close();
  });

  it('does not accept a disabled person as the actor, for halt, resume or revocation', async () => {
    const { world, second } = await incident();
    const old = world.principals.owner.id;
    // The second person disables the first. The first can no longer act through the CLI either.
    const done = cli(
      ['disable-principal', '--actor', second.principalId, '--principal', old],
      world.dbPath,
    );
    expect(done.code).toBe(0);
    for (const args of [
      ['halt', '--actor', old],
      ['resume', '--actor', old],
      ['revoke-token', '--actor', old, '--token-id', 'x'],
      ['disable-principal', '--actor', old, '--principal', second.principalId],
    ]) {
      const result = cli(args, world.dbPath);
      expect(result.code, args.join(' ')).toBe(1);
      expect(result.err).toMatch(/No enabled principal/);
    }
    expect(world.db.all('SELECT 1 FROM ops_halt')).toEqual([]);
    world.close();
  });

  it('refuses to disable the last enabled person, so someone can always resume', async () => {
    const world = createWorld();
    expect(() =>
      disablePrincipal(world.db, {
        workspaceId: TEST_WORKSPACE,
        principalId: world.principals.owner.id,
        actor: world.principals.owner.actor,
      }),
    ).toThrow(RevocationError);
    expect(
      (await world.call(world.principals.owner.token, 'GET', '/missions'))
        .status,
    ).toBe(200);
    seedPrincipal(world.db, { kind: 'human', name: 'backup' });
    expect(
      disablePrincipal(world.db, {
        workspaceId: TEST_WORKSPACE,
        principalId: world.principals.owner.id,
        actor: world.principals.owner.actor,
      }).tokensRevoked,
    ).toBe(1);
    world.close();
  });

  it('is for a person only, and its history cannot be edited', async () => {
    const world = createWorld();
    expect(() =>
      revokeTokenById(world.db, {
        workspaceId: TEST_WORKSPACE,
        tokenId: 'x',
        actor: world.principals.cos.actor,
      }),
    ).toThrow(/Only a person/);
    revokeTokenById(world.db, {
      workspaceId: TEST_WORKSPACE,
      tokenId: world.db.get<{ id: string }>('SELECT id FROM api_tokens')
        ?.id as string,
      actor: world.principals.owner.actor,
    });
    expect(() =>
      world.db.run('UPDATE ops_revocations SET reason = NULL'),
    ).toThrow(/append-only/);
    expect(() => world.db.run('DELETE FROM ops_revocations')).toThrow(
      /append-only/,
    );
    world.close();
  });

  it('step 5, resume: dispatch runs again under the policy as it stands, and revocations hold', async () => {
    const { world, owner, rule } = await incident();
    const runner = await enrollRunner(world);
    await owner.ok('halt_workspace', { confirm: true, idempotencyKey: key() });
    await owner.ok('revoke_policy', {
      ruleId: rule.id,
      expectedVersion: rule.version,
      confirm: true,
      idempotencyKey: key(),
    });
    await owner.ok('resume_workspace', {
      confirm: true,
      idempotencyKey: key(),
    });
    expect((await owner.ok('read_health', {})).health.status).toBe('ok');
    const active = await owner.ok('read_policy', {});
    expect(active.rules.map((r: { id: string }) => r.id)).not.toContain(
      rule.id,
    );
    // A fresh grant is needed, and a person makes it. Nothing came back by itself.
    expect((await runner.claim()).body.assignments).toEqual([]);
    world.close();
  });
});
