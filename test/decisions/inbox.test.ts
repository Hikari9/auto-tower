import { describe, expect, it } from 'vitest';
import {
  MissionNotFoundError,
  PacketNotFoundError,
  ValidationError,
} from '../../src/core/errors.js';
import {
  AnswerConflictError,
  DecisionNotFoundError,
  DedupeConflictError,
  DelegationRequiredError,
} from '../../src/decisions/index.js';
import { AuthorityForbiddenError } from '../../src/policy/errors.js';
import { seedFixedPrincipal } from '../core/helpers.js';
import {
  type AuthorityHarness,
  createAuthorityHarness,
  decisionInput,
  grant,
  missionWith,
  packetStatus,
  request,
  revoke,
} from '../policy/helpers.js';

function setup() {
  const h = createAuthorityHarness();
  return { h, inbox: h.authority.decisions };
}

function ctx(h: AuthorityHarness, actor = h.owner) {
  return { workspaceId: 'ws_test', actor };
}

/** Two missions each with one blocked branch and one running branch. */
function twoMissions(h: AuthorityHarness) {
  const a = missionWith(h, [
    { title: 'a-run', authorized: true },
    { title: 'a-wait' },
    { title: 'a-other-wait' },
  ]);
  const b = missionWith(h, [
    { title: 'b-run', authorized: true },
    { title: 'b-wait' },
  ]);
  return { a, b };
}

describe('creating a decision', () => {
  it('carries the fields the spec lists and an audit trail', () => {
    const { h, inbox } = setup();
    const { driver, ids } = missionWith(h, [{ title: 'wait' }]);
    const { decision, created } = inbox.create(
      ctx(h, h.cos),
      decisionInput([{ missionId: driver.id, packetId: ids[0] as string }], {
        urgency: 'high',
        category: 'sensitive_action',
        requiredAuthority: 'human',
        request: {
          action: 'scope.extend',
          resource: 'repo:app',
          scope: 'src/billing',
          risk: 'low',
          amount: null,
        },
      }),
    );
    expect(created).toBe(true);
    expect(decision).toMatchObject({
      status: 'open',
      version: 1,
      dedupeKey: 'dk-1',
      category: 'sensitive_action',
      urgency: 'high',
      question: 'May the follow-up touch the billing module?',
      consequences: 'The follow-up packet may edit billing files.',
      requiredAuthority: 'human',
      evidence: ['ev:plan'],
      affectedScope: ['src/billing'],
      createdBy: h.cos.id,
      effectiveAnswer: null,
      advisory: { confidencePercent: 90 },
    });
    expect(decision.alternatives.map((a) => a.id)).toEqual([
      'approve',
      'decline',
    ]);
    expect(decision.recommendation).toEqual({
      alternativeId: 'approve',
      rationale: 'It is low risk.',
      by: h.cos.id,
    });
    expect(decision.links).toMatchObject([
      { missionId: driver.id, packetId: ids[0], status: 'blocked' },
    ]);
    const history = inbox.history('ws_test', decision.id, {
      afterVersion: 0,
      limit: 10,
    });
    expect(history.items.map((i) => [i.type, i.actorId])).toEqual([
      ['decision.created', h.cos.id],
    ]);
  });

  it('blocks only the named branch', () => {
    const { h, inbox } = setup();
    const { a } = twoMissions(h);
    const [run, wait, other] = a.ids as [string, string, string];
    inbox.create(
      ctx(h),
      decisionInput([{ missionId: a.driver.id, packetId: wait }]),
    );
    h.pool.online = [h.runner.id];
    a.driver.tick();
    expect(packetStatus(a.driver, run).status).toBe('leased');
    expect(packetStatus(a.driver, wait)).toEqual({
      status: 'pending',
      authorized: false,
    });
    expect(packetStatus(a.driver, other).status).toBe('pending');
    expect(a.driver.refresh().state).toBe('running');
  });

  it('rejects branches that cannot be blocked', () => {
    const { h, inbox } = setup();
    const { driver, ids } = missionWith(h, [
      { title: 'wait' },
      { title: 'run', authorized: true },
    ]);
    const make = (branches: Parameters<typeof decisionInput>[0]) => () =>
      inbox.create(ctx(h), decisionInput(branches));
    expect(
      make([{ missionId: driver.id, packetId: ids[1] as string }]),
    ).toThrow(ValidationError);
    expect(make([{ missionId: driver.id, packetId: 'pkt_nope' }])).toThrow(
      PacketNotFoundError,
    );
    expect(make([{ missionId: 'msn_nope', packetId: null }])).toThrow(
      MissionNotFoundError,
    );
    expect(
      make([
        { missionId: driver.id, packetId: ids[0] as string },
        { missionId: driver.id, packetId: ids[0] as string },
      ]),
    ).toThrow(ValidationError);
    expect(inbox.list('ws_test', { status: 'all' })).toEqual([]);
  });

  it('cannot see or block a mission in another workspace', () => {
    const { h, inbox } = setup();
    const { driver, ids } = missionWith(h, [{ title: 'wait' }]);
    const foreign = seedFixedPrincipal(
      h.db,
      'prn_foreign',
      'human',
      'ws_elsewhere',
    );
    expect(() =>
      inbox.create(
        { workspaceId: 'ws_elsewhere', actor: foreign },
        decisionInput([{ missionId: driver.id, packetId: ids[0] as string }]),
      ),
    ).toThrow(MissionNotFoundError);
  });
});

