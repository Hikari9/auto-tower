import { describe, expect, it } from 'vitest';
import {
  DedupeConflictError,
  DelegationRequiredError,
} from '../../src/decisions/index.js';
import { seedFixedPrincipal } from '../core/helpers.js';
import {
  type AuthorityHarness,
  createAuthorityHarness,
  decisionInput,
  expansion,
  grant,
  missionWith,
  packetStatus,
} from '../policy/helpers.js';

function setup() {
  const h = createAuthorityHarness();
  return { h, route: h.authority.routeExpansion, inbox: h.authority.decisions };
}

const owner = (h: AuthorityHarness) => ({
  workspaceId: 'ws_test',
  actor: h.owner,
});
const cosCtx = (h: AuthorityHarness) => ({
  workspaceId: 'ws_test',
  actor: h.cos,
});

describe('tier 1 counts only authorized packets of a live mission', () => {
  it('ignores the scope of a sibling that is still waiting for authorization', () => {
    const { h, route } = setup();
    const m = missionWith(h, [
      { title: 'base', scope: ['src/*'], authorized: true },
      { title: 'waiting sibling', scope: ['infra/*'] },
      { title: 'follow-up', scope: ['infra/terraform'] },
    ]);
    const outcome = route(
      expansion(h, {
        missionId: m.driver.id,
        packetId: m.ids[2] as string,
        action: 'files.write',
        scope: 'infra/terraform',
      }),
    );
    expect(outcome.outcome).toBe('decision_required');
  });

  it('does not proceed once the mission is verifying', () => {
    const { h, route } = setup();
    const m = missionWith(h, [
      { title: 'base', scope: ['src/*'], authorized: true },
      { title: 'follow-up', scope: ['src/utils'] },
    ]);
    const ask = () =>
      route(
        expansion(h, {
          missionId: m.driver.id,
          packetId: m.ids[1] as string,
          action: 'files.write',
          scope: 'src/utils',
        }),
      );
    expect(ask().outcome).toBe('proceed');
    m.driver.go('verifying');
    expect(ask().outcome).toBe('decision_required');
  });
});

describe('what makes two requests the same decision', () => {
  const spec = (amount: number, over: object = {}) => ({
    action: 'spend.compute',
    resource: 'account:main',
    scope: 'month:2026-03',
    risk: 'low' as const,
    amount,
    ...over,
  });

  it('refuses a key reused for a request that differs in any field', () => {
    const { h, inbox } = setup();
    const m = missionWith(h, [
      { title: 'a' },
      { title: 'b' },
      { title: 'c' },
      { title: 'd' },
      { title: 'e' },
    ]);
    const make = (i: number, request: ReturnType<typeof spec>) => () =>
      inbox.create(
        owner(h),
        decisionInput(
          [{ missionId: m.driver.id, packetId: m.ids[i] as string }],
          {
            category: 'spend',
            request,
          },
        ),
      );
    make(0, spec(100))();
    for (const [i, changed] of [
      spec(99_999),
      spec(100, { resource: 'account:other' }),
      spec(100, { scope: 'month:2026-04' }),
      spec(100, { risk: 'high' as const }),
    ].entries()) {
      expect(make(i + 1, changed), JSON.stringify(changed)).toThrow(
        DedupeConflictError,
      );
    }
    expect(inbox.list('ws_test')[0]?.links).toHaveLength(1);
    expect(make(4, spec(100))().linked).toHaveLength(1);
  });

  it('gives requests that differ in risk or amount different default keys', () => {
    const { h, route } = setup();
    const m = missionWith(h, [{ title: 'a' }, { title: 'b' }, { title: 'c' }]);
    const ask = (i: number, over: object) =>
      route(
        expansion(h, {
          missionId: m.driver.id,
          packetId: m.ids[i] as string,
          action: 'spend.compute',
          resource: 'account:main',
          scope: 'month:2026-03',
          amount: 10,
          ...over,
        }),
      );
    const ids = [
      ask(0, {}),
      ask(1, { risk: 'high' }),
      ask(2, { amount: 11 }),
    ].map((o) => (o.outcome === 'decision_required' ? o.decision.id : 'none'));
    expect(new Set(ids).size).toBe(3);
  });

  it('fills the category from the action and the affected scope from the request', () => {
    const { h, route } = setup();
    const cases = [
      ['spend.compute', 'spend', 5],
      ['deploy.production', 'production', null],
      ['security.disable-scan', 'security', null],
      ['repo.delete', 'destructive', null],
      ['issue.close', 'sensitive_action', null],
      ['scope.extend', 'scope_expansion', null],
    ] as const;
    const m = missionWith(
      h,
      cases.map((c) => ({ title: c[0] })),
    );
    cases.forEach(([action, category, amount], i) => {
      const outcome = route(
        expansion(h, {
          missionId: m.driver.id,
          packetId: m.ids[i] as string,
          action,
          amount,
          scope: 'area:x',
        }),
      );
      if (outcome.outcome !== 'decision_required') {
        throw new Error('expected a decision');
      }
      expect(outcome.decision.category, action).toBe(category);
      expect(outcome.decision.affectedScope).toEqual(['area:x']);
    });
  });
});

