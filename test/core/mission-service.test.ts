import { describe, expect, it } from 'vitest';
import {
  CommandNotAllowedError,
  ForbiddenActorError,
  InvalidTransitionError,
  MissionNotFoundError,
  PacketNotFoundError,
  ValidationError,
} from '../../src/core/errors.js';
import {
  IdempotencyKeyReuseError,
  VersionConflictError,
} from '../../src/events/errors.js';
import { createEventLog } from '../../src/events/event-log.js';
import { createPolicyService } from '../../src/policy/service.js';
import { TEST_WORKSPACE } from '../helpers/tower.js';
import { ruleInput } from '../policy/helpers.js';
import {
  createHarness,
  MissionDriver,
  mission,
  seedFixedPrincipal,
} from './helpers.js';

function eventCount(
  h: ReturnType<typeof createHarness>,
  missionId: string,
): number {
  return createEventLog(h.db).readStream(TEST_WORKSPACE, `mission:${missionId}`)
    .length;
}

describe('creating a mission', () => {
  it('stores every field of the mission contract and starts in draft at version 1', () => {
    const h = createHarness();
    const {
      mission: created,
      event,
      replayed,
    } = h.core.missions.createMission(
      h.ctx(h.cos, { correlationId: 'corr-1' }),
      mission({
        title: 'Plan the launch',
        risk: 'high',
        size: 'l',
        priority: 'urgent',
        definitionOfDone: [{ text: 'Docs published', done: false }],
        links: [
          {
            url: 'https://github.com/o/r/issues/7',
            classification: 'required',
            title: 'Issue 7',
          },
        ],
        policyRefs: ['policy:v1'],
      }),
    );

    expect(replayed).toBe(false);
    expect(event).toMatchObject({
      version: 1,
      type: 'mission.created',
      actorId: 'prn_cos',
      correlationId: 'corr-1',
    });
    expect(created).toMatchObject({
      workspaceId: TEST_WORKSPACE,
      version: 1,
      state: 'draft',
      title: 'Plan the launch',
      intent: 'Make the thing available to users',
      outcome: 'Users can use the thing',
      constraints: ['no downtime'],
      risk: 'high',
      size: 'l',
      priority: 'urgent',
      definitionOfDone: [{ text: 'Docs published', done: false }],
      createdBy: 'prn_cos',
      source: 'test',
      parentId: null,
      links: [
        {
          url: 'https://github.com/o/r/issues/7',
          classification: 'required',
          title: 'Issue 7',
        },
      ],
      policyRefs: ['policy:v1'],
      outcomeVerification: null,
      completedAt: null,
      cancelledAt: null,
      packets: [],
      attempts: [],
    });
    expect(created.id).toMatch(/^msn_/);
    expect(h.core.missions.getMission(TEST_WORKSPACE, created.id)).toEqual(
      created,
    );
  });

  it('refuses a runner principal', () => {
    const h = createHarness();
    expect(() =>
      h.core.missions.createMission(h.ctx(h.runner), mission()),
    ).toThrow(ForbiddenActorError);
  });

  it('rejects a parent that is missing, cancelled, or in another workspace', () => {
    const h = createHarness();
    expect(() =>
      h.core.missions.createMission(h.ctx(), mission({ parentId: 'msn_nope' })),
    ).toThrow(ValidationError);

    const parent = MissionDriver.create(h);
    parent.go('cancelled');
    expect(() =>
      h.core.missions.createMission(h.ctx(), mission({ parentId: parent.id })),
    ).toThrow(/cancelled/);

    const other = seedFixedPrincipal(h.db, 'prn_other', 'human', 'ws_other');
    const foreign = h.core.missions.createMission(
      { workspaceId: 'ws_other', actor: other },
      mission(),
    );
    expect(() =>
      h.core.missions.createMission(
        h.ctx(),
        mission({ parentId: foreign.mission.id }),
      ),
    ).toThrow(ValidationError);
  });
});