describe('deduplication', () => {
  it('links branches that share a dedupe key to one item', () => {
    const { h, inbox } = setup();
    const { a, b } = twoMissions(h);
    const first = inbox.create(
      ctx(h),
      decisionInput([{ missionId: a.driver.id, packetId: a.ids[1] as string }]),
    );
    const second = inbox.create(
      ctx(h, h.cos),
      decisionInput([{ missionId: b.driver.id, packetId: b.ids[1] as string }]),
    );
    expect(second.created).toBe(false);
    expect(second.decision.id).toBe(first.decision.id);
    expect(second.linked).toEqual([
      { missionId: b.driver.id, packetId: b.ids[1] },
    ]);
    expect(second.decision.links).toHaveLength(2);
    expect(second.decision.version).toBe(2);
    expect(inbox.list('ws_test')).toHaveLength(1);

    // The same branch again changes nothing, and writes no event.
    const again = inbox.create(
      ctx(h),
      decisionInput([{ missionId: b.driver.id, packetId: b.ids[1] as string }]),
    );
    expect(again.linked).toEqual([]);
    expect(again.decision.version).toBe(2);
    expect(
      inbox
        .history('ws_test', first.decision.id, { afterVersion: 0, limit: 10 })
        .items.map((i) => i.type),
    ).toEqual(['decision.created', 'decision.linked']);
  });

  it('refuses a key that already names an open decision about something else', () => {
    const { h, inbox } = setup();
    const { a, b } = twoMissions(h);
    inbox.create(
      ctx(h),
      decisionInput([{ missionId: a.driver.id, packetId: a.ids[1] as string }]),
    );
    expect(() =>
      inbox.create(
        ctx(h, h.cos),
        decisionInput(
          [{ missionId: b.driver.id, packetId: b.ids[1] as string }],
          {
            category: 'spend',
          },
        ),
      ),
    ).toThrow(DedupeConflictError);
    expect(() =>
      inbox.create(
        ctx(h, h.cos),
        decisionInput(
          [{ missionId: b.driver.id, packetId: b.ids[1] as string }],
          {
            question: 'Something else entirely?',
          },
        ),
      ),
    ).toThrow(DedupeConflictError);
    expect(
      inbox.get('ws_test', inbox.list('ws_test')[0]?.id as string)?.links,
    ).toHaveLength(1);
  });

  it('starts a new item once the earlier one was answered', () => {
    const { h, inbox } = setup();
    const { a, b } = twoMissions(h);
    const first = inbox.create(
      ctx(h),
      decisionInput([{ missionId: a.driver.id, packetId: a.ids[1] as string }]),
    );
    inbox.answer(ctx(h), first.decision.id, {
      version: 1,
      choice: 'approve',
      note: null,
    });
    const next = inbox.create(
      ctx(h),
      decisionInput([{ missionId: b.driver.id, packetId: b.ids[1] as string }]),
    );
    expect(next.created).toBe(true);
    expect(next.decision.id).not.toBe(first.decision.id);
  });
});

