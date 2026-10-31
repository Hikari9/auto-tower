import type { CommandContext } from '../core/service.js';
import { isHalted } from '../ops/halt.js';
import { AuthorityForbiddenError } from '../policy/errors.js';
import type { PolicyService } from '../policy/service.js';
import type { SqlDatabase } from '../storage/database.js';
import { McpToolError } from './errors.js';
import type { Services } from './tool.js';

export const FEATURE_FLAGS = ['cloud_ai.triage', 'hosted_execution'] as const;
export type FeatureFlag = (typeof FEATURE_FLAGS)[number];

/** The action a delegated rule must allow before the flag can take effect. */
const FLAG_ACTION: Readonly<Record<FeatureFlag, string>> = {
  'cloud_ai.triage': 'cloud_ai.triage.run',
  hosted_execution: 'hosted_execution.run',
};

export function isFeatureFlag(value: unknown): value is FeatureFlag {
  return (
    typeof value === 'string' &&
    (FEATURE_FLAGS as readonly string[]).includes(value)
  );
}

export interface FlagApproval {
  providerId: string | null;
  budgetCents: number | null;
  policyRuleId: string | null;
}

export interface FlagState extends FlagApproval {
  flag: FeatureFlag;
  /** What a person last asked for. */
  requested: boolean;
  /** What is true now. Off unless every approval still holds. */
  enabled: boolean;
  /** Why a requested flag is not in effect, or null. */
  blockedBy: string[] | null;
  updatedAt: string | null;
}

interface FlagRow {
  flag: string;
  enabled: number;
  provider_id: string | null;
  budget_cents: number | null;
  policy_rule_id: string | null;
  updated_at: string;
}

/** One change to a flag, kept for good: who, from what, to what, under which rule, and when. */
export interface FlagChange {
  seq: number;
  flag: FeatureFlag;
  changedBy: string;
  oldEnabled: boolean | null;
  newEnabled: boolean;
  providerId: string | null;
  budgetCents: number | null;
  /** The rule the flag named after this change. */
  policyRuleId: string | null;
  oldPolicyRuleId: string | null;
  changedAt: string;
}

interface FlagChangeRow {
  seq: number;
  flag: string;
  changed_by: string;
  old_enabled: number | null;
  new_enabled: number;
  provider_id: string | null;
  budget_cents: number | null;
  policy_rule_id: string | null;
  old_policy_rule_id: string | null;
  changed_at: string;
}

export interface FlagServiceDeps {
  db: SqlDatabase;
  policy: PolicyService;
  /** Providers a person approved when deploying. */
  approvedProviders: readonly string[];
  now: () => Date;
}

export interface FlagService {
  read(workspaceId: string): FlagState[];
  /** Every change to the workspace's flags, oldest first, after `afterSeq`. */
  history(
    workspaceId: string,
    page: { afterSeq: number; limit: number },
  ): FlagChange[];
  /** True only while the flag is on and its provider, budget and policy all still hold. */
  isEnabled(workspaceId: string, flag: FeatureFlag): boolean;
  /**
   * Turns a flag on or off. Only a human may. Turning one on needs an approved provider, a
   * positive budget and an active delegated rule, and anything less is refused with the missing
   * pieces named and nothing stored.
   */
  set(
    ctx: Pick<CommandContext, 'workspaceId' | 'actor'>,
    input: { flag: FeatureFlag; enabled: boolean } & FlagApproval,
  ): FlagState;
}

