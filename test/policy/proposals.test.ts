import { describe, expect, it } from 'vitest';
import {
  AuthorityForbiddenError,
  ProposalNotFoundError,
  RuleStateError,
  WideningError,
} from '../../src/policy/errors.js';
import { PROPOSAL_THRESHOLD } from '../../src/policy/service.js';
import { createAuthorityHarness, request } from './helpers.js';

function setup() {
  const h = createAuthorityHarness();
  return { h, policy: h.authority.policy };
}

interface Observed {
  action: string;
  resource: string;
  scope: string;
  risk: 'low' | 'medium' | 'high';
  amount: number | null;
}

const OBSERVED: Observed = {
  action: 'deploy.staging',
  resource: 'repo:app',
  scope: 'env:staging',
  risk: 'medium',
  amount: null,
};

function approve(
  h: ReturnType<typeof createAuthorityHarness>,
  n: number,
  overrides: Partial<Observed> = {},
) {
  return h.authority.policy.observeApproval('ws_test', {
    ...OBSERVED,
    ...overrides,
    decisionId: `dec_${n}`,
    approvedBy: h.owner.id,
    at: '2026-03-01T00:00:00.000Z',
  });
}

function proposeOnce(h: ReturnType<typeof createAuthorityHarness>) {
  let proposal: ReturnType<typeof approve>;
  for (let n = 1; n <= PROPOSAL_THRESHOLD; n++) {
    proposal = approve(h, n);
  }
  if (proposal === undefined) {
    throw new Error('no proposal was created');
  }
  return proposal;
}

describe('repeated approvals', () => {
  it('create one pending proposal at the threshold and authorize nothing', () => {
    const { h, policy } = setup();
    for (let n = 1; n < PROPOSAL_THRESHOLD; n++) {
      expect(approve(h, n)).toBeUndefined();
    }
    expect(policy.listProposals('ws_test')).toEqual([]);

    const proposal = approve(h, PROPOSAL_THRESHOLD);
    expect(proposal).toMatchObject({
      status: 'pending',
      action: 'deploy.staging',
      resource: 'repo:app',
      scope: 'env:staging',
      maxRisk: 'medium',
      granteeKind: 'chief_of_staff',
      approvals: PROPOSAL_THRESHOLD,
      evidence: ['dec_1', 'dec_2', 'dec_3'],
    });
    expect(policy.listRules('ws_test')).toEqual([]);
    expect(policy.policyVersion('ws_test')).toBe(0);
    expect(policy.authorize(request({ risk: 'medium' })).effect).toBe('deny');

    // More approvals do not stack a second proposal while one is open.
    expect(approve(h, 4)).toBeUndefined();
    expect(policy.listProposals('ws_test', 'pending')).toHaveLength(1);
  });

  it('count only the same request, not similar ones', () => {
    const { h, policy } = setup();
    approve(h, 1);
    approve(h, 2, { resource: 'repo:other' });
    approve(h, 3, { risk: 'high' });
    approve(h, 4, { scope: 'env:prod' });
    expect(policy.listProposals('ws_test')).toEqual([]);
  });

  it('keep the largest amount approved as the cap, and no more', () => {
    const { h, policy } = setup();
    approve(h, 1, { action: 'spend.compute', amount: 100 });
    approve(h, 2, { action: 'spend.compute', amount: 400 });
    const proposal = approve(h, 3, { action: 'spend.compute', amount: 250 });
    expect(proposal?.limits).toEqual({ maxAmount: 400, missionIds: null });
    expect(policy.listRules('ws_test')).toEqual([]);
  });

  it('stop counting an approval that a later answer replaced', () => {
    const { h, policy } = setup();
    approve(h, 1);
    approve(h, 2);
    policy.withdrawApproval('ws_test', 'dec_2', '2026-03-01T00:01:00.000Z');
    expect(approve(h, 3)).toBeUndefined();
    expect(approve(h, 4)?.approvals).toBe(3);
  });
});

describe('accepting a proposal', () => {
  it('creates exactly the approved grant and only now changes evaluation', () => {
    const { h, policy } = setup();
    const proposal = proposeOnce(h);
    const { proposal: resolved, rule } = policy.acceptProposal(
      h.ctx(h.owner),
      proposal.id,
      'ok',
    );
    expect(resolved).toMatchObject({
      status: 'accepted',
      resolvedBy: h.owner.id,
      resolutionNote: 'ok',
      resultingRuleId: rule.id,
    });
    expect(rule).toMatchObject({
      effect: 'allow',
      action: 'deploy.staging',
      resource: 'repo:app',
      scope: 'env:staging',
      maxRisk: 'medium',
      grantee: { kind: 'chief_of_staff', principalId: null },
      sourceProposalId: proposal.id,
      createdBy: h.owner.id,
    });
    expect(policy.authorize(request({ risk: 'medium' })).effect).toBe('allow');
    // It does not reach beyond what was approved.
    expect(policy.authorize(request({ risk: 'high' })).effect).toBe('deny');
    expect(policy.authorize(request({ resource: 'repo:other' })).effect).toBe(
      'deny',
    );
  });

  it('is recorded in authority history next to the grant it made', () => {
    const { h, policy } = setup();
    const proposal = proposeOnce(h);
    policy.acceptProposal(h.ctx(h.owner), proposal.id, null);
    const items = policy.history(
      'ws_test',
      { afterVersion: 0, limit: 50 },
      { proposalId: proposal.id },
    ).items;
    expect(items.map((i) => i.type)).toEqual([
      'policy.proposal.created',
      'policy.rule.created',
      'policy.proposal.resolved',
    ]);
  });

  it('can happen only once', () => {
    const { h, policy } = setup();
    const proposal = proposeOnce(h);
    policy.acceptProposal(h.ctx(h.owner), proposal.id, null);
    expect(() =>
      policy.acceptProposal(h.ctx(h.owner), proposal.id, null),
    ).toThrow(RuleStateError);
    expect(() =>
      policy.declineProposal(h.ctx(h.owner), proposal.id, null),
    ).toThrow(RuleStateError);
    expect(policy.listRules('ws_test')).toHaveLength(1);
  });

  it('refuses a proposal that does not exist', () => {
    const { h, policy } = setup();
    expect(() =>
      policy.acceptProposal(h.ctx(h.owner), 'prp_missing', null),
    ).toThrow(ProposalNotFoundError);
  });
});