describe('the inbox list', () => {
  it('puts urgent items first, then the oldest, and answered items last', () => {
    const { h, inbox } = setup();
    const m = missionWith(h, [
      { title: '1' },
      { title: '2' },
      { title: '3' },
      { title: '4' },
    ]);
    const make = (i: number, urgency: 'low' | 'normal' | 'high' | 'urgent') =>
      inbox.create(
        ctx(h),
        decisionInput(
          [{ missionId: m.driver.id, packetId: m.ids[i] as string }],
          {
            dedupeKey: `k${i}`,
            urgency,
          },
        ),
      ).decision;
    const normalOld = make(0, 'normal');
    const low = make(1, 'low');
    const urgent = make(2, 'urgent');
    const normalNew = make(3, 'normal');
    expect(inbox.list('ws_test').map((d) => d.id)).toEqual([
      urgent.id,
      normalOld.id,
      normalNew.id,
      low.id,
    ]);
    inbox.answer(ctx(h), urgent.id, {
      version: 1,
      choice: 'decline',
      note: null,
    });
    expect(inbox.list('ws_test').map((d) => d.id)).toEqual([
      normalOld.id,
      normalNew.id,
      low.id,
    ]);
    expect(
      inbox.list('ws_test', { status: 'answered' }).map((d) => d.id),
    ).toEqual([urgent.id]);
    expect(inbox.list('ws_test', { status: 'all' }).map((d) => d.id)).toEqual([
      normalOld.id,
      normalNew.id,
      low.id,
      urgent.id,
    ]);
    expect(inbox.list('ws_test', { limit: 1 })).toHaveLength(1);
  });
});

