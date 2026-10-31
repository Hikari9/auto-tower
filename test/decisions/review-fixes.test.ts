import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../src/core/errors.js';
import { AuthorityForbiddenError } from '../../src/policy/errors.js';
import {
  type AuthorityHarness,
  createAuthorityHarness,
  decisionInput,
  expansion,
  grant,
  missionWith,
  packetStatus,
  revoke,
} from '../policy/helpers.js';

function setup() {
  const h = createAuthorityHarness();
  return { h, route: h.authority.routeExpansion, inbox: h.authority.decisions };
}

const STAGING = {
  action: 'deploy.staging',
  resource: 'repo:app',
  scope: 'env:staging',
  maxRisk: 'medium' as const,
};

function owner(h: AuthorityHarness) {
  return { workspaceId: 'ws_test', actor: h.owner };
}

describe('a Chief of Staff approves only what a rule names, for the packet it names', () => {
  it('does not take safe cleanup as an approval', () => {
    const { h, route } = setup();
    const m = missionWith(h, [{ title: 'prod work', scope: ['prod'] }]);
    const outcome = route(
      expansion(h, {
        requester: h.cos,
        missionId: m.driver.id,
        packetId: m.ids[0] as string,
        action: 'cleanup.wipe',
        resource: 'db:prod',
        scope: 'prod',
        risk: 'high',
      }),
    );
    expect(outcome.outcome).toBe('decision_required');
    expect(packetStatus(m.driver, m.ids[0] as string).authorized).toBe(false);
  });

  it('does not take safe cleanup as a delegation when a runner asks, or when a Chief of Staff answers', () => {
    const { h, route, inbox } = setup();
    const m = missionWith(h, [{ title: 'prod work', scope: ['prod'] }]);
    const asked = route(
      expansion(h, {
        requester: h.runner,
        missionId: m.driver.id,
        packetId: m.ids[0] as string,
        action: 'cleanup.wipe',
        resource: 'db:prod',
        scope: 'prod',
      }),
    );
    expect(asked).toMatchObject({
      outcome: 'decision_required',
      decision: { requiredAuthority: 'human' },
    });

    // Even a decision a person marked for the Chief of Staff cannot be answered on cleanup alone.
    const second = missionWith(h, [{ title: 'more', scope: ['prod'] }]);
    const raised = inbox.create(
      owner(h),
      decisionInput(
        [{ missionId: second.driver.id, packetId: second.ids[0] as string }],
        {
          dedupeKey: 'cleanup',
          requiredAuthority: 'chief_of_staff',
          request: {
            action: 'cleanup.wipe',
            resource: 'db:prod',
            scope: 'prod',
            risk: 'high',
            amount: null,
          },
        },
      ),
    ).decision;
    expect(() =>
      inbox.answer({ workspaceId: 'ws_test', actor: h.cos }, raised.id, {
        version: 1,
        choice: 'approve',
        note: null,
      }),
    ).toThrow(/needs a person, or a current delegated rule/);
    expect(
      packetStatus(second.driver, second.ids[0] as string).authorized,
    ).toBe(false);
  });

  it('refuses to authorize a packet whose declared scope the request does not cover', () => {
    const { h, route } = setup();
    grant(h, STAGING);
    const m = missionWith(h, [
      { title: 'ship to prod', scope: ['env:production'] },
    ]);
    const outcome = route(
      expansion(h, {
        requester: h.cos,
        missionId: m.driver.id,
        packetId: m.ids[0] as string,
        action: 'deploy.staging',
        resource: 'repo:app',
        scope: 'env:staging',
      }),
    );
    expect(outcome.outcome).toBe('decision_required');
    expect(packetStatus(m.driver, m.ids[0] as string).authorized).toBe(false);
  });

  it('will not approve a packet that declares no scope at all', () => {
    const { h, route } = setup();
    grant(h, STAGING);
    const m = missionWith(h, [{ title: 'unscoped' }]);
    const outcome = route(
      expansion(h, {
        requester: h.cos,
        missionId: m.driver.id,
        packetId: m.ids[0] as string,
        action: 'deploy.staging',
        resource: 'repo:app',
        scope: 'env:staging',
      }),
    );
    expect(outcome.outcome).toBe('decision_required');
  });

  it('does not raise a decision for a Chief of Staff when the packet does not match the claim', () => {
    const { h, route } = setup();
    grant(h, STAGING);
    const m = missionWith(h, [
      { title: 'ship to prod', scope: ['env:production'] },
    ]);
    const outcome = route(
      expansion(h, {
        requester: h.runner,
        missionId: m.driver.id,
        packetId: m.ids[0] as string,
        action: 'deploy.staging',
        resource: 'repo:app',
        scope: 'env:staging',
      }),
    );
    expect(outcome).toMatchObject({
      outcome: 'decision_required',
      decision: { requiredAuthority: 'human' },
    });
  });

  it('checks the packet again when a Chief of Staff answers', () => {
    const { h, inbox } = setup();
    grant(h, STAGING);
    const m = missionWith(h, [
      { title: 'ship to prod', scope: ['env:production'] },
    ]);
    const raised = inbox.create(
      owner(h),
      decisionInput(
        [{ missionId: m.driver.id, packetId: m.ids[0] as string }],
        {
          requiredAuthority: 'chief_of_staff',
          request: {
            action: 'deploy.staging',
            resource: 'repo:app',
            scope: 'env:staging',
            risk: 'low',
            amount: null,
          },
        },
      ),
    ).decision;
    expect(() =>
      inbox.answer({ workspaceId: 'ws_test', actor: h.cos }, raised.id, {
        version: 1,
        choice: 'approve',
        note: null,
      }),
    ).toThrow(/not covered by the request/);
    expect(packetStatus(m.driver, m.ids[0] as string).authorized).toBe(false);
  });
});