describe('narrowing a proposal', () => {
  it('grants the narrower rule and keeps every other qualifier', () => {
    const { h, policy } = setup();
    const proposal = proposeOnce(h);
    const { proposal: resolved, rule } = policy.narrowProposal(
      h.ctx(h.owner),
      proposal.id,
      {
        maxRisk: 'low',
        granteePrincipalId: 'prn_cos',
        expiresAt: '2026-04-01T00:00:00.000Z',
        note: 'low risk only',
      },
    );
    expect(resolved.status).toBe('narrowed');
    expect(rule).toMatchObject({
      maxRisk: 'low',
      resource: 'repo:app',
      scope: 'env:staging',
      grantee: { kind: 'chief_of_staff', principalId: 'prn_cos' },
      expiresAt: '2026-04-01T00:00:00.000Z',
    });
    expect(policy.authorize(request({ risk: 'low' })).effect).toBe('allow');
    expect(policy.authorize(request({ risk: 'medium' })).effect).toBe('deny');
  });

  it.each([
    ['resource', { resource: 'repo:*' }],
    ['scope', { scope: '*' }],
    ['maxRisk', { maxRisk: 'high' as const }],
  ])('rejects a widened %s and creates nothing', (_field, narrowing) => {
    const { h, policy } = setup();
    const proposal = proposeOnce(h);
    expect(() =>
      policy.narrowProposal(h.ctx(h.owner), proposal.id, {
        ...narrowing,
        note: null,
      }),
    ).toThrow(WideningError);
    expect(policy.getProposal('ws_test', proposal.id)?.status).toBe('pending');
    expect(policy.listRules('ws_test')).toEqual([]);
  });

  it('rejects a larger amount cap and mission list than the proposal had', () => {
    const { h, policy } = setup();
    approve(h, 1, { action: 'spend.compute', amount: 100 });
    approve(h, 2, { action: 'spend.compute', amount: 100 });
    const proposal = approve(h, 3, { action: 'spend.compute', amount: 100 });
    expect(() =>
      policy.narrowProposal(h.ctx(h.owner), proposal?.id as string, {
        maxAmount: 101,
        note: null,
      }),
    ).toThrow(WideningError);
    const narrowed = policy.narrowProposal(
      h.ctx(h.owner),
      proposal?.id as string,
      {
        maxAmount: 50,
        missionIds: ['msn_a'],
        note: null,
      },
    );
    expect(narrowed.rule.limits).toEqual({
      maxAmount: 50,
      missionIds: ['msn_a'],
    });
  });

  it('refuses a named grantee from another workspace', () => {
    const { h, policy } = setup();
    const proposal = proposeOnce(h);
    expect(() =>
      policy.narrowProposal(h.ctx(h.owner), proposal.id, {
        granteePrincipalId: 'prn_nobody',
        note: null,
      }),
    ).toThrow();
    expect(policy.getProposal('ws_test', proposal.id)?.status).toBe('pending');
  });
});

describe('narrowing a wildcard proposal', () => {
  it('grants the narrower resource and scope that were asked for', () => {
    const { h, policy } = setup();
    // A proposal built straight from the service, whose qualifiers are patterns.
    for (let n = 1; n <= PROPOSAL_THRESHOLD; n++) {
      approve(h, n, { resource: 'repo:*', scope: 'env:*' });
    }
    const proposal = policy.listProposals('ws_test', 'pending')[0];
    const { rule } = policy.narrowProposal(
      h.ctx(h.owner),
      proposal?.id as string,
      {
        resource: 'repo:app',
        scope: 'env:staging',
        note: null,
      },
    );
    expect(rule).toMatchObject({ resource: 'repo:app', scope: 'env:staging' });
    expect(policy.authorize(request({ risk: 'medium' })).effect).toBe('allow');
    expect(
      policy.authorize(request({ risk: 'medium', resource: 'repo:other' }))
        .effect,
    ).toBe('deny');
  });
});

describe('declining a proposal', () => {
  it('grants nothing and is not proposed again', () => {
    const { h, policy } = setup();
    const proposal = proposeOnce(h);
    const declined = policy.declineProposal(h.ctx(h.owner), proposal.id, 'no');
    expect(declined).toMatchObject({
      status: 'declined',
      resolutionNote: 'no',
      resultingRuleId: null,
    });
    expect(policy.listRules('ws_test')).toEqual([]);
    expect(policy.authorize(request({ risk: 'medium' })).effect).toBe('deny');
    for (let n = 10; n < 20; n++) {
      expect(approve(h, n)).toBeUndefined();
    }
    expect(policy.listProposals('ws_test', 'pending')).toEqual([]);
  });

  it('is for a human only', () => {
    const { h, policy } = setup();
    const proposal = proposeOnce(h);
    for (const actor of [h.cos, h.runner, h.provider]) {
      expect(() =>
        policy.declineProposal(h.ctx(actor), proposal.id, null),
      ).toThrow(AuthorityForbiddenError);
    }
    expect(policy.getProposal('ws_test', proposal.id)?.status).toBe('pending');
  });
});