describe('answering', () => {
  it('resumes only the branches linked to the decision and leaves everything else alone', () => {
    const { h, inbox } = setup();
    const { a, b } = twoMissions(h);
    const c = missionWith(h, [
      { title: 'c-run', authorized: true },
      { title: 'c-wait' },
    ]);
    const linked = [
      { missionId: a.driver.id, packetId: a.ids[1] as string },
      { missionId: b.driver.id, packetId: b.ids[1] as string },
    ];
    const decision = inbox.create(ctx(h), decisionInput(linked)).decision;
    const unrelated = inbox.create(
      ctx(h),
      decisionInput(
        [{ missionId: c.driver.id, packetId: c.ids[1] as string }],
        { dedupeKey: 'dk-c' },
      ),
    ).decision;

    h.pool.online = [h.runner.id];
    c.driver.tick();
    const cRunBefore = packetStatus(c.driver, c.ids[0] as string);

    const result = inbox.answer(ctx(h), decision.id, {
      version: 1,
      choice: 'approve',
      note: 'go',
    });
    expect(result).toMatchObject({
      applied: true,
      superseded: false,
      replayed: false,
    });
    expect(result.branches.map((x) => x.status)).toEqual([
      'resumed',
      'resumed',
    ]);
    expect(result.decision).toMatchObject({
      status: 'answered',
      effectiveAnswer: {
        version: 1,
        choice: 'approve',
        note: 'go',
        answeredBy: h.owner.id,
      },
    });

    // Linked branches are authorized, citing the decision and the human who answered.
    for (const [mission, packetId] of [
      [a, a.ids[1]],
      [b, b.ids[1]],
    ] as const) {
      expect(packetStatus(mission.driver, packetId as string).authorized).toBe(
        true,
      );
      const events = h.core.missions.activity('ws_test', mission.driver.id, {
        afterVersion: 0,
        limit: 100,
      }).items;
      const authorized = events
        .filter((e) => e.type === 'packet.authorized')
        .pop();
      expect(authorized).toMatchObject({
        actorId: h.owner.id,
        policyRefs: [`decision:${decision.id}@1`],
      });
    }
    // The unlinked branch of the same mission, and everything in the other mission, did not move.
    expect(packetStatus(a.driver, a.ids[2] as string)).toEqual({
      status: 'pending',
      authorized: false,
    });
    expect(packetStatus(c.driver, c.ids[1] as string)).toEqual({
      status: 'pending',
      authorized: false,
    });
    expect(packetStatus(c.driver, c.ids[0] as string)).toEqual(cRunBefore);
    expect(inbox.get('ws_test', unrelated.id)).toMatchObject({
      status: 'open',
    });

    // The scheduler now picks the resumed branches up, and mission C keeps running.
    h.pool.online = [h.runner.id, 'prn_runner_two'];
    a.driver.tick();
    b.driver.tick();
    expect(['ready', 'leased']).toContain(
      packetStatus(a.driver, a.ids[1] as string).status,
    );
    expect(c.driver.refresh().state).toBe('running');
  });

  it('keeps a declined branch blocked and runs nothing', () => {
    const { h, inbox } = setup();
    const { a } = twoMissions(h);
    const decision = inbox.create(
      ctx(h),
      decisionInput([{ missionId: a.driver.id, packetId: a.ids[1] as string }]),
    ).decision;
    const before = a.driver.refresh().version;
    const result = inbox.answer(ctx(h), decision.id, {
      version: 1,
      choice: 'decline',
      note: null,
    });
    expect(result.branches).toMatchObject([
      { status: 'declined', reason: 'answered "decline"' },
    ]);
    expect(packetStatus(a.driver, a.ids[1] as string)).toEqual({
      status: 'pending',
      authorized: false,
    });
    expect(a.driver.refresh().version).toBe(before);
  });

  it('skips a branch that went stale and still resumes the rest', () => {
    const { h, inbox } = setup();
    const { a, b } = twoMissions(h);
    const decision = inbox.create(
      ctx(h),
      decisionInput([
        { missionId: a.driver.id, packetId: a.ids[1] as string },
        { missionId: b.driver.id, packetId: b.ids[1] as string },
      ]),
    ).decision;
    // Someone else authorized mission A's packet in the meantime.
    a.driver.authorize(a.ids[1] as string);
    const result = inbox.answer(ctx(h), decision.id, {
      version: 1,
      choice: 'approve',
      note: null,
    });
    expect(result.branches).toMatchObject([
      {
        missionId: a.driver.id,
        status: 'skipped',
        reason: 'the packet is already authorized',
      },
      { missionId: b.driver.id, status: 'resumed' },
    ]);
    expect(packetStatus(b.driver, b.ids[1] as string).authorized).toBe(true);
  });

  it('skips a branch of a mission that was cancelled', () => {
    const { h, inbox } = setup();
    const { a } = twoMissions(h);
    const decision = inbox.create(
      ctx(h),
      decisionInput([{ missionId: a.driver.id, packetId: a.ids[1] as string }]),
    ).decision;
    a.driver.go('cancelled');
    const result = inbox.answer(ctx(h), decision.id, {
      version: 1,
      choice: 'approve',
      note: null,
    });
    expect(result.branches).toMatchObject([
      { status: 'skipped', reason: 'the packet is already cancelled' },
    ]);
  });

  it('turns an unknown choice into a validation error and writes nothing', () => {
    const { h, inbox } = setup();
    const { a } = twoMissions(h);
    const decision = inbox.create(
      ctx(h),
      decisionInput([{ missionId: a.driver.id, packetId: a.ids[1] as string }]),
    ).decision;
    expect(() =>
      inbox.answer(ctx(h), decision.id, {
        version: 1,
        choice: 'maybe',
        note: null,
      }),
    ).toThrow(ValidationError);
    expect(inbox.answers('ws_test', decision.id)).toEqual([]);
  });

  it('does not find a decision from another workspace', () => {
    const { h, inbox } = setup();
    const { a } = twoMissions(h);
    const decision = inbox.create(
      ctx(h),
      decisionInput([{ missionId: a.driver.id, packetId: a.ids[1] as string }]),
    ).decision;
    const foreign = seedFixedPrincipal(
      h.db,
      'prn_foreign',
      'human',
      'ws_elsewhere',
    );
    expect(() =>
      inbox.answer(
        { workspaceId: 'ws_elsewhere', actor: foreign },
        decision.id,
        { version: 1, choice: 'approve', note: null },
      ),
    ).toThrow(DecisionNotFoundError);
    expect(inbox.get('ws_elsewhere', decision.id)).toBeUndefined();
    expect(inbox.list('ws_elsewhere')).toEqual([]);
  });

  it('is an answer to this one request only: no grant results from an approval', () => {
    const { h, inbox } = setup();
    const { a } = twoMissions(h);
    const spec = {
      action: 'scope.extend',
      resource: 'repo:app',
      scope: 'infra',
      risk: 'low' as const,
      amount: null,
    };
    const decision = inbox.create(
      ctx(h),
      decisionInput(
        [{ missionId: a.driver.id, packetId: a.ids[1] as string }],
        { request: spec },
      ),
    ).decision;
    inbox.answer(ctx(h), decision.id, {
      version: 1,
      choice: 'approve',
      note: null,
    });
    expect(h.authority.policy.listRules('ws_test')).toEqual([]);
    expect(h.authority.policy.policyVersion('ws_test')).toBe(0);
    expect(
      h.authority.policy.authorize(
        request({
          principal: h.cos.id,
          action: 'scope.extend',
          scope: 'infra',
        }),
      ).effect,
    ).toBe('deny');
  });
});

