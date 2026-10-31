import { describe, expect, it } from 'vitest';
import {
  CommandNotAllowedError,
  MissionNotFoundError,
  ValidationError,
} from '../../src/core/errors.js';
import type { ExpansionOutcome } from '../../src/decisions/index.js';
import {
  type AuthorityHarness,
  createAuthorityHarness,
  expansion,
  grant,
  missionWith,
  packetStatus,
  revoke,
  ruleInput,
} from '../policy/helpers.js';

function setup() {
  const h = createAuthorityHarness();
  return { h, route: h.authority.routeExpansion };
}

/** A mission whose authorized base packet covers `src/*`, plus a follow-up waiting for authorization. */
function withFollowUp(
  h: AuthorityHarness,
  risk: 'low' | 'medium' | 'high' = 'medium',
  followUpScope: string[] = ['infra/*'],
) {
  const m = missionWith(
    h,
    [
      { title: 'base', scope: ['src/*'], authorized: true },
      { title: 'follow-up', scope: followUpScope },
    ],
    risk,
  );
  return { ...m, followUp: m.ids[1] as string, base: m.ids[0] as string };
}

const COVERS_INFRA = {
  action: 'scope.extend',
  resource: 'repo:app',
  scope: 'infra/*',
  maxRisk: 'medium' as const,
};

function expectDecision(outcome: ExpansionOutcome) {
  if (outcome.outcome !== 'decision_required') {
    throw new Error(`expected a decision, got ${outcome.outcome}`);
  }
  return outcome;
}

describe('tier 1: follow-up inside the approved scope', () => {
  it('proceeds without a decision, a receipt or any change to the mission', () => {
    const { h, route } = setup();
    const m = withFollowUp(h, 'medium', ['src/utils']);
    const version = m.driver.refresh().version;
    const outcome = route(
      expansion(h, {
        missionId: m.driver.id,
        packetId: m.followUp,
        scope: 'src/utils',
        risk: 'low',
      }),
    );
    expect(outcome).toEqual({ tier: 1, outcome: 'proceed' });
    expect(h.authority.decisions.list('ws_test', { status: 'all' })).toEqual(
      [],
    );
    expect(
      h.authority.policy.receipts('ws_test', { afterSeq: 0, limit: 10 }),
    ).toEqual([]);
    expect(m.driver.refresh().version).toBe(version);
  });

  it.each([
    ['a scope outside what was authorized', { scope: 'infra/terraform' }],
    [
      'more risk than the mission carries',
      { scope: 'src/utils', risk: 'high' as const },
    ],
    ['a sensitive action', { scope: 'src/utils', action: 'deploy.production' }],
    ['a destructive verb', { scope: 'src/utils', action: 'repo.delete' }],
    ['an amount', { scope: 'src/utils', amount: 5 }],
  ])('is not tier 1 for %s', (_name, overrides) => {
    const { h, route } = setup();
    const m = withFollowUp(h, 'medium', ['src/utils']);
    const outcome = route(
      expansion(h, {
        missionId: m.driver.id,
        packetId: m.followUp,
        ...overrides,
      }),
    );
    expect(outcome.outcome).toBe('decision_required');
    expect(packetStatus(m.driver, m.followUp).authorized).toBe(false);
  });

  it('does not let the follow-up vouch for itself or a bare wildcard count as scope', () => {
    const { h, route } = setup();
    const selfDeclared = withFollowUp(h, 'medium', ['infra/*']);
    expect(
      route(
        expansion(h, {
          missionId: selfDeclared.driver.id,
          packetId: selfDeclared.followUp,
          scope: 'infra/terraform',
        }),
      ).outcome,
    ).toBe('decision_required');

    const wildcard = missionWith(h, [
      { title: 'base', scope: ['*'], authorized: true },
      { title: 'follow-up' },
    ]);
    expect(
      route(
        expansion(h, {
          missionId: wildcard.driver.id,
          packetId: wildcard.ids[1] as string,
          scope: 'anything',
        }),
      ).outcome,
    ).toBe('decision_required');
  });

  it('is not decided on the requester say-so: nothing in the request says it is in scope', () => {
    const { h, route } = setup();
    const m = withFollowUp(h);
    const outcome = route(
      expansion(h, {
        missionId: m.driver.id,
        packetId: m.followUp,
        scope: 'infra/terraform',
        question: 'This is clearly in scope.',
        advisory: { confidencePercent: 100 },
      }),
    );
    expect(outcome.outcome).toBe('decision_required');
  });
});