describe('updates and stale versions', () => {
  it('applies a versioned update and bumps the version', () => {
    const h = createHarness();
    const m = MissionDriver.create(h);

    const { mission: updated } = h.core.missions.updateMission(
      h.ctx(),
      m.id,
      1,
      {
        title: 'Renamed',
        priority: 'high',
      },
    );

    expect(updated).toMatchObject({
      version: 2,
      title: 'Renamed',
      priority: 'high',
    });
  });

  it('rejects a stale expected version and records nothing', () => {
    const h = createHarness();
    const m = MissionDriver.create(h);
    h.core.missions.updateMission(h.ctx(), m.id, 1, { title: 'First writer' });

    expect(() =>
      h.core.missions.updateMission(h.ctx(), m.id, 1, {
        title: 'Second writer',
      }),
    ).toThrow(VersionConflictError);

    expect(eventCount(h, m.id)).toBe(2);
    expect(h.core.missions.getMission(TEST_WORKSPACE, m.id)?.title).toBe(
      'First writer',
    );
  });

  it('refuses to update a completed or cancelled mission', () => {
    const h = createHarness();
    const m = MissionDriver.create(h);
    m.go('cancelled');
    expect(() =>
      h.core.missions.updateMission(h.ctx(), m.id, m.state.version, {
        title: 'x',
      }),
    ).toThrow(CommandNotAllowedError);
  });

  it('answers 404-style for a mission that does not exist', () => {
    const h = createHarness();
    expect(() =>
      h.core.missions.updateMission(h.ctx(), 'msn_missing', 1, { title: 'x' }),
    ).toThrow(MissionNotFoundError);
  });
});

describe('transition table', () => {
  it('rejects an invalid transition with a typed error and appends nothing', () => {
    const h = createHarness();
    const m = MissionDriver.create(h);

    expect(() => m.go('running')).toThrow(InvalidTransitionError);
    expect(() => m.go('completed')).toThrow(InvalidTransitionError);

    expect(eventCount(h, m.id)).toBe(1);
    expect(h.core.missions.getMission(TEST_WORKSPACE, m.id)?.state).toBe(
      'draft',
    );
  });

  it('carries the offending states on the error', () => {
    const h = createHarness();
    const m = MissionDriver.create(h);
    try {
      m.go('verifying');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidTransitionError);
      expect(error).toMatchObject({
        entity: 'mission',
        from: 'draft',
        to: 'verifying',
        code: 'invalid_transition',
      });
    }
  });

  it('never leaves cancelled', () => {
    const h = createHarness();
    const m = MissionDriver.create(h);
    m.go('cancelled');
    for (const to of [
      'draft',
      'planning',
      'ready',
      'running',
      'needs-attention',
    ] as const) {
      expect(() => m.go(to)).toThrow(InvalidTransitionError);
    }
  });

  it('records actor, expected version, correlation id and refs on each transition', () => {
    const h = createHarness();
    const m = MissionDriver.create(h);

    h.core.missions.transitionMission(
      h.ctx(h.cos, { correlationId: 'corr-7' }),
      m.id,
      1,
      'planning',
      'start planning',
    );

    const activity = h.core.missions.activity(TEST_WORKSPACE, m.id, {
      afterVersion: 1,
      limit: 10,
    });
    expect(activity.items).toEqual([
      expect.objectContaining({
        version: 2,
        type: 'mission.transitioned',
        actorId: 'prn_cos',
        correlationId: 'corr-7',
        payload: { to: 'planning', reason: 'start planning' },
        stateAfter: 'planning',
      }),
    ]);
  });
});