describe('out-of-order answers', () => {
  function run(
    order: ReadonlyArray<1 | 2>,
    first: 'approve' | 'decline',
    second: 'approve' | 'decline',
  ) {
    const { h, inbox } = setup();
    const { a } = twoMissions(h);
    const packetId = a.ids[1] as string;
    const decision = inbox.create(
      ctx(h),
      decisionInput([{ missionId: a.driver.id, packetId }]),
    ).decision;
    const choices = { 1: first, 2: second };
    const results = order.map((version) =>
      inbox.answer(version === 1 ? ctx(h) : ctx(h, h.other), decision.id, {
        version,
        choice: choices[version],
        note: null,
      }),
    );
    const after = inbox.get('ws_test', decision.id);
    return {
      results,
      effective: after?.effectiveAnswer,
      link: after?.links[0]?.status,
      authorized: packetStatus(a.driver, packetId).authorized,
      answers: inbox
        .answers('ws_test', decision.id)
        .map((x) => [x.version, x.choice]),
    };
  }

  it('settle on the highest version whichever arrives first', () => {
    for (const [first, second] of [
      ['approve', 'decline'],
      ['decline', 'approve'],
    ] as const) {
      const inOrder = run([1, 2], first, second);
      const reversed = run([2, 1], first, second);
      expect(reversed.effective).toMatchObject({ version: 2, choice: second });
      expect(inOrder.effective).toMatchObject({ version: 2, choice: second });
      expect(reversed.answers).toEqual(inOrder.answers);
    }
  });

  it('leave a late approval at a lower version with no effect', () => {
    const reversed = run([2, 1], 'approve', 'decline');
    expect(reversed.results.map((r) => [r.applied, r.superseded])).toEqual([
      [true, false],
      [false, true],
    ]);
    expect(reversed.authorized).toBe(false);
    expect(reversed.link).toBe('declined');
    // Both answers stay in the record.
    expect(reversed.answers).toEqual([
      [1, 'approve'],
      [2, 'decline'],
    ]);
  });

  it('end in the same state when the higher version approves, in either order', () => {
    const inOrder = run([1, 2], 'decline', 'approve');
    const reversed = run([2, 1], 'decline', 'approve');
    for (const outcome of [inOrder, reversed]) {
      expect(outcome.authorized).toBe(true);
      expect(outcome.link).toBe('resumed');
    }
  });

  it('cannot take back a branch an earlier version already resumed', () => {
    const inOrder = run([1, 2], 'approve', 'decline');
    expect(inOrder.effective).toMatchObject({ version: 2, choice: 'decline' });
    // Authorizing a packet is an event in the mission's log, so a later decline cannot erase it.
    expect(inOrder.authorized).toBe(true);
    expect(inOrder.link).toBe('resumed');
  });

  it('treats the same answer repeated as a replay and a different one as a conflict', () => {
    const { h, inbox } = setup();
    const { a } = twoMissions(h);
    const decision = inbox.create(
      ctx(h),
      decisionInput([{ missionId: a.driver.id, packetId: a.ids[1] as string }]),
    ).decision;
    inbox.answer(ctx(h), decision.id, {
      version: 1,
      choice: 'approve',
      note: 'x',
    });
    const versionBefore = a.driver.refresh().version;
    const replay = inbox.answer(ctx(h), decision.id, {
      version: 1,
      choice: 'approve',
      note: 'x',
    });
    expect(replay).toMatchObject({
      replayed: true,
      applied: false,
      superseded: false,
      branches: [],
    });
    expect(a.driver.refresh().version).toBe(versionBefore);
    expect(() =>
      inbox.answer(ctx(h), decision.id, {
        version: 1,
        choice: 'decline',
        note: 'x',
      }),
    ).toThrow(AnswerConflictError);
    expect(() =>
      inbox.answer(ctx(h), decision.id, {
        version: 1,
        choice: 'approve',
        note: 'other',
      }),
    ).toThrow(AnswerConflictError);
    expect(inbox.answers('ws_test', decision.id)).toHaveLength(1);
  });

  it('cannot be edited or removed once recorded', () => {
    const { h, inbox } = setup();
    const { a } = twoMissions(h);
    const decision = inbox.create(
      ctx(h),
      decisionInput([{ missionId: a.driver.id, packetId: a.ids[1] as string }]),
    ).decision;
    inbox.answer(ctx(h), decision.id, {
      version: 1,
      choice: 'approve',
      note: null,
    });
    expect(() =>
      h.db.run("UPDATE decision_answers SET choice = 'decline'"),
    ).toThrow(/append-only/);
    expect(() => h.db.run('DELETE FROM decision_answers')).toThrow(
      /append-only/,
    );
  });
});