describe('tier 2: a Chief of Staff under a delegated rule', () => {
  it('approves when a current rule covers the request, and cites it', () => {
    const { h, route } = setup();
    const m = withFollowUp(h);
    const rule = grant(h, COVERS_INFRA);
    const outcome = route(
      expansion(h, {
        requester: h.cos,
        missionId: m.driver.id,
        packetId: m.followUp,
        scope: 'infra/terraform',
      }),
    );
    expect(outcome).toMatchObject({
      tier: 2,
      outcome: 'approved',
      evaluation: { effect: 'allow', ruleId: rule.id, ruleVersion: 1 },
    });
    expect(h.authority.decisions.list('ws_test', { status: 'all' })).toEqual(
      [],
    );
    const events = h.core.missions.activity('ws_test', m.driver.id, {
      afterVersion: 0,
      limit: 50,
    }).items;
    expect(
      events.filter((e) => e.type === 'packet.authorized').pop(),
    ).toMatchObject({
      actorId: h.cos.id,
      policyRefs: [`policy:v1:rule:${rule.id}@1`],
    });
    expect(packetStatus(m.driver, m.followUp).authorized).toBe(true);
  });

  it.each([
    ['no rule at all', () => undefined],
    [
      'a rule for another resource',
      (h: AuthorityHarness) =>
        grant(h, { ...COVERS_INFRA, resource: 'repo:other' }),
    ],
    [
      'a rule for lower risk',
      (h: AuthorityHarness) => grant(h, { ...COVERS_INFRA, maxRisk: 'low' }),
    ],
    [
      'an expired rule',
      (h: AuthorityHarness) =>
        grant(h, { ...COVERS_INFRA, expiresAt: '2026-03-01T00:00:00.500Z' }),
    ],
    [
      'a revoked rule',
      (h: AuthorityHarness) => revoke(h, grant(h, COVERS_INFRA).id, 1),
    ],
    [
      'a rule for other missions',
      (h: AuthorityHarness) =>
        grant(h, {
          ...COVERS_INFRA,
          limits: { maxAmount: null, missionIds: ['msn_other'] },
        }),
    ],
    [
      'a rule held by someone else',
      (h: AuthorityHarness) =>
        grant(h, {
          ...COVERS_INFRA,
          grantee: { kind: null, principalId: h.runner.id },
        }),
    ],
  ])('goes to a person with %s', (name, arrange) => {
    const { h, route } = setup();
    const m = withFollowUp(h);
    arrange(h);
    h.clock.advance(1000);
    const outcome = expectDecision(
      route(
        expansion(h, {
          requester: h.cos,
          missionId: m.driver.id,
          packetId: m.followUp,
          scope: 'infra/terraform',
          risk: name === 'a rule for lower risk' ? 'medium' : 'low',
        }),
      ),
    );
    expect(outcome).toMatchObject({
      tier: 3,
      evaluation: { effect: 'escalate' },
    });
    expect(outcome.decision.requiredAuthority).toBe('human');
    expect(packetStatus(m.driver, m.followUp).authorized).toBe(false);
  });

  it('never lets confidence decide, in either direction', () => {
    const { h, route } = setup();
    const noRule = withFollowUp(h);
    const sure = expectDecision(
      route(
        expansion(h, {
          requester: h.cos,
          missionId: noRule.driver.id,
          packetId: noRule.followUp,
          advisory: { confidencePercent: 100 },
        }),
      ),
    );
    expect(sure.decision.advisory.confidencePercent).toBe(100);
    expect(packetStatus(noRule.driver, noRule.followUp).authorized).toBe(false);

    grant(h, COVERS_INFRA);
    const covered = withFollowUp(h);
    expect(
      route(
        expansion(h, {
          requester: h.cos,
          missionId: covered.driver.id,
          packetId: covered.followUp,
          scope: 'infra/terraform',
          advisory: { confidencePercent: 0 },
        }),
      ).outcome,
    ).toBe('approved');
  });

  it('keeps a sensitive expansion with a person unless a rule names it', () => {
    const { h, route } = setup();
    const spend = (m: ReturnType<typeof withFollowUp>, amount: number) =>
      route(
        expansion(h, {
          requester: h.cos,
          missionId: m.driver.id,
          packetId: m.followUp,
          action: 'spend.compute',
          resource: 'account:main',
          scope: 'month:2026-03',
          amount,
        }),
      );
    grant(h, {
      action: '*',
      resource: '*',
      scope: '*',
      maxRisk: 'high',
      limits: { maxAmount: 1_000_000, missionIds: null },
    });
    expect(
      spend(withFollowUp(h, 'medium', ['month:2026-03']), 10).outcome,
    ).toBe('decision_required');

    grant(h, {
      action: 'spend.compute',
      resource: 'account:main',
      scope: 'month:2026-03',
      limits: { maxAmount: 100, missionIds: null },
    });
    expect(
      spend(withFollowUp(h, 'medium', ['month:2026-03']), 100).outcome,
    ).toBe('approved');
    expect(
      spend(withFollowUp(h, 'medium', ['month:2026-03']), 101).outcome,
    ).toBe('decision_required');
  });

  it('is stopped by a deny rule, which no grant or answer overrides', () => {
    const { h, route } = setup();
    const m = withFollowUp(h);
    grant(h, COVERS_INFRA);
    const deny = h.authority.policy.createRule(
      h.ctx(h.owner),
      ruleInput({
        effect: 'deny',
        action: 'scope.extend',
        resource: '*',
        scope: 'infra/*',
        grantee: { kind: null, principalId: null },
      }),
    ).rule;
    const outcome = route(
      expansion(h, {
        requester: h.cos,
        missionId: m.driver.id,
        packetId: m.followUp,
        scope: 'infra/terraform',
      }),
    );
    expect(outcome).toMatchObject({
      tier: 'denied',
      outcome: 'denied',
      evaluation: { code: 'explicit_deny', ruleId: deny.id },
    });
    expect(h.authority.decisions.list('ws_test', { status: 'all' })).toEqual(
      [],
    );
    expect(packetStatus(m.driver, m.followUp).authorized).toBe(false);
    expect(
      h.authority.policy.receipts('ws_test', { afterSeq: 0, limit: 10 }),
    ).toMatchObject([
      { effect: 'deny', code: 'explicit_deny', ruleId: deny.id },
    ]);
  });

  it('does not approve a packet that is no longer waiting, and writes nothing', () => {
    const { h, route } = setup();
    const m = withFollowUp(h);
    grant(h, COVERS_INFRA);
    m.driver.authorize(m.followUp);
    const version = m.driver.refresh().version;
    expect(() =>
      route(
        expansion(h, {
          requester: h.cos,
          missionId: m.driver.id,
          packetId: m.followUp,
          scope: 'infra/terraform',
        }),
      ),
    ).toThrow(CommandNotAllowedError);
    expect(m.driver.refresh().version).toBe(version);
  });
});