describe('a Chief of Staff answers only within every limit of the rule', () => {
  const REQUEST = {
    action: 'scope.extend',
    resource: 'repo:app',
    scope: 'infra',
    risk: 'low' as 'low' | 'medium' | 'high',
    amount: null as number | null,
  };

  let counter = 0;
  function raised(h: AuthorityHarness, request: typeof REQUEST, missions = 1) {
    const ms = Array.from({ length: missions }, () =>
      missionWith(h, [{ title: 'w', scope: ['infra'] }]),
    );
    const decision = h.authority.decisions.raise(
      { workspaceId: 'ws_test', actor: h.runner },
      decisionInput(
        ms.map((m) => ({
          missionId: m.driver.id,
          packetId: m.ids[0] as string,
        })),
        {
          dedupeKey: `raised-${++counter}`,
          requiredAuthority: 'chief_of_staff',
          request,
        },
      ),
    ).decision;
    return { ms, decision };
  }
  const answer = { version: 1, choice: 'approve', note: null };

  it('refuses when the request exceeds the amount cap', () => {
    const { h, inbox } = setup();
    grant(h, {
      action: 'scope.extend',
      resource: 'repo:app',
      scope: 'infra',
      limits: { maxAmount: 500, missionIds: null },
    });
    const over = raised(h, { ...REQUEST, amount: 5000 });
    expect(() => inbox.answer(cosCtx(h), over.decision.id, answer)).toThrow(
      DelegationRequiredError,
    );
    const [target] = over.ms as [(typeof over.ms)[number]];
    expect(
      packetStatus(target.driver, target.ids[0] as string).authorized,
    ).toBe(false);
    expect(
      h.authority.policy.receipts('ws_test', { afterSeq: 0, limit: 5 })[0]
        ?.code,
    ).toBe('no_matching_grant');
    const within = raised(h, { ...REQUEST, amount: 400 });
    expect(inbox.answer(cosCtx(h), within.decision.id, answer).applied).toBe(
      true,
    );
  });

  it('refuses when the request carries more risk than the rule covers', () => {
    const { h, inbox } = setup();
    grant(h, {
      action: 'scope.extend',
      resource: 'repo:app',
      scope: 'infra',
      maxRisk: 'low',
    });
    const risky = raised(h, { ...REQUEST, risk: 'high' });
    expect(() => inbox.answer(cosCtx(h), risky.decision.id, answer)).toThrow(
      DelegationRequiredError,
    );
  });

  it('refuses when a linked mission is outside the rule, and allows when all are inside', () => {
    const { h, inbox } = setup();
    const first = raised(h, REQUEST, 2);
    const ids = first.ms.map((m) => m.driver.id);
    grant(h, {
      action: 'scope.extend',
      resource: 'repo:app',
      scope: 'infra',
      limits: { maxAmount: null, missionIds: [ids[0] as string] },
    });
    expect(() => inbox.answer(cosCtx(h), first.decision.id, answer)).toThrow(
      DelegationRequiredError,
    );
    grant(h, {
      action: 'scope.extend',
      resource: 'repo:app',
      scope: 'infra',
      limits: { maxAmount: null, missionIds: ids },
    });
    expect(
      inbox.answer(cosCtx(h), first.decision.id, answer).branches,
    ).toHaveLength(2);
  });
});

