import type { GuardFailure } from './errors.js';
import type { MissionState } from './types.js';

export interface CompletionGuardContext {
  mission: MissionState;
  /** Missions whose `parentId` is this mission, in the same workspace. */
  children: readonly MissionState[];
}

export type GuardVerdict = { ok: true } | { ok: false; reason: string };

/**
 * A condition that must hold before a mission may move from `verifying` to `completed`.
 * Later tasks register their own, such as the required-issue check.
 */
export interface CompletionGuard {
  name: string;
  check(context: CompletionGuardContext): GuardVerdict;
}

const PASS: GuardVerdict = { ok: true };

/** Needs outcome evidence recorded by a verifier. A runner's success message is not evidence. */
export const outcomeVerifiedGuard: CompletionGuard = {
  name: 'outcome-verified',
  check({ mission }) {
    return mission.outcomeVerification !== null &&
      mission.outcomeVerification.evidenceRefs.length > 0
      ? PASS
      : { ok: false, reason: 'no verified outcome evidence is recorded' };
  },
};

export const definitionOfDoneGuard: CompletionGuard = {
  name: 'definition-of-done',
  check({ mission }) {
    const open = mission.definitionOfDone.filter((item) => !item.done).length;
    return open === 0
      ? PASS
      : { ok: false, reason: `${open} checklist item(s) are not done` };
  },
};

/** A packet counts only once Tower verified it. A runner's own report leaves it `reported`. */
export const requiredPacketsVerifiedGuard: CompletionGuard = {
  name: 'required-packets-verified',
  check({ mission }) {
    const open = mission.packets.filter(
      (p) => p.required && p.status !== 'verified',
    );
    return open.length === 0
      ? PASS
      : {
          ok: false,
          reason: `required work packets not verified: ${open.map((p) => p.id).join(', ')}`,
        };
  },
};

/**
 * A cancelled child is an explicit, recorded decision to drop that scope, so it does not
 * block the parent. The parent's own outcome verification still has to hold.
 */
export const requiredChildrenCompletedGuard: CompletionGuard = {
  name: 'required-children-completed',
  check({ children }) {
    const open = children.filter(
      (child) =>
        child.requiredForParent &&
        child.state !== 'completed' &&
        child.state !== 'cancelled',
    );
    return open.length === 0
      ? PASS
      : {
          ok: false,
          reason: `required child missions not completed: ${open.map((c) => c.id).join(', ')}`,
        };
  },
};

export const CORE_COMPLETION_GUARDS: readonly CompletionGuard[] = [
  outcomeVerifiedGuard,
  definitionOfDoneGuard,
  requiredPacketsVerifiedGuard,
  requiredChildrenCompletedGuard,
];

export interface CompletionGuardRegistry {
  register(guard: CompletionGuard): void;
  list(): readonly CompletionGuard[];
  /** Runs every guard, so the caller sees all failures at once. */
  evaluate(context: CompletionGuardContext): GuardFailure[];
}

export function createCompletionGuardRegistry(
  initial: readonly CompletionGuard[] = CORE_COMPLETION_GUARDS,
): CompletionGuardRegistry {
  const guards = new Map<string, CompletionGuard>();
  const registry: CompletionGuardRegistry = {
    register(guard) {
      if (guards.has(guard.name)) {
        throw new Error(`Completion guard ${guard.name} is already registered`);
      }
      guards.set(guard.name, guard);
    },
    list: () => [...guards.values()],
    evaluate(context) {
      const failures: GuardFailure[] = [];
      for (const guard of guards.values()) {
        // Fail closed: a guard that cannot be evaluated blocks completion.
        let verdict: GuardVerdict;
        try {
          verdict = guard.check(context);
        } catch {
          verdict = { ok: false, reason: 'the guard could not be evaluated' };
        }
        if (!verdict.ok) {
          failures.push({ guard: guard.name, reason: verdict.reason });
        }
      }
      return failures;
    },
  };
  for (const guard of initial) {
    registry.register(guard);
  }
  return registry;
}