export function createFlagService(deps: FlagServiceDeps): FlagService {
  const { db, policy } = deps;

  function unmet(
    workspaceId: string,
    flag: FeatureFlag,
    a: FlagApproval,
  ): string[] {
    const missing: string[] = [];
    if (
      a.providerId === null ||
      !deps.approvedProviders.includes(a.providerId)
    ) {
      missing.push('provider: not an approved provider');
    }
    if (
      a.budgetCents === null ||
      !Number.isInteger(a.budgetCents) ||
      a.budgetCents <= 0
    ) {
      missing.push('budget: needs a positive budget in cents');
    }
    const rule =
      a.policyRuleId === null
        ? undefined
        : policy
            .listRules(workspaceId, { status: 'active' })
            .find((r) => r.id === a.policyRuleId);
    if (rule === undefined || rule.effect !== 'allow') {
      missing.push('policy: needs an active allow rule');
    } else if (a.providerId !== null && a.budgetCents !== null) {
      // Only the named rule may grant. Another delegated rule that happens to cover the use does
      // not stand in for it, so revoking or narrowing the named rule switches the flag off.
      const evaluation = policy.authorizeDelegate(
        {
          workspace: workspaceId,
          action: FLAG_ACTION[flag],
          resource: `provider:${a.providerId}`,
          scope: 'workspace',
          risk: 'medium',
          amount: a.budgetCents,
        },
        { citing: rule.id },
      );
      if (evaluation.effect !== 'allow' || evaluation.code !== 'granted') {
        missing.push(
          `policy: the rule does not cover this use: ${evaluation.reason}`,
        );
      }
    }
    return missing;
  }

  function stateOf(
    workspaceId: string,
    flag: FeatureFlag,
    row: FlagRow | undefined,
  ): FlagState {
    if (row === undefined) {
      return {
        flag,
        requested: false,
        enabled: false,
        providerId: null,
        budgetCents: null,
        policyRuleId: null,
        blockedBy: null,
        updatedAt: null,
      };
    }
    const approval: FlagApproval = {
      providerId: row.provider_id,
      budgetCents: row.budget_cents,
      policyRuleId: row.policy_rule_id,
    };
    const requested = row.enabled === 1;
    const blockedBy = requested ? unmet(workspaceId, flag, approval) : [];
    // An emergency halt stops every guarded effect, which includes what a flag switches on.
    if (requested && isHalted(db, workspaceId)) {
      blockedBy.push('halt: the workspace is halted');
    }
    return {
      flag,
      requested,
      enabled: requested && blockedBy.length === 0,
      ...approval,
      blockedBy: requested && blockedBy.length > 0 ? blockedBy : null,
      updatedAt: row.updated_at,
    };
  }

  function row(workspaceId: string, flag: FeatureFlag): FlagRow | undefined {
    return db.get<FlagRow>(
      'SELECT flag, enabled, provider_id, budget_cents, policy_rule_id, updated_at FROM feature_flags WHERE workspace_id = ? AND flag = ?',
      [workspaceId, flag],
    );
  }

  return {
    read: (workspaceId) =>
      FEATURE_FLAGS.map((flag) =>
        stateOf(workspaceId, flag, row(workspaceId, flag)),
      ),
    history: (workspaceId, page) =>
      db
        .all<FlagChangeRow>(
          `SELECT seq, flag, changed_by, old_enabled, new_enabled, provider_id, budget_cents, policy_rule_id, old_policy_rule_id, changed_at
           FROM feature_flag_history WHERE workspace_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
          [workspaceId, page.afterSeq, page.limit],
        )
        .map((row) => ({
          seq: row.seq,
          flag: row.flag as FeatureFlag,
          changedBy: row.changed_by,
          oldEnabled: row.old_enabled === null ? null : row.old_enabled === 1,
          newEnabled: row.new_enabled === 1,
          providerId: row.provider_id,
          budgetCents: row.budget_cents,
          policyRuleId: row.policy_rule_id,
          oldPolicyRuleId: row.old_policy_rule_id,
          changedAt: row.changed_at,
        })),
    isEnabled: (workspaceId, flag) =>
      stateOf(workspaceId, flag, row(workspaceId, flag)).enabled,
    set(ctx, input) {
      if (ctx.actor.kind !== 'human') {
        throw new AuthorityForbiddenError(
          'change a feature flag',
          ctx.actor.kind,
        );
      }
      const approval: FlagApproval = {
        providerId: input.providerId,
        budgetCents: input.budgetCents,
        policyRuleId: input.policyRuleId,
      };
      if (input.enabled) {
        const missing = unmet(ctx.workspaceId, input.flag, approval);
        if (missing.length > 0) {
          throw new McpToolError(
            'flag_requires_approval',
            `${input.flag} cannot be turned on without an approved provider, a budget and a policy`,
            { missing },
          );
        }
      }
      const at = deps.now().toISOString();
      // The change and its history row commit together, so no change is ever unrecorded.
      db.transaction((tx) => {
        const before = tx.get<FlagRow>(
          'SELECT flag, enabled, provider_id, budget_cents, policy_rule_id, updated_at FROM feature_flags WHERE workspace_id = ? AND flag = ?',
          [ctx.workspaceId, input.flag],
        );
        // Turning a flag off keeps what was approved, so a person can see what it was running with.
        tx.run(
          `INSERT INTO feature_flags (workspace_id, flag, enabled, provider_id, budget_cents, policy_rule_id, updated_by, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (workspace_id, flag) DO UPDATE SET
             enabled = excluded.enabled,
             provider_id = COALESCE(excluded.provider_id, feature_flags.provider_id),
             budget_cents = COALESCE(excluded.budget_cents, feature_flags.budget_cents),
             policy_rule_id = COALESCE(excluded.policy_rule_id, feature_flags.policy_rule_id),
             updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
          [
            ctx.workspaceId,
            input.flag,
            input.enabled ? 1 : 0,
            approval.providerId,
            approval.budgetCents,
            approval.policyRuleId,
            ctx.actor.id,
            at,
          ],
        );
        const after = tx.get<FlagRow>(
          'SELECT flag, enabled, provider_id, budget_cents, policy_rule_id, updated_at FROM feature_flags WHERE workspace_id = ? AND flag = ?',
          [ctx.workspaceId, input.flag],
        );
        tx.run(
          `INSERT INTO feature_flag_history (workspace_id, flag, changed_by, old_enabled, new_enabled, provider_id, budget_cents, policy_rule_id, old_policy_rule_id, changed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            ctx.workspaceId,
            input.flag,
            ctx.actor.id,
            before === undefined ? null : before.enabled,
            input.enabled ? 1 : 0,
            after?.provider_id ?? null,
            after?.budget_cents ?? null,
            after?.policy_rule_id ?? null,
            before?.policy_rule_id ?? null,
            at,
          ],
        );
      });
      return stateOf(
        ctx.workspaceId,
        input.flag,
        row(ctx.workspaceId, input.flag),
      );
    },
  };
}

/** The flag service over a server's database, policy store and approved provider list. */
export function createFlagServiceFor(services: Services): FlagService {
  return createFlagService({
    db: services.db,
    policy: services.authority.policy,
    approvedProviders: services.settings.approvedAiProviders ?? [],
    now: services.now,
  });
}