describe('what counts toward a standing-rule proposal', () => {
  it('ignores approvals given by a Chief of Staff', () => {
    const { h, inbox } = setup();
    grant(h, { action: 'scope.extend', resource: 'repo:app', scope: 'infra' });
    const request = {
      action: 'scope.extend',
      resource: 'repo:app',
      scope: 'infra',
      risk: 'low' as const,
      amount: null,
    };
    for (let n = 0; n < 4; n++) {
      const m = missionWith(h, [{ title: 'w', scope: ['infra'] }]);
      const d = inbox.raise(
        { workspaceId: 'ws_test', actor: h.runner },
        decisionInput(
          [{ missionId: m.driver.id, packetId: m.ids[0] as string }],
          {
            dedupeKey: `k${n}`,
            requiredAuthority: 'chief_of_staff',
            request,
          },
        ),
      ).decision;
      inbox.answer(cosCtx(h), d.id, {
        version: 1,
        choice: 'approve',
        note: null,
      });
    }
    expect(h.authority.policy.listProposals('ws_test')).toEqual([]);
  });
});

describe('the audit of answers and the inbox across workspaces', () => {
  it('records whether each answer became the effective one', () => {
    const { h, inbox } = setup();
    const m = missionWith(h, [{ title: 'w' }]);
    const d = inbox.create(
      owner(h),
      decisionInput([{ missionId: m.driver.id, packetId: m.ids[0] as string }]),
    ).decision;
    inbox.answer(owner(h), d.id, { version: 2, choice: 'decline', note: null });
    inbox.answer(owner(h), d.id, { version: 1, choice: 'approve', note: null });
    const items = inbox.history('ws_test', d.id, {
      afterVersion: 0,
      limit: 10,
    }).items;
    expect(
      items.map((i) => (i.payload as { effective?: boolean }).effective),
    ).toEqual([undefined, true, false]);
    expect(items[2]?.payload).toMatchObject({
      effective: false,
      previousEffectiveVersion: 2,
    });
    const page = inbox.history('ws_test', d.id, { afterVersion: 0, limit: 2 });
    expect(page.nextAfterVersion).toBe(2);
    expect(
      inbox.history('ws_test', d.id, { afterVersion: 2, limit: 2 }).items,
    ).toHaveLength(1);
    expect(() =>
      inbox.history('ws_test', 'dec_nope', { afterVersion: 0, limit: 1 }),
    ).toThrow(/not found/);
  });

  it('keeps a dedupe key in one workspace from reaching another', () => {
    const { h, route } = setup();
    const foreign = seedFixedPrincipal(
      h.db,
      'prn_foreign_runner',
      'runner',
      'ws_elsewhere',
    );
    const mine = missionWith(h, [{ title: 'w' }]);
    const first = route(
      expansion(h, {
        missionId: mine.driver.id,
        packetId: mine.ids[0] as string,
      }),
    );
    const foreignHuman = seedFixedPrincipal(
      h.db,
      'prn_foreign_human',
      'human',
      'ws_elsewhere',
    );
    const other = {
      ...h,
      ctx: (actor = foreignHuman, extra = {}) => ({
        workspaceId: 'ws_elsewhere',
        actor,
        ...extra,
      }),
    } as AuthorityHarness;
    const theirs = missionWith(other, [{ title: 'w' }]);
    const second = h.authority.routeExpansion({
      ...expansion(h, {
        missionId: theirs.driver.id,
        packetId: theirs.ids[0] as string,
      }),
      workspaceId: 'ws_elsewhere',
      requester: foreign,
    });
    if (
      first.outcome !== 'decision_required' ||
      second.outcome !== 'decision_required'
    ) {
      throw new Error('expected decisions');
    }
    expect(second.created).toBe(true);
    expect(second.decision.id).not.toBe(first.decision.id);
    expect(second.decision.workspaceId).toBe('ws_elsewhere');
  });
});