describe('a runner or provider can ask but never approve', () => {
  it.each(['runner', 'provider'] as const)(
    'sends a %s request to the inbox even when it holds a grant',
    (who) => {
      const { h, route } = setup();
      const m = withFollowUp(h);
      grant(h, {
        ...COVERS_INFRA,
        grantee: { kind: null, principalId: h[who].id },
      });
      const outcome = expectDecision(
        route(
          expansion(h, {
            requester: h[who],
            missionId: m.driver.id,
            packetId: m.followUp,
            scope: 'infra/terraform',
          }),
        ),
      );
      expect(outcome.tier).toBe(3);
      expect(outcome.decision).toMatchObject({
        requiredAuthority: 'human',
        createdBy: h[who].id,
      });
      expect(packetStatus(m.driver, m.followUp).authorized).toBe(false);
    },
  );

  it('raises a decision a Chief of Staff can answer when a delegated rule covers it', () => {
    const { h, route } = setup();
    const m = withFollowUp(h);
    const rule = grant(h, COVERS_INFRA);
    const outcome = expectDecision(
      route(
        expansion(h, {
          requester: h.runner,
          missionId: m.driver.id,
          packetId: m.followUp,
          scope: 'infra/terraform',
        }),
      ),
    );
    expect(outcome.tier).toBe(2);
    expect(outcome.decision.requiredAuthority).toBe('chief_of_staff');
    expect(packetStatus(m.driver, m.followUp).authorized).toBe(false);

    const answered = h.authority.decisions.answer(
      { workspaceId: 'ws_test', actor: h.cos },
      outcome.decision.id,
      { version: 1, choice: 'approve', note: null },
    );
    expect(answered.branches).toMatchObject([{ status: 'resumed' }]);
    const events = h.core.missions.activity('ws_test', m.driver.id, {
      afterVersion: 0,
      limit: 50,
    }).items;
    expect(
      events.filter((e) => e.type === 'packet.authorized').pop()?.policyRefs,
    ).toEqual([
      `decision:${outcome.decision.id}@1`,
      `policy:v1:rule:${rule.id}@1`,
    ]);
  });

  it('stops the Chief of Staff path once the delegated rule is revoked before it answers', () => {
    const { h, route } = setup();
    const m = withFollowUp(h);
    const rule = grant(h, COVERS_INFRA);
    const outcome = expectDecision(
      route(
        expansion(h, {
          requester: h.runner,
          missionId: m.driver.id,
          packetId: m.followUp,
          scope: 'infra/terraform',
        }),
      ),
    );
    revoke(h, rule.id, 1);
    expect(() =>
      h.authority.decisions.answer(
        { workspaceId: 'ws_test', actor: h.cos },
        outcome.decision.id,
        { version: 1, choice: 'approve', note: null },
      ),
    ).toThrow();
    expect(packetStatus(m.driver, m.followUp).authorized).toBe(false);
  });
});