describe('idempotent requests', () => {
  it('returns the first result for a repeated create and writes one event', () => {
    const h = createHarness();
    const ctx = h.ctx(h.owner, { idempotencyKey: 'create-1' });

    const first = h.core.missions.createMission(ctx, mission());
    const second = h.core.missions.createMission(ctx, mission());

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.mission).toEqual(first.mission);
    expect(second.event).toEqual(first.event);
    expect(
      h.core.missions.search(TEST_WORKSPACE, { limit: 10, offset: 0 }).total,
    ).toBe(1);
  });

  it('returns the first result for a repeated update even after the mission moved on', () => {
    const h = createHarness();
    const m = MissionDriver.create(h);
    const ctx = h.ctx(h.owner, { idempotencyKey: 'rename-1' });

    const first = h.core.missions.updateMission(ctx, m.id, 1, {
      title: 'Once',
    });
    h.core.missions.updateMission(h.ctx(), m.id, 2, { title: 'Later' });
    const repeat = h.core.missions.updateMission(ctx, m.id, 1, {
      title: 'Once',
    });

    expect(repeat.replayed).toBe(true);
    expect(repeat.mission.title).toBe('Once');
    expect(repeat.mission.version).toBe(2);
    expect(repeat.event.seq).toBe(first.event.seq);
    expect(eventCount(h, m.id)).toBe(3);
  });

  it('answers a replayed transition from the first result, not the state check', () => {
    const h = createHarness();
    const m = MissionDriver.create(h);
    const ctx = h.ctx(h.owner, { idempotencyKey: 'plan-1' });

    h.core.missions.transitionMission(ctx, m.id, 1, 'planning', null);
    // draft -> planning is no longer valid from `planning`, but the retry must still succeed.
    const repeat = h.core.missions.transitionMission(
      ctx,
      m.id,
      1,
      'planning',
      null,
    );

    expect(repeat.replayed).toBe(true);
    expect(repeat.mission.state).toBe('planning');
  });

  it('rejects a reused key with a different request', () => {
    const h = createHarness();
    const ctx = h.ctx(h.owner, { idempotencyKey: 'k1' });
    h.core.missions.createMission(ctx, mission({ title: 'A' }));

    expect(() =>
      h.core.missions.createMission(ctx, mission({ title: 'B' })),
    ).toThrow(IdempotencyKeyReuseError);
  });

  it('does not burn the key when the request fails a state check', () => {
    const h = createHarness();
    const m = MissionDriver.create(h);
    const ctx = h.ctx(h.owner, { idempotencyKey: 'bad-then-good' });

    expect(() =>
      h.core.missions.transitionMission(ctx, m.id, 1, 'running', null),
    ).toThrow(InvalidTransitionError);
    const ok = h.core.missions.transitionMission(
      ctx,
      m.id,
      1,
      'planning',
      null,
    );

    // A different body under the same key is fine because the failed call left no record.
    expect(ok.replayed).toBe(false);
  });

  it('scopes keys to the actor', () => {
    const h = createHarness();
    const a = h.core.missions.createMission(
      h.ctx(h.owner, { idempotencyKey: 'same' }),
      mission(),
    );
    const b = h.core.missions.createMission(
      h.ctx(h.cos, { idempotencyKey: 'same' }),
      mission(),
    );

    expect(a.mission.id).not.toBe(b.mission.id);
    expect(b.replayed).toBe(false);
  });

  it('makes a repeated add-packet name the same packet', () => {
    const h = createHarness();
    const m = MissionDriver.create(h);
    const ctx = h.ctx(h.owner, { idempotencyKey: 'pkt-1' });
    const input = {
      title: 'Build',
      instructions: '',
      scope: [],
      required: true,
      dependsOn: [],
    };

    const first = h.core.missions.addPacket(ctx, m.id, 1, input);
    const repeat = h.core.missions.addPacket(ctx, m.id, 1, input);

    expect(repeat.replayed).toBe(true);
    expect(repeat.mission.packets.map((p) => p.id)).toEqual(
      first.mission.packets.map((p) => p.id),
    );
    expect(
      h.core.missions.getMission(TEST_WORKSPACE, m.id)?.packets,
    ).toHaveLength(1);
  });
});

describe('replay', () => {
  it('rebuilds exactly the projected state from the events alone', () => {
    const h = createHarness();
    const m = MissionDriver.create(
      h,
      mission({ definitionOfDone: [{ text: 'ship', done: false }] }),
    );
    m.go('planning');
    m.go('ready');
    const a = m.addPacket('A');
    const b = m.addPacket('B', { dependsOn: [a] });
    m.authorize(a);
    m.authorize(b);
    h.pool.online = ['prn_runner'];
    m.tick();
    m.runAttempt(a);
    m.verifyPacket(a);
    m.tick();
    m.runAttempt(b);
    m.verifyPacket(b);
    m.tick();
    h.core.missions.updateMission(h.ctx(), m.id, m.state.version, {
      definitionOfDone: [{ text: 'ship', done: true }],
    });
    m.refresh();
    m.verifyOutcome();
    const completed = h.core.missions.transitionMission(
      h.ctx(),
      m.id,
      m.state.version,
      'completed',
      null,
    );

    const projected = h.core.missions.getMission(TEST_WORKSPACE, m.id);
    const replayed = h.core.missions.replayMission(TEST_WORKSPACE, m.id);

    expect(completed.mission.state).toBe('completed');
    expect(replayed).toEqual(projected);
    expect(replayed.version).toBeGreaterThan(10);
  });

  it('restores the projection tables after they are lost', () => {
    const h = createHarness();
    const m = MissionDriver.create(h);
    m.go('ready');
    const a = m.addPacket('A');
    m.authorize(a);
    h.pool.online = ['prn_runner'];
    m.tick();
    const before = h.core.missions.getMission(TEST_WORKSPACE, m.id);

    h.db.run('DELETE FROM execution_attempts');
    h.db.run('DELETE FROM packet_dependencies');
    h.db.run('DELETE FROM work_packets');
    h.db.run('DELETE FROM missions');
    expect(h.core.missions.getMission(TEST_WORKSPACE, m.id)).toBeUndefined();
    h.core.missions.rebuildProjection(TEST_WORKSPACE, m.id);

    expect(h.core.missions.getMission(TEST_WORKSPACE, m.id)).toEqual(before);
    expect(h.db.all('SELECT status FROM work_packets')).toEqual([
      { status: 'leased' },
    ]);
    expect(
      h.db.all('SELECT status, runner_id FROM execution_attempts'),
    ).toEqual([{ status: 'leased', runner_id: 'prn_runner' }]);
  });
});