describe('who may answer', () => {
  it.each(['runner', 'provider'] as const)(
    'refuses a %s principal and changes nothing',
    (who) => {
      const { h, inbox } = setup();
      const { a } = twoMissions(h);
      const decision = inbox.create(
        ctx(h),
        decisionInput([
          { missionId: a.driver.id, packetId: a.ids[1] as string },
        ]),
      ).decision;
      expect(() =>
        inbox.answer(ctx(h, h[who]), decision.id, {
          version: 1,
          choice: 'approve',
          note: null,
        }),
      ).toThrow(AuthorityForbiddenError);
      expect(inbox.get('ws_test', decision.id)?.status).toBe('open');
      expect(inbox.answers('ws_test', decision.id)).toEqual([]);
      expect(packetStatus(a.driver, a.ids[1] as string).authorized).toBe(false);
    },
  );

  const delegated = {
    request: {
      action: 'scope.extend',
      resource: 'repo:app',
      scope: 'infra',
      risk: 'low' as const,
      amount: null,
    },
    requiredAuthority: 'chief_of_staff' as const,
  };
  const delegation = {
    action: 'scope.extend',
    resource: 'repo:app',
    scope: 'infra',
  };

  it('lets a Chief of Staff answer a decision raised for one while a rule covers it', () => {
    const { h, inbox } = setup();
    const { a } = twoMissions(h);
    const rule = grant(h, delegation);
    const decision = inbox.create(
      ctx(h, h.runner),
      decisionInput(
        [{ missionId: a.driver.id, packetId: a.ids[1] as string }],
        delegated,
      ),
    ).decision;
    const result = inbox.answer(ctx(h, h.cos), decision.id, {
      version: 1,
      choice: 'approve',
      note: null,
    });
    expect(result.branches[0]?.status).toBe('resumed');
    const events = h.core.missions.activity('ws_test', a.driver.id, {
      afterVersion: 0,
      limit: 100,
    }).items;
    const authorized = events
      .filter((e) => e.type === 'packet.authorized')
      .pop();
    expect(authorized).toMatchObject({ actorId: h.cos.id });
    expect(authorized?.policyRefs).toEqual([
      `decision:${decision.id}@1`,
      `policy:v1:rule:${rule.id}@1`,
    ]);
  });

  it('refuses a Chief of Staff once the rule was revoked, and leaves a receipt', () => {
    const { h, inbox } = setup();
    const { a } = twoMissions(h);
    const rule = grant(h, delegation);
    const decision = inbox.create(
      ctx(h, h.runner),
      decisionInput(
        [{ missionId: a.driver.id, packetId: a.ids[1] as string }],
        delegated,
      ),
    ).decision;
    revoke(h, rule.id, 1);
    expect(() =>
      inbox.answer(ctx(h, h.cos), decision.id, {
        version: 1,
        choice: 'approve',
        note: null,
      }),
    ).toThrow(DelegationRequiredError);
    expect(inbox.get('ws_test', decision.id)?.status).toBe('open');
    expect(packetStatus(a.driver, a.ids[1] as string).authorized).toBe(false);
    expect(
      h.authority.policy.receipts('ws_test', { afterSeq: 0, limit: 10 }),
    ).toMatchObject([
      {
        principalId: h.cos.id,
        effect: 'deny',
        code: 'grant_revoked',
        ruleId: rule.id,
      },
    ]);
    // A person can still answer it.
    expect(
      inbox.answer(ctx(h), decision.id, {
        version: 1,
        choice: 'approve',
        note: null,
      }).applied,
    ).toBe(true);
  });

  it('refuses a Chief of Staff for a decision that needs a person, or carries no request', () => {
    const { h, inbox } = setup();
    const { a } = twoMissions(h);
    grant(h, delegation);
    const human = inbox.create(
      ctx(h),
      decisionInput(
        [{ missionId: a.driver.id, packetId: a.ids[1] as string }],
        {
          ...delegated,
          requiredAuthority: 'human',
        },
      ),
    ).decision;
    expect(() =>
      inbox.answer(ctx(h, h.cos), human.id, {
        version: 1,
        choice: 'approve',
        note: null,
      }),
    ).toThrow(DelegationRequiredError);
    const noRequest = inbox.create(
      ctx(h),
      decisionInput(
        [{ missionId: a.driver.id, packetId: a.ids[2] as string }],
        {
          dedupeKey: 'dk-2',
          requiredAuthority: 'chief_of_staff',
        },
      ),
    ).decision;
    expect(() =>
      inbox.answer(ctx(h, h.cos), noRequest.id, {
        version: 1,
        choice: 'approve',
        note: null,
      }),
    ).toThrow(DelegationRequiredError);
  });

  it('needs the rule to cover every mission the decision is linked to', () => {
    const { h, inbox } = setup();
    const { a, b } = twoMissions(h);
    grant(h, {
      ...delegation,
      limits: { maxAmount: null, missionIds: [a.driver.id] },
    });
    const decision = inbox.create(
      ctx(h, h.runner),
      decisionInput(
        [
          { missionId: a.driver.id, packetId: a.ids[1] as string },
          { missionId: b.driver.id, packetId: b.ids[1] as string },
        ],
        delegated,
      ),
    ).decision;
    expect(() =>
      inbox.answer(ctx(h, h.cos), decision.id, {
        version: 1,
        choice: 'approve',
        note: null,
      }),
    ).toThrow(DelegationRequiredError);
  });
});