describe('only the branch that needs it blocks', () => {
  it('lets the rest of the mission keep running while one packet waits', () => {
    const { h, route } = setup();
    const m = withFollowUp(h);
    expectDecision(
      route(
        expansion(h, {
          missionId: m.driver.id,
          packetId: m.followUp,
          scope: 'infra/terraform',
        }),
      ),
    );
    h.pool.online = [h.runner.id];
    m.driver.tick();
    expect(packetStatus(m.driver, m.base).status).toBe('leased');
    expect(packetStatus(m.driver, m.followUp)).toEqual({
      status: 'pending',
      authorized: false,
    });
    expect(m.driver.refresh().state).toBe('running');
  });

  it('links several branches to one decision and resumes just those', () => {
    const { h, route } = setup();
    const one = withFollowUp(h);
    const two = withFollowUp(h);
    const bystander = withFollowUp(h);
    const ask = (m: typeof one, extra = {}) =>
      route(
        expansion(h, {
          missionId: m.driver.id,
          packetId: m.followUp,
          scope: 'infra/terraform',
          ...extra,
        }),
      );

    const first = expectDecision(ask(one));
    const second = expectDecision(
      ask(two, { question: 'Another wording of the same ask.' }),
    );
    expect(second.created).toBe(false);
    expect(second.decision.id).toBe(first.decision.id);
    expect(second.decision.links).toHaveLength(2);

    const other = expectDecision(ask(bystander, { scope: 'infra/network' }));
    expect(other.decision.id).not.toBe(first.decision.id);

    h.authority.decisions.answer(
      { workspaceId: 'ws_test', actor: h.owner },
      first.decision.id,
      { version: 1, choice: 'approve', note: null },
    );
    expect(packetStatus(one.driver, one.followUp).authorized).toBe(true);
    expect(packetStatus(two.driver, two.followUp).authorized).toBe(true);
    expect(packetStatus(bystander.driver, bystander.followUp).authorized).toBe(
      false,
    );
    expect(
      h.authority.decisions.get('ws_test', other.decision.id)?.status,
    ).toBe('open');
  });

  it('dedupes on the request itself, not on the requester wording', () => {
    const { h, route } = setup();
    const one = withFollowUp(h);
    const first = expectDecision(
      route(
        expansion(h, {
          missionId: one.driver.id,
          packetId: one.followUp,
          scope: 'infra/terraform',
        }),
      ),
    );
    const again = expectDecision(
      route(
        expansion(h, {
          missionId: one.driver.id,
          packetId: one.followUp,
          scope: 'infra/terraform',
          question: 'Asked a second time.',
        }),
      ),
    );
    expect(again).toMatchObject({ created: false });
    expect(again.decision.id).toBe(first.decision.id);
    expect(again.decision.links).toHaveLength(1);
  });
});