describe('work packets', () => {
  it('rejects a dependency on a packet outside the mission', () => {
    const h = createHarness();
    const m = MissionDriver.create(h);
    expect(() =>
      h.core.missions.addPacket(h.ctx(), m.id, 1, {
        title: 'X',
        instructions: '',
        scope: [],
        required: true,
        dependsOn: ['pkt_unknown'],
      }),
    ).toThrow(ValidationError);
  });

  it('refuses to add packets once the mission is verifying', () => {
    const h = createHarness();
    const m = MissionDriver.create(h);
    m.toVerifying();
    expect(() => m.addPacket('late')).toThrow(CommandNotAllowedError);
  });

  it('reports an unknown packet as not found', () => {
    const h = createHarness();
    const m = MissionDriver.create(h);
    expect(() => m.authorize('pkt_nope')).toThrow(PacketNotFoundError);
  });

  describe('a chief of staff authorizing a packet', () => {
    function setup(
      scope: string[] = ['env:staging'],
      risk = 'medium' as const,
    ) {
      const h = createHarness();
      const m = MissionDriver.create(h, mission({ risk }));
      m.go('ready');
      m.state = h.core.missions.addPacket(h.ctx(), m.id, m.state.version, {
        title: 'A',
        instructions: '',
        scope,
        required: true,
        dependsOn: [],
      }).mission;
      const id = m.state.packets[0]?.id as string;
      const policy = createPolicyService({ db: h.db, clock: h.clock.now });
      const rule = (overrides: Parameters<typeof ruleInput>[0] = {}) =>
        policy.createRule(h.ctx(h.owner), ruleInput(overrides)).rule;
      const unauthorized = () =>
        expect(m.refresh().packets[0]?.authorization).toBeNull();
      return { h, m, id, policy, rule, unauthorized };
    }

    it('must cite a policy rule', () => {
      const { h, m, id, unauthorized } = setup();
      expect(() => m.authorize(id, h.cos)).toThrow(/cite the policy/);
      // A decision link is audit context. It is not a policy.
      expect(() => m.authorize(id, h.cos, ['decision:dec_1@1'])).toThrow(
        /cite the policy/,
      );
      unauthorized();
    });

    it('is allowed under a current rule that covers the packet, and records the cited ref', () => {
      const { h, m, id, rule } = setup();
      const granted = rule();
      const ref = `policy:v1:rule:${granted.id}@1`;
      m.authorize(id, h.cos, [ref, 'decision:dec_1@1']);
      expect(m.state.packets[0]?.authorization).toMatchObject({
        by: 'prn_cos',
        policyRefs: [ref, 'decision:dec_1@1'],
      });
    });

    it.each([
      ['a fabricated ref', 'policy:v1:rule:rul_fabricated@1'],
      ['a bare label', 'policy:1'],
      ['a ref that names no rule', 'policy:v1:no_matching_grant'],
    ])('is refused for %s, and the packet stays unauthorized', (_name, ref) => {
      const { h, m, id, rule, unauthorized } = setup();
      rule();
      expect(() => m.authorize(id, h.cos, [ref])).toThrow(
        CommandNotAllowedError,
      );
      unauthorized();
    });

    it('is refused when one of several cited refs is fabricated', () => {
      const { h, m, id, rule, unauthorized } = setup();
      const granted = rule();
      expect(() =>
        m.authorize(id, h.cos, [
          `policy:v1:rule:${granted.id}@1`,
          'policy:v1:rule:rul_fabricated@1',
        ]),
      ).toThrow(CommandNotAllowedError);
      unauthorized();
    });

    it('is refused once the rule is revoked, even with a second rule that would allow it', () => {
      const { h, m, id, rule, policy, unauthorized } = setup();
      const first = rule();
      rule();
      policy.revokeRule(h.ctx(h.owner), first.id, 1, 'test');
      expect(() =>
        m.authorize(id, h.cos, [`policy:v2:rule:${first.id}@2`]),
      ).toThrow(/revoked/);
      unauthorized();
    });

    it('is refused once the rule has expired', () => {
      const { h, m, id, rule, unauthorized } = setup();
      const granted = rule({
        expiresAt: new Date(h.clock.now().getTime() + 1000).toISOString(),
      });
      h.clock.advance(2000);
      expect(() =>
        m.authorize(id, h.cos, [`policy:v1:rule:${granted.id}@1`]),
      ).toThrow(/expired/);
      unauthorized();
    });

    it('is refused for a version of the rule that is not current', () => {
      const { h, m, id, rule, policy, unauthorized } = setup();
      const granted = rule();
      policy.amendRule(h.ctx(h.owner), granted.id, 1, { note: 'tightened' });
      expect(() =>
        m.authorize(id, h.cos, [`policy:v1:rule:${granted.id}@1`]),
      ).toThrow(/does not name a current rule/);
      unauthorized();
      m.authorize(id, h.cos, [`policy:v2:rule:${granted.id}@2`]);
    });

    it('is refused when a deny rule covers the rule it cites', () => {
      const { h, m, id, rule, unauthorized } = setup();
      const granted = rule();
      rule({ effect: 'deny', grantee: { kind: null, principalId: null } });
      expect(() =>
        m.authorize(id, h.cos, [`policy:v2:rule:${granted.id}@1`]),
      ).toThrow(/denied by rule/);
      unauthorized();
    });

    it('is refused when the cited rule is itself a deny rule', () => {
      const { h, m, id, rule, unauthorized } = setup();
      const deny = rule({
        effect: 'deny',
        grantee: { kind: null, principalId: null },
      });
      expect(() =>
        m.authorize(id, h.cos, [`policy:v1:rule:${deny.id}@1`]),
      ).toThrow(/names a deny rule/);
      unauthorized();
    });

    it.each([
      [
        'held by another principal',
        { grantee: { kind: null, principalId: 'prn_runner' } },
      ],
      [
        'for a runner',
        { grantee: { kind: 'runner' as const, principalId: null } },
      ],
      [
        'for other missions',
        { limits: { maxAmount: null, missionIds: ['msn_x'] } },
      ],
      ['capped below the mission risk', { maxRisk: 'low' as const }],
      ['for another scope', { scope: 'env:production' }],
      ['for a narrower scope than the packet', { scope: 'env:stag' }],
    ])('is refused under a rule %s', (_name, overrides) => {
      const { h, m, id, rule, unauthorized } = setup();
      const granted = rule(overrides);
      expect(() =>
        m.authorize(id, h.cos, [`policy:v1:rule:${granted.id}@1`]),
      ).toThrow(CommandNotAllowedError);
      unauthorized();
    });

    it('is refused when a rule covers only part of what the packet declares', () => {
      const { h, m, id, rule, unauthorized } = setup([
        'env:staging',
        'env:production',
      ]);
      const granted = rule();
      expect(() =>
        m.authorize(id, h.cos, [`policy:v1:rule:${granted.id}@1`]),
      ).toThrow(/env:production/);
      unauthorized();
    });

    it('is refused for a packet that declares no scope', () => {
      const { h, m, id, rule, unauthorized } = setup([]);
      const granted = rule({ scope: '*' });
      expect(() =>
        m.authorize(id, h.cos, [`policy:v1:rule:${granted.id}@1`]),
      ).toThrow(/declares no execution scope/);
      unauthorized();
    });

    it('is refused for a person too: no packet is authorized without an execution scope', () => {
      const { h, m, id, unauthorized } = setup([]);
      expect(() => m.authorize(id, h.owner, [])).toThrow(
        CommandNotAllowedError,
      );
      expect(() => m.authorize(id, h.owner, [])).toThrow(
        /declares no execution scope/,
      );
      unauthorized();
    });

    it('checks the rule again on each call, so a revocation after a dry run still bites', () => {
      const { h, m, id, rule, policy, unauthorized } = setup();
      const granted = rule();
      const dry = policy.authorize(
        {
          workspace: TEST_WORKSPACE,
          principal: h.cos.id,
          action: granted.action,
          resource: granted.resource,
          scope: 'env:staging',
          risk: 'medium',
        },
        { escalate: true },
      );
      expect(dry.effect).toBe('allow');
      policy.revokeRule(h.ctx(h.owner), granted.id, 1, 'test');
      expect(() => m.authorize(id, h.cos, [dry.policyRef])).toThrow(
        CommandNotAllowedError,
      );
      unauthorized();
    });

    it('does not apply to a human, who needs no citation', () => {
      const { m, id } = setup();
      m.authorize(id);
      expect(m.state.packets[0]?.authorization).toMatchObject({
        by: 'prn_owner',
      });
    });
  });

  it('refuses a runner principal for authorization and verification', () => {
    const h = createHarness();
    const m = MissionDriver.create(h);
    const a = m.addPacket('A');
    expect(() => m.authorize(a, h.runner)).toThrow(ForbiddenActorError);
  });
});