describe('tier 1 checks the packet and rejects paths that climb out of scope', () => {
  const ask = (
    h: AuthorityHarness,
    m: ReturnType<typeof missionWith>,
    scope: string,
  ) =>
    h.authority.routeExpansion(
      expansion(h, {
        missionId: m.driver.id,
        packetId: m.ids[1] as string,
        action: 'files.write',
        scope,
        risk: 'low',
      }),
    );

  it('does not treat a traversal as inside the authorized subtree', () => {
    const { h } = setup();
    const m = missionWith(h, [
      { title: 'base', scope: ['src/*'], authorized: true },
      { title: 'follow-up', scope: ['src/*'] },
    ]);
    expect(ask(h, m, 'src/utils')).toEqual({ tier: 1, outcome: 'proceed' });
    for (const scope of ['src/../../etc/secrets', 'src/..', 'src\\..\\x']) {
      expect(ask(h, m, scope).outcome, scope).toBe('decision_required');
    }
  });

  it('does not proceed when the packet itself declares more than was authorized', () => {
    const { h } = setup();
    const m = missionWith(h, [
      { title: 'base', scope: ['src/*'], authorized: true },
      { title: 'follow-up', scope: ['src/utils', 'infra/terraform'] },
    ]);
    expect(ask(h, m, 'src/utils').outcome).toBe('decision_required');
    const bare = missionWith(h, [
      { title: 'base', scope: ['src/*'], authorized: true },
      { title: 'follow-up' },
    ]);
    expect(ask(h, bare, 'src/utils').outcome).toBe('decision_required');
  });
});

describe('who raises a decision, and what its choices do', () => {
  it('holds a non-human request to a person', () => {
    const { h, inbox } = setup();
    const m = missionWith(h, [{ title: 'wait', scope: ['infra'] }]);
    const input = decisionInput(
      [{ missionId: m.driver.id, packetId: m.ids[0] as string }],
      { requiredAuthority: 'chief_of_staff' },
    );
    for (const actor of [h.cos, h.runner, h.provider]) {
      expect(() =>
        inbox.create({ workspaceId: 'ws_test', actor }, input),
      ).toThrow(AuthorityForbiddenError);
    }
    expect(inbox.list('ws_test', { status: 'all' })).toEqual([]);
    expect(() => inbox.create(owner(h), input)).not.toThrow();
  });

  it('keeps the meaning of the choices fixed for anyone but a person', () => {
    const { h, inbox } = setup();
    const m = missionWith(h, [{ title: 'one' }, { title: 'two' }]);
    const swapped = [
      {
        id: 'decline',
        label: 'Decline',
        description: null,
        consequence: null,
        resumes: true,
      },
      {
        id: 'approve',
        label: 'Approve',
        description: null,
        consequence: null,
        resumes: false,
      },
    ];
    const byCos = inbox.create(
      { workspaceId: 'ws_test', actor: h.cos },
      decisionInput(
        [{ missionId: m.driver.id, packetId: m.ids[0] as string }],
        {
          dedupeKey: 'by-cos',
          alternatives: swapped,
        },
      ),
    ).decision;
    expect(byCos.alternatives.map((a) => [a.id, a.resumes])).toEqual([
      ['decline', false],
      ['approve', true],
    ]);
    const byOwner = inbox.create(
      owner(h),
      decisionInput(
        [{ missionId: m.driver.id, packetId: m.ids[1] as string }],
        {
          dedupeKey: 'by-owner',
          alternatives: swapped,
        },
      ),
    ).decision;
    expect(byOwner.alternatives.map((a) => [a.id, a.resumes])).toEqual([
      ['decline', true],
      ['approve', false],
    ]);
  });

  it('keeps the same fixed meaning for a request a runner sends through the router', () => {
    const { h, route } = setup();
    const m = missionWith(h, [{ title: 'one' }]);
    const outcome = route({
      ...expansion(h, { missionId: m.driver.id, packetId: m.ids[0] as string }),
      alternatives: [
        {
          id: 'decline',
          label: 'Decline',
          description: null,
          consequence: null,
          resumes: true,
        },
        {
          id: 'approve',
          label: 'Approve',
          description: null,
          consequence: null,
          resumes: false,
        },
      ],
    });
    if (outcome.outcome !== 'decision_required') {
      throw new Error('expected a decision');
    }
    expect(outcome.decision.alternatives.map((a) => [a.id, a.resumes])).toEqual(
      [
        ['decline', false],
        ['approve', true],
      ],
    );
  });

  it('rejects a wildcard in the request a decision describes', () => {
    const { h, inbox } = setup();
    const m = missionWith(h, [{ title: 'one' }]);
    expect(() =>
      inbox.create(
        owner(h),
        decisionInput(
          [{ missionId: m.driver.id, packetId: m.ids[0] as string }],
          {
            request: {
              action: 'scope.extend',
              resource: 'repo:app*',
              scope: 'infra',
              risk: 'low',
              amount: null,
            },
          },
        ),
      ),
    ).toThrow(ValidationError);
  });
});

