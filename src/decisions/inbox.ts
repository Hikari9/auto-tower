import {
  CommandNotAllowedError,
  MissionNotFoundError,
  PacketNotFoundError,
  ValidationError,
} from '../core/errors.js';
import type { CompletionGuardRegistry } from '../core/guards.js';
import { loadMission } from '../core/projection.js';
import { createMissionService } from '../core/service.js';
import { MISSION_TRANSITIONS } from '../core/transitions.js';
import type { Actor, MissionState } from '../core/types.js';
import { createEventLog, type EventLog } from '../events/event-log.js';
import { AuthorityForbiddenError } from '../policy/errors.js';
import { hasTraversal } from '../policy/patterns.js';
import { createPolicyService } from '../policy/service.js';
import { joinTransaction } from '../policy/transaction.js';
import type { HistoryPage } from '../policy/types.js';
import { newId } from '../shared/ids.js';
import type { SqlDatabase } from '../storage/database.js';
import { packetCovers } from './binding.js';
import {
  AnswerConflictError,
  DecisionNotFoundError,
  DedupeConflictError,
  DelegationRequiredError,
} from './errors.js';
import type { AnswerInput, CreateDecisionInput } from './inputs.js';
import {
  loadAnswers,
  loadDecision,
  loadDecisions,
  openDecisionIdByKey,
} from './store.js';
import type {
  Branch,
  Decision,
  DecisionAnswer,
  DecisionLink,
  LinkStatus,
} from './types.js';

export interface DecisionContext {
  workspaceId: string;
  actor: Actor;
  correlationId?: string | undefined;
}

export interface CreateResult {
  decision: Decision;
  /** False when an open decision with the same dedupe key absorbed the request. */
  created: boolean;
  /** Branches this call linked, which were not linked before. */
  linked: Branch[];
}

export interface AnswerResult {
  decision: Decision;
  /** True when this answer is now the effective one. */
  applied: boolean;
  /** True when a higher version was already effective, so this one is history only. */
  superseded: boolean;
  /** True when the same answer at the same version had already been recorded. */
  replayed: boolean;
  /** What this answer did to each branch it touched. */
  branches: Array<Branch & { status: LinkStatus; reason: string | null }>;
}

export interface DecisionInboxDeps {
  db: SqlDatabase;
  /** The mission core's registry, so resuming a branch runs the same checks as any other command. */
  guards: CompletionGuardRegistry;
  clock?: () => Date;
  newId?: (prefix: string) => string;
}

export interface DecisionInbox {
  /**
   * Raises a decision that blocks the given branches, or links them to the open decision with the
   * same dedupe key. Only the named branches wait. Everything else keeps running.
   */
  create(ctx: DecisionContext, input: CreateDecisionInput): CreateResult;
  /**
   * Like `create`, for server-side code that has already settled who may answer, such as
   * `routeExpansion`. It takes `requiredAuthority` as given. Never call it with a caller's claim.
   */
  raise(ctx: DecisionContext, input: CreateDecisionInput): CreateResult;
  /**
   * Records an answer. Answers carry a version and the highest one is effective whatever order
   * they arrive in. An effective approval resumes the blocked branches linked to this decision
   * and no others.
   */
  answer(
    ctx: DecisionContext,
    decisionId: string,
    answer: AnswerInput,
  ): AnswerResult;
  get(workspaceId: string, id: string): Decision | undefined;
  /** Open items by urgency then age. Answered items most recent first. */
  list(
    workspaceId: string,
    filter?: { status?: 'open' | 'answered' | 'all'; limit?: number },
  ): Decision[];
  answers(workspaceId: string, id: string): DecisionAnswer[];
  history(
    workspaceId: string,
    id: string,
    page: { afterVersion: number; limit: number },
  ): HistoryPage;
}

const decisionStream = (id: string): string => `decision:${id}`;