describe('approvals that repeat', () => {
  const spec = {
    action: 'scope.extend',
    resource: 'repo:app',
    scope: 'infra',
    risk: 'low' as const,
    amount: null,
  };

  function approveOne(
    h: AuthorityHarness,
    n: number,
    actor = h.owner,
    choice = 'approve',
  ) {
    const m = missionWith(h, [{ title: `w${n}` }]);
    const decision = h.authority.decisions.create(
      ctx(h),
      decisionInput(
        [{ missionId: m.driver.id, packetId: m.ids[0] as string }],
        {
          dedupeKey: `k${n}`,
          request: spec,
        },
      ),
    ).decision;
    h.authority.decisions.answer(ctx(h, actor), decision.id, {
      version: 1,
      choice,
      note: null,
    });
    return decision.id;
  }

  it('propose a standing rule after three human approvals, and nothing more', () => {
    const { h } = setup();
    const ids = [approveOne(h, 1), approveOne(h, 2)];
    expect(h.authority.policy.listProposals('ws_test')).toEqual([]);
    ids.push(approveOne(h, 3));
    const [proposal] = h.authority.policy.listProposals('ws_test');
    expect(proposal).toMatchObject({
      status: 'pending',
      action: 'scope.extend',
      resource: 'repo:app',
      scope: 'infra',
      maxRisk: 'low',
      evidence: ids,
    });
    expect(h.authority.policy.listRules('ws_test')).toEqual([]);
    expect(
      h.authority.policy.authorize(
        request({ action: 'scope.extend', scope: 'infra' }),
      ).effect,
    ).toBe('deny');
  });

  it('do not count declines', () => {
    const { h } = setup();
    approveOne(h, 1);
    approveOne(h, 2);
    approveOne(h, 3, h.owner, 'decline');
    expect(h.authority.policy.listProposals('ws_test')).toEqual([]);
  });

  it('stop counting an approval the same decision later reversed', () => {
    const { h } = setup();
    const first = approveOne(h, 1);
    approveOne(h, 2);
    h.authority.decisions.answer(ctx(h, h.other), first, {
      version: 2,
      choice: 'decline',
      note: null,
    });
    approveOne(h, 3);
    expect(h.authority.policy.listProposals('ws_test')).toEqual([]);
    approveOne(h, 4);
    expect(h.authority.policy.listProposals('ws_test')).toHaveLength(1);
  });
});