describe('answering when a branch cannot resume', () => {
  it('leaves the mission log and projection in step when a branch is skipped', () => {
    const { h, inbox } = setup();
    const m = missionWith(h, [{ title: 'one' }, { title: 'two' }]);
    const decision = inbox.create(
      owner(h),
      decisionInput([
        { missionId: m.driver.id, packetId: m.ids[0] as string },
        { missionId: m.driver.id, packetId: m.ids[1] as string },
      ]),
    ).decision;
    // The mission moves on to verifying while the packets still wait, which locks its breakdown.
    m.driver.go('verifying');
    const before = m.driver.refresh().version;
    const result = inbox.answer(owner(h), decision.id, {
      version: 1,
      choice: 'approve',
      note: null,
    });
    expect(result.branches.map((b) => b.status)).toEqual([
      'skipped',
      'skipped',
    ]);
    expect(result.branches[0]?.reason).toMatch(
      /verifying|not allowed|locked|breakdown|cannot/i,
    );

    // Nothing was appended to the mission, so the stream and its projection still agree.
    expect(h.core.missions.replayMission('ws_test', m.driver.id).version).toBe(
      before,
    );
    expect(m.driver.refresh().version).toBe(before);
    expect(
      m.driver.refresh().packets.every((p) => p.authorization === null),
    ).toBe(true);
    // And the mission is not wedged: the next command at the projected version goes through.
    expect(() => m.driver.go('needs-attention')).not.toThrow();
  });
});

describe('answer replays', () => {
  it('returns a Chief of Staff repeat as a replay even after the rule was revoked', () => {
    const { h, inbox } = setup();
    const rule = grant(h, {
      action: 'scope.extend',
      resource: 'repo:app',
      scope: 'infra',
    });
    const m = missionWith(h, [{ title: 'wait', scope: ['infra'] }]);
    const decision = inbox.raise(
      { workspaceId: 'ws_test', actor: h.runner },
      decisionInput(
        [{ missionId: m.driver.id, packetId: m.ids[0] as string }],
        {
          requiredAuthority: 'chief_of_staff',
          request: {
            action: 'scope.extend',
            resource: 'repo:app',
            scope: 'infra',
            risk: 'low',
            amount: null,
          },
        },
      ),
    ).decision;
    const cos = { workspaceId: 'ws_test', actor: h.cos };
    const answer = { version: 1, choice: 'approve', note: null };
    expect(inbox.answer(cos, decision.id, answer).applied).toBe(true);
    revoke(h, rule.id, 1);
    expect(inbox.answer(cos, decision.id, answer)).toMatchObject({
      replayed: true,
      applied: false,
    });
    expect(
      h.authority.policy.receipts('ws_test', { afterSeq: 0, limit: 10 }),
    ).toEqual([]);
    // A different answer at a new version is a new answer, and is checked.
    expect(() =>
      inbox.answer(cos, decision.id, {
        version: 2,
        choice: 'decline',
        note: null,
      }),
    ).toThrow();
  });
});

describe('a rejected request leaves no receipt', () => {
  it('writes nothing when the branch turns out not to be waiting', () => {
    const { h, route } = setup();
    const m = missionWith(h, [
      { title: 'base', scope: ['src/*'], authorized: true },
    ]);
    expect(() =>
      route(
        expansion(h, {
          missionId: m.driver.id,
          packetId: m.ids[0] as string,
          scope: 'infra',
        }),
      ),
    ).toThrow(ValidationError);
    expect(
      h.authority.policy.receipts('ws_test', { afterSeq: 0, limit: 10 }),
    ).toEqual([]);
  });
});