describe('receipts and refusals', () => {
  it('records that a request was sent to a person', () => {
    const { h, route } = setup();
    const m = withFollowUp(h);
    route(
      expansion(h, {
        missionId: m.driver.id,
        packetId: m.followUp,
        scope: 'infra/terraform',
      }),
    );
    expect(
      h.authority.policy.receipts('ws_test', { afterSeq: 0, limit: 10 }),
    ).toMatchObject([
      {
        principalId: h.runner.id,
        action: 'scope.extend',
        effect: 'escalate',
        code: 'no_matching_grant',
        missionId: m.driver.id,
      },
    ]);
  });

  it('refuses an unknown mission and a branch that is not waiting', () => {
    const { h, route } = setup();
    const m = withFollowUp(h);
    expect(() => route(expansion(h, { missionId: 'msn_nope' }))).toThrow(
      MissionNotFoundError,
    );
    expect(() =>
      route(
        expansion(h, {
          missionId: m.driver.id,
          packetId: m.base,
          scope: 'infra/terraform',
        }),
      ),
    ).toThrow(ValidationError);
    expect(h.authority.decisions.list('ws_test', { status: 'all' })).toEqual(
      [],
    );
    expect(
      h.authority.policy.receipts('ws_test', { afterSeq: 0, limit: 10 }),
    ).toEqual([]);
  });

  it('refuses a request from a disabled principal outright', () => {
    const { h, route } = setup();
    const m = withFollowUp(h);
    h.db.run('UPDATE principals SET disabled_at = ? WHERE id = ?', [
      '2026-01-01T00:00:00.000Z',
      h.runner.id,
    ]);
    const outcome = route(
      expansion(h, {
        missionId: m.driver.id,
        packetId: m.followUp,
        scope: 'infra/terraform',
      }),
    );
    expect(outcome).toMatchObject({
      outcome: 'denied',
      evaluation: { code: 'principal_disabled' },
    });
  });
});

describe('from repeated approvals to a standing rule', () => {
  it('lets a human accept the proposal, after which a Chief of Staff approves the same ask', () => {
    const { h, route } = setup();
    const ask = (requester = h.runner) => {
      // The rule the proposal becomes covers one directory at low risk, so the mission and its
      // packet stay inside that.
      const m = withFollowUp(h, 'low', ['infra/terraform']);
      const outcome = route(
        expansion(h, {
          requester,
          missionId: m.driver.id,
          packetId: m.followUp,
          scope: 'infra/terraform',
          // A different dedupe key each time, so each ask is its own decision.
          dedupeKey: `ask-${m.driver.id}`,
        }),
      );
      return { m, outcome };
    };
    for (let n = 0; n < 3; n++) {
      const { outcome } = ask();
      h.authority.decisions.answer(
        { workspaceId: 'ws_test', actor: h.owner },
        expectDecision(outcome).decision.id,
        { version: 1, choice: 'approve', note: null },
      );
    }
    const [proposal] = h.authority.policy.listProposals('ws_test', 'pending');
    expect(proposal).toBeDefined();
    // The fourth ask still goes to a person: a proposal is not authority.
    expect(expectDecision(ask(h.cos).outcome).tier).toBe(3);

    h.authority.policy.acceptProposal(
      h.ctx(h.owner),
      proposal?.id as string,
      null,
    );
    const { m, outcome } = ask(h.cos);
    expect(outcome).toMatchObject({ tier: 2, outcome: 'approved' });
    expect(packetStatus(m.driver, m.followUp).authorized).toBe(true);
  });
});