export function createDecisionInbox(deps: DecisionInboxDeps): DecisionInbox {
  const { db, guards } = deps;
  const clock = deps.clock ?? (() => new Date());
  const ids = deps.newId ?? newId;

  function inTransaction<T>(fn: (tx: SqlDatabase, log: EventLog) => T): T {
    return db.transaction((tx) => {
      const joined = joinTransaction(tx);
      return fn(joined, createEventLog(joined, clock));
    });
  }

  function append(
    tx: SqlDatabase,
    log: EventLog,
    ctx: DecisionContext,
    decisionId: string,
    type: string,
    payload: unknown,
  ) {
    const streamId = decisionStream(decisionId);
    const current =
      tx.get<{ version: number }>(
        'SELECT COALESCE(MAX(version), 0) AS version FROM events WHERE workspace_id = ? AND stream_id = ?',
        [ctx.workspaceId, streamId],
      )?.version ?? 0;
    return log.append({
      workspaceId: ctx.workspaceId,
      streamId,
      expectedVersion: current,
      type,
      payload,
      actorId: ctx.actor.id,
      correlationId: ctx.correlationId ?? ids('cor'),
    }).event;
  }

  /** A branch can only wait if it exists and is a packet still waiting for authorization. */
  function checkBranch(
    tx: SqlDatabase,
    workspaceId: string,
    branch: Branch,
  ): void {
    const mission = loadMission(tx, workspaceId, branch.missionId);
    if (mission === undefined) {
      throw new MissionNotFoundError(branch.missionId);
    }
    if (branch.packetId === null) {
      return;
    }
    const packet = mission.packets.find((p) => p.id === branch.packetId);
    if (packet === undefined) {
      throw new PacketNotFoundError(branch.packetId);
    }
    if (packet.status !== 'pending' || packet.authorization !== null) {
      throw new ValidationError([
        {
          path: 'branches',
          message: `packet ${packet.id} is not waiting for authorization (it is ${packet.status})`,
        },
      ]);
    }
  }

  function insertLink(
    tx: SqlDatabase,
    workspaceId: string,
    decisionId: string,
    branch: Branch,
    at: string,
  ): boolean {
    const packetId = branch.packetId ?? '';
    const exists = tx.get(
      'SELECT 1 AS found FROM decision_links WHERE workspace_id = ? AND decision_id = ? AND mission_id = ? AND packet_id = ?',
      [workspaceId, decisionId, branch.missionId, packetId],
    );
    if (exists !== undefined) {
      return false;
    }
    tx.run(
      `INSERT INTO decision_links (workspace_id, decision_id, mission_id, packet_id, status, linked_at)
       VALUES (?, ?, ?, ?, 'blocked', ?)`,
      [workspaceId, decisionId, branch.missionId, packetId, at],
    );
    return true;
  }

  /** The same question under the same key. A key must not be used to hang a different request on an open decision. */
  function sameSubject(
    existing: Decision,
    input: CreateDecisionInput,
  ): boolean {
    return (
      existing.category === input.category &&
      JSON.stringify(existing.request) === JSON.stringify(input.request) &&
      (input.request !== null || existing.question === input.question)
    );
  }

  function touch(
    tx: SqlDatabase,
    workspaceId: string,
    decisionId: string,
    version: number,
  ): void {
    tx.run(
      'UPDATE decisions SET version = ? WHERE workspace_id = ? AND id = ?',
      [version, workspaceId, decisionId],
    );
  }

  function requireDecision(
    tx: SqlDatabase,
    workspaceId: string,
    id: string,
  ): Decision {
    const decision = loadDecision(tx, workspaceId, id);
    if (decision === undefined) {
      throw new DecisionNotFoundError(id);
    }
    return decision;
  }

  /**
   * Lets one linked branch proceed by authorizing its packet as the answerer, citing the decision.
   * Returns why a branch could not resume instead of failing, so one stale branch never undoes
   * the resumption of the others.
   */
  function resumeBranch(
    tx: SqlDatabase,
    ctx: DecisionContext,
    link: DecisionLink,
    policyRefs: string[],
  ): { status: 'resumed' | 'skipped'; reason: string | null } {
    if (link.packetId === null) {
      return { status: 'resumed', reason: null };
    }
    const mission: MissionState | undefined = loadMission(
      tx,
      ctx.workspaceId,
      link.missionId,
    );
    if (mission === undefined) {
      return { status: 'skipped', reason: 'the mission no longer exists' };
    }
    const packet = mission.packets.find((p) => p.id === link.packetId);
    if (packet === undefined) {
      return { status: 'skipped', reason: 'the packet no longer exists' };
    }
    if (packet.status !== 'pending' || packet.authorization !== null) {
      return {
        status: 'skipped',
        reason: `the packet is already ${packet.authorization === null ? packet.status : 'authorized'}`,
      };
    }
    // The core appends an event before it checks the command, and relies on the transaction rolling
    // back when a check fails. Inside this shared transaction that rollback would take the whole
    // answer with it, so the attempt gets a savepoint of its own.
    tx.exec('SAVEPOINT resume_branch');
    try {
      createMissionService({ db: tx, guards, clock }).authorizePacket(
        {
          workspaceId: ctx.workspaceId,
          actor: ctx.actor,
          ...(ctx.correlationId === undefined
            ? {}
            : { correlationId: ctx.correlationId }),
        },
        link.missionId,
        mission.version,
        link.packetId,
        policyRefs,
      );
      tx.exec('RELEASE resume_branch');
    } catch (error) {
      let restored = true;
      try {
        tx.exec('ROLLBACK TO resume_branch');
        tx.exec('RELEASE resume_branch');
      } catch {
        // The transaction itself is gone, or the savepoint could not be undone.
        restored = false;
      }
      // A branch is only skipped once the attempt was fully undone. Otherwise the whole answer
      // fails with the original error, and the surrounding transaction rolls everything back.
      if (restored && error instanceof CommandNotAllowedError) {
        return { status: 'skipped', reason: error.reason };
      }
      throw error;
    }
    return { status: 'resumed', reason: null };
  }

  /** Moves a live mission to needs-attention. A mission already there, cancelled or gone is left alone. */
  function flagMission(
    tx: SqlDatabase,
    ctx: DecisionContext,
    missionId: string,
    reason: string,
  ): void {
    const mission = loadMission(tx, ctx.workspaceId, missionId);
    if (
      mission === undefined ||
      !MISSION_TRANSITIONS[mission.state].includes('needs-attention')
    ) {
      return;
    }
    createMissionService({ db: tx, guards, clock }).transitionMission(
      {
        workspaceId: ctx.workspaceId,
        actor: ctx.actor,
        ...(ctx.correlationId === undefined
          ? {}
          : { correlationId: ctx.correlationId }),
      },
      missionId,
      mission.version,
      'needs-attention',
      reason,
    );
  }

  function setLink(
    tx: SqlDatabase,
    workspaceId: string,
    decisionId: string,
    link: DecisionLink,
    status: LinkStatus,
    reason: string | null,
    answerVersion: number,
    at: string,
  ): void {
    tx.run(
      `UPDATE decision_links SET status = ?, reason = ?, resolved_at = ?, resolved_by_answer_version = ?
       WHERE workspace_id = ? AND decision_id = ? AND mission_id = ? AND packet_id = ?`,
      [
        status,
        reason,
        at,
        answerVersion,
        workspaceId,
        decisionId,
        link.missionId,
        link.packetId ?? '',
      ],
    );
  }

  /**
   * Only a person decides who may answer a decision they did not raise through the router, and
   * what each choice does. Anyone else's request is held to a person.
   */
  function requireHumanAuthority(
    ctx: DecisionContext,
    input: CreateDecisionInput,
  ): void {
    if (ctx.actor.kind !== 'human' && input.requiredAuthority !== 'human') {
      throw new AuthorityForbiddenError(
        'choose who may answer a decision',
        ctx.actor.kind,
      );
    }
  }

  /** For anyone but a person, `approve` resumes and no other choice does. */
  function withFixedChoices(
    ctx: DecisionContext,
    input: CreateDecisionInput,
  ): CreateDecisionInput {
    return ctx.actor.kind === 'human'
      ? input
      : {
          ...input,
          alternatives: input.alternatives.map((a) => ({
            ...a,
            resumes: a.id === 'approve',
          })),
        };
  }

  function createDecision(
    ctx: DecisionContext,
    raw: CreateDecisionInput,
  ): CreateResult {
    {
      const input = withFixedChoices(ctx, raw);
      const at = clock().toISOString();
      return inTransaction((tx, log) => {
        for (const key of ['resource', 'scope'] as const) {
          const value = input.request?.[key];
          if (
            value !== undefined &&
            (value.includes('*') || hasTraversal(value))
          ) {
            throw new ValidationError([
              {
                path: `request.${key}`,
                message: 'must name one thing, without * or ..',
              },
            ]);
          }
        }
        const seen = new Set<string>();
        for (const branch of input.branches) {
          const key = `${branch.missionId}\0${branch.packetId ?? ''}`;
          if (seen.has(key)) {
            throw new ValidationError([
              { path: 'branches', message: 'lists a branch more than once' },
            ]);
          }
          seen.add(key);
          checkBranch(tx, ctx.workspaceId, branch);
        }

        const openId = openDecisionIdByKey(
          tx,
          ctx.workspaceId,
          input.dedupeKey,
        );
        if (openId !== undefined) {
          const existing = requireDecision(tx, ctx.workspaceId, openId);
          if (!sameSubject(existing, input)) {
            throw new DedupeConflictError(input.dedupeKey);
          }
          const linked = input.branches.filter((branch) =>
            insertLink(tx, ctx.workspaceId, openId, branch, at),
          );
          if (linked.length > 0) {
            const event = append(tx, log, ctx, openId, 'decision.linked', {
              branches: linked,
              at,
            });
            touch(tx, ctx.workspaceId, openId, event.version);
          }
          return {
            decision: requireDecision(tx, ctx.workspaceId, openId),
            created: false,
            linked,
          };
        }

        const id = ids('dec');
        const recommendation =
          input.recommendation === null
            ? null
            : { ...input.recommendation, by: ctx.actor.id };
        const event = append(tx, log, ctx, id, 'decision.created', {
          dedupeKey: input.dedupeKey,
          category: input.category,
          urgency: input.urgency,
          question: input.question,
          alternatives: input.alternatives,
          recommendation,
          consequences: input.consequences,
          requiredAuthority: input.requiredAuthority,
          evidence: input.evidence,
          affectedScope: input.affectedScope,
          request: input.request,
          advisory: input.advisory,
          branches: input.branches,
          at,
        });
        tx.run(
          `INSERT INTO decisions (workspace_id, id, version, created_seq, status, dedupe_key, category, urgency, question, alternatives_json, recommendation_json, consequences, required_authority, evidence_json, affected_scope_json, request_json, advisory_json, created_by, created_at)
           VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            ctx.workspaceId,
            id,
            event.version,
            event.seq,
            input.dedupeKey,
            input.category,
            input.urgency,
            input.question,
            JSON.stringify(input.alternatives),
            recommendation === null ? null : JSON.stringify(recommendation),
            input.consequences,
            input.requiredAuthority,
            JSON.stringify(input.evidence),
            JSON.stringify(input.affectedScope),
            input.request === null ? null : JSON.stringify(input.request),
            JSON.stringify(input.advisory),
            ctx.actor.id,
            at,
          ],
        );
        for (const branch of input.branches) {
          insertLink(tx, ctx.workspaceId, id, branch, at);
        }
        return {
          decision: requireDecision(tx, ctx.workspaceId, id),
          created: true,
          linked: [...input.branches],
        };
      });
    }
  }

  const inbox: DecisionInbox = {
    create(ctx, input) {
      requireHumanAuthority(ctx, input);
      return createDecision(ctx, input);
    },
    raise: createDecision,

    answer(ctx, decisionId, answer) {
      if (ctx.actor.kind !== 'human' && ctx.actor.kind !== 'chief_of_staff') {
        throw new AuthorityForbiddenError('answer a decision', ctx.actor.kind);
      }
      const outcome = inTransaction((tx, log): AnswerResult | Refusal => {
        const decision = requireDecision(tx, ctx.workspaceId, decisionId);
        const alternative = decision.alternatives.find(
          (a) => a.id === answer.choice,
        );
        if (alternative === undefined) {
          throw new ValidationError([
            { path: 'choice', message: 'is not one of the alternatives' },
          ]);
        }
        // A repeat of an answer that was already accepted is returned as it was, even if the
        // answerer's delegation has changed since. Only the answerer gets that: anyone else is
        // checked first, so a repeat cannot be used to read another principal's answer.
        const prior = loadAnswers(tx, ctx.workspaceId, decisionId);
        const same = prior.find((a) => a.version === answer.version);
        if (same !== undefined && same.answeredBy === ctx.actor.id) {
          if (same.choice !== answer.choice || same.note !== answer.note) {
            throw new AnswerConflictError(decisionId, answer.version);
          }
          return {
            decision,
            applied: false,
            superseded: false,
            replayed: true,
            branches: [],
          };
        }

        const authority = answererAuthority(tx, ctx, decision);
        if ('refused' in authority) {
          return authority;
        }
        if (same !== undefined) {
          // Authorized, but not the principal who answered at this version.
          if (same.choice !== answer.choice || same.note !== answer.note) {
            throw new AnswerConflictError(decisionId, answer.version);
          }
          return {
            decision,
            applied: false,
            superseded: false,
            replayed: true,
            branches: [],
          };
        }

        const at = clock().toISOString();
        tx.run(
          `INSERT INTO decision_answers (workspace_id, decision_id, version, choice, note, answered_by, answered_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            ctx.workspaceId,
            decisionId,
            answer.version,
            answer.choice,
            answer.note,
            ctx.actor.id,
            at,
          ],
        );

        const previous = decision.effectiveAnswer;
        const effective =
          previous === null || answer.version > previous.version;
        const branches: AnswerResult['branches'] = [];
        if (effective) {
          const refs = [
            `decision:${decisionId}@${answer.version}`,
            ...authority.policyRefs,
          ];
          for (const link of decision.links) {
            if (link.status === 'resumed' && !alternative.resumes) {
              // A branch already resumed under an earlier approval keeps its authorized packet,
              // which this answer cannot take back. A person has to look at the mission.
              const reason = `answered "${answer.choice}" at version ${answer.version} after an approval`;
              flagMission(tx, ctx, link.missionId, reason);
              setLink(
                tx,
                ctx.workspaceId,
                decisionId,
                link,
                'declined',
                reason,
                answer.version,
                at,
              );
              branches.push({
                missionId: link.missionId,
                packetId: link.packetId,
                status: 'declined',
                reason,
              });
              continue;
            }
            if (link.status !== 'blocked' && link.status !== 'declined') {
              continue;
            }
            const result = alternative.resumes
              ? resumeBranch(tx, ctx, link, refs)
              : {
                  status: 'declined' as const,
                  reason: `answered "${answer.choice}"`,
                };
            setLink(
              tx,
              ctx.workspaceId,
              decisionId,
              link,
              result.status,
              result.reason,
              answer.version,
              at,
            );
            branches.push({
              missionId: link.missionId,
              packetId: link.packetId,
              status: result.status,
              reason: result.reason,
            });
          }
          tx.run(
            `UPDATE decisions SET status = 'answered', effective_answer_version = ?, effective_choice = ?, answered_by = ?, answered_at = ?
             WHERE workspace_id = ? AND id = ?`,
            [
              answer.version,
              answer.choice,
              ctx.actor.id,
              at,
              ctx.workspaceId,
              decisionId,
            ],
          );
          trackApproval(tx, ctx, decision, alternative.resumes, previous, at);
        }
        const event = append(tx, log, ctx, decisionId, 'decision.answered', {
          answer: { ...answer, at },
          effective,
          previousEffectiveVersion: previous?.version ?? null,
          branches,
        });
        touch(tx, ctx.workspaceId, decisionId, event.version);
        return {
          decision: requireDecision(tx, ctx.workspaceId, decisionId),
          applied: effective,
          superseded: !effective,
          replayed: false,
          branches,
        };
      });
      if ('refused' in outcome) {
        // Recorded after the transaction, so the receipt is kept although the answer is refused.
        outcome.record();
        throw new DelegationRequiredError(decisionId, outcome.reason);
      }
      return outcome;
    },

    get: (workspaceId, id) => loadDecision(db, workspaceId, id),

    list: (workspaceId, filter) =>
      loadDecisions(db, workspaceId, {
        status: filter?.status ?? 'open',
        limit: filter?.limit ?? 50,
      }),

    answers: (workspaceId, id) => loadAnswers(db, workspaceId, id),

    history(workspaceId, id, { afterVersion, limit }) {
      if (loadDecision(db, workspaceId, id) === undefined) {
        throw new DecisionNotFoundError(id);
      }
      const events = createEventLog(db)
        .readStream(workspaceId, decisionStream(id))
        .filter((event) => event.version > afterVersion);
      const page = events.slice(0, limit);
      const last = page[page.length - 1];
      return {
        items: page.map((event) => ({
          version: event.version,
          seq: event.seq,
          type: event.type,
          actorId: event.actorId,
          correlationId: event.correlationId,
          recordedAt: event.recordedAt,
          payload: event.payload,
        })),
        nextAfterVersion:
          last !== undefined && events.length > page.length
            ? last.version
            : null,
      };
    },
  };

  interface Refusal {
    refused: true;
    reason: string;
    record(): void;
  }

  /**
   * A person answers any decision. A Chief of Staff answers only a decision raised for one, and
   * only while a delegated rule that is current right now covers the request behind it.
   */
  function answererAuthority(
    tx: SqlDatabase,
    ctx: DecisionContext,
    decision: Decision,
  ): { policyRefs: string[] } | Refusal {
    if (ctx.actor.kind === 'human') {
      return { policyRefs: [] };
    }
    const refuse = (
      reason: string,
      record: () => void = () => {},
    ): Refusal => ({
      refused: true,
      reason,
      record,
    });
    if (decision.requiredAuthority !== 'chief_of_staff') {
      return refuse('it needs a person');
    }
    const { request } = decision;
    if (request === null) {
      return refuse('it carries no request to check against a rule');
    }
    // The request on the decision is a claim. Each branch's packet has to declare a scope that
    // covers it, so a narrow rule cannot be used to approve unrelated work.
    for (const link of decision.links) {
      const packet =
        link.packetId === null
          ? undefined
          : loadMission(tx, ctx.workspaceId, link.missionId)?.packets.find(
              (p) => p.id === link.packetId,
            );
      if (
        link.packetId !== null &&
        link.status !== 'resumed' &&
        (packet === undefined || !packetCovers(packet, request.scope))
      ) {
        return refuse(
          `the scope of packet ${link.packetId} is not covered by the request`,
        );
      }
    }
    const policy = createPolicyService({ db: tx, clock, newId: ids });
    const missions = [...new Set(decision.links.map((l) => l.missionId))];
    const policyRefs: string[] = [];
    for (const missionId of missions.length > 0 ? missions : [undefined]) {
      const evaluationRequest = {
        workspace: ctx.workspaceId,
        principal: ctx.actor.id,
        action: request.action,
        resource: request.resource,
        scope: request.scope,
        risk: request.risk,
        amount: request.amount ?? undefined,
        missionId,
      };
      const evaluation = policy.authorize(evaluationRequest);
      // Safe cleanup is allowed without a rule, and is not an approval.
      if (evaluation.effect !== 'allow' || evaluation.code !== 'granted') {
        return refuse(evaluation.reason, () =>
          createPolicyService({ db, clock, newId: ids }).record(
            evaluationRequest,
            evaluation,
          ),
        );
      }
      policyRefs.push(evaluation.policyRef);
    }
    return { policyRefs: [...new Set(policyRefs)] };
  }

  /** A human approval of a described request counts toward a proposal. A changed answer stops counting. */
  function trackApproval(
    tx: SqlDatabase,
    ctx: DecisionContext,
    decision: Decision,
    resumes: boolean,
    previous: Decision['effectiveAnswer'],
    at: string,
  ): void {
    const policy = createPolicyService({ db: tx, clock, newId: ids });
    const { request } = decision;
    if (resumes && ctx.actor.kind === 'human' && request !== null) {
      policy.observeApproval(ctx.workspaceId, {
        decisionId: decision.id,
        action: request.action,
        resource: request.resource,
        scope: request.scope,
        risk: request.risk,
        amount: request.amount,
        approvedBy: ctx.actor.id,
        at,
      });
    } else if (!resumes && previous !== null) {
      policy.withdrawApproval(ctx.workspaceId, decision.id, at);
    }
  }

  return inbox;
}
