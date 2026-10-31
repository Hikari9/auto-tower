import type { Decision } from '../core/commands.js';
import {
  CommandNotAllowedError,
  ForbiddenActorError,
  MissionNotFoundError,
  ValidationError,
} from '../core/errors.js';
import type { Core } from '../core/index.js';
import type { CommandContext, CommandResult } from '../core/service.js';
import { assertMissionTransition } from '../core/transitions.js';
import type {
  Actor,
  IssueLinkRef,
  LinkClassification,
  MissionState,
  MissionStatus,
  Risk,
} from '../core/types.js';
import { PolicyDeniedError } from '../policy/errors.js';
import type { PolicyService } from '../policy/service.js';
import { newId } from '../shared/ids.js';
import type { SqlDatabase } from '../storage/database.js';
import {
  DiscrepancyNotFoundError,
  IssueForbiddenError,
  IssueLinkNotFoundError,
  IssueStateError,
} from './errors.js';
import {
  createRequiredIssuesGuard,
  DEFAULT_READBACK_MAX_AGE_MS,
  REQUIRED_ISSUES_GUARD,
} from './guard.js';
import {
  cleanUntrustedText,
  type IssueProvider,
  type IssueRef,
  type ProviderFailure,
  type WebhookObservation,
} from './provider.js';
import {
  appendHistory,
  completeOutboundOp,
  countOpenAttention,
  deliverySeen,
  insertDiscrepancy,
  insertLink,
  insertOutboundOp,
  loadAllTrackedLinks,
  loadConfig,
  loadConfigs,
  loadDiscrepancies,
  loadDiscrepancy,
  loadEverRequiredUrls,
  loadHistory,
  loadLink,
  loadLinkByUrl,
  loadLinks,
  loadLinksForIssue,
  loadOpById,
  loadOpenDiscrepancyOfKind,
  loadPendingEchoOp,
  markEchoSeen,
  missionsNeedingAttention,
  payloadSeen,
  recordDelivery,
  resolveDiscrepancies,
  updateLink,
  upsertConfig,
} from './store.js';
import {
  type Discrepancy,
  type DiscrepancyKind,
  type DiscrepancySource,
  type IssueLinkRecord,
  type LinkHistoryItem,
  type ObservedSource,
  SYNC_MODES,
  type SyncConfig,
  type SyncMode,
} from './types.js';
import { parsePublicHttpsUrl } from './url.js';

/** Where a write to a provider is authorized in the policy store. */
export const CLOSE_ACTION = 'issue.close';

const DEFAULT_ECHO_WINDOW_MS = 10 * 60_000;
const DEFAULT_POLL_LIMIT = 100;
const TITLE_MAX = 500;

/** Repairs after a failed effect never undo the discrepancy that says why. */
const RESOLVED_BY_CLOSED: readonly DiscrepancyKind[] = [
  'close_failed',
  'read_back_mismatch',
  'permission_denied',
  'rate_limited',
  'provider_unavailable',
  'blocked',
  'reopened',
  'drifted',
];

export interface IssueServiceDeps {
  db: SqlDatabase;
  core: Core;
  policy: PolicyService;
  /** Provider adapters by id. With none, links are stored and nothing else happens. */
  providers?: Readonly<Record<string, IssueProvider>>;
  clock?: () => Date;
  newId?: (prefix: string) => string;
  readbackMaxAgeMs?: number;
  echoWindowMs?: number;
}

export interface LinkView {
  id: string;
  url: string;
  /** Null for a link an update removed from the mission after it counted as required. */
  classification: LinkClassification | null;
  /** True while the link still holds the mission open: tracked as required, not yet closed or exempt. */
  countsAsRequired: boolean;
  provider: string | null;
  state: IssueLinkRecord['observedState'];
  observedSource: IssueLinkRecord['observedSource'];
  observedAt: string | null;
  verifiedClosed: boolean;
  verifiedClosedAt: string | null;
  closedByTowerAt: string | null;
  retryNotBefore: string | null;
  exemption: IssueLinkRecord['exemption'];
  /** Text written by someone else. Data only. */
  untrusted: { linkTitle: string | null; observedTitle: string | null };
}

export type LinkOutcomeStatus =
  | 'closed'
  | 'already_closed'
  | 'verified_closed'
  | 'open'
  | 'exempt'
  | 'unsupported'
  | 'read_scope_disabled'
  | 'write_scope_disabled'
  | 'provider_not_configured'
  | 'policy_denied'
  | 'backoff'
  | 'blocked'
  | 'failed';

export interface LinkOutcome {
  url: string;
  linkId: string;
  status: LinkOutcomeStatus;
  detail?: string;
  discrepancy?: DiscrepancyKind;
  retryNotBefore?: string;
  policyRef?: string;
}

export interface MissionReport {
  missionId: string;
  results: LinkOutcome[];
  /** Every required link is verified closed or exempt, and nothing needs attention. */
  satisfied: boolean;
  /** The mission's state after the call. */
  state: MissionStatus;
  transitioned: MissionStatus | null;
}

export interface PollReport {
  checked: number;
  skipped: number;
  discrepancies: number;
  missions: MissionReport[];
}

export interface WebhookResult {
  status: 'processed' | 'duplicate' | 'untracked' | 'pong' | 'ignored';
  echoes: number;
  affected: number;
}

export interface SyncConfigInput {
  provider: string;
  repo: string;
  mode: SyncMode;
}

type Seen =
  | {
      type: 'issue';
      state: 'open' | 'closed' | null;
      nodeId: string | null;
      title: string | null;
      /** A provider read-back is the only thing that may verify a close. */
      readback: boolean;
      echo: boolean;
    }
  | { type: 'identity_lost' }
  | { type: 'failure'; failure: ProviderFailure };

interface Env {
  workspaceId: string;
  actorId: string;
  source: ObservedSource;
}

interface Applied {
  discrepancy: DiscrepancyKind | null;
  /** The sighting is not of the issue that was linked, so nothing about its state counts. */
  identityLost: boolean;
  attention: boolean;
  verifiedClosed: boolean;
  resolved: number;
  retryNotBefore: string | null;
}

export interface CloseOptions {
  /**
   * Closes a link although the provider could not say whether open issues block it. Only a person
   * may ask: the choice is recorded on each link with their identity. A known blocker still stops
   * the close, and so does every other check.
   */
  overrideUnknownBlockers?: boolean;
}

export interface IssueService {
  getSyncConfigs(workspaceId: string): SyncConfig[];
  setSyncConfig(ctx: CommandContext, input: SyncConfigInput): SyncConfig;
  /** What applies to one repository: its own row, else the workspace default, else link-only. */
  effectiveConfig(
    workspaceId: string,
    provider: string,
    repo: string,
  ): Pick<SyncConfig, 'mode' | 'readScope' | 'writeScope'>;

  addLink(
    ctx: CommandContext,
    missionId: string,
    expectedVersion: number,
    input: {
      url: string;
      classification: LinkClassification;
      title: string | null;
    },
  ): { result: CommandResult; link: LinkView };
  listLinks(workspaceId: string, missionId: string): LinkView[];
  history(
    workspaceId: string,
    missionId: string,
    page: { afterSeq: number; limit: number },
  ): LinkHistoryItem[];
  discrepancies(
    workspaceId: string,
    missionId: string,
    status: 'open' | 'resolved' | 'all',
  ): Discrepancy[];
  resolveDiscrepancy(
    ctx: CommandContext,
    missionId: string,
    discrepancyId: string,
    note: string,
  ): MissionReport;

  /** Reads every link that holds the mission open back from its provider. Writes nothing to a provider. */
  verifyMission(ctx: CommandContext, missionId: string): Promise<MissionReport>;
  /** Closes required links the caller is authorized to close, then reads each back. */
  closeRequired(
    ctx: CommandContext,
    missionId: string,
    urls?: readonly string[],
    options?: CloseOptions,
  ): Promise<MissionReport>;
  /** Fallback for missed webhooks: reads links that hold live missions open, least recently polled first, and reconciles. */
  poll(
    ctx: Pick<CommandContext, 'workspaceId' | 'actor'>,
    options?: { limit?: number },
  ): Promise<PollReport>;
  handleWebhook(input: {
    workspaceId: string;
    actor: Actor;
    provider: string;
    deliveryId: string;
    event: string;
    observation: WebhookObservation | undefined;
    /**
     * Hash of the raw signed body. A body already accepted has no second effect under a new
     * delivery id, since the signature covers the body and not the id.
     */
    payloadHash?: string | undefined;
  }): WebhookResult;

  requestExemption(
    ctx: CommandContext,
    missionId: string,
    linkId: string,
    reason: string,
  ): LinkView;
  approveExemption(
    ctx: CommandContext,
    missionId: string,
    linkId: string,
  ): LinkView;
  revokeExemption(
    ctx: CommandContext,
    missionId: string,
    linkId: string,
  ): LinkView;
}

const OPERATORS: readonly Actor['kind'][] = ['human', 'chief_of_staff'];
const READERS: readonly Actor['kind'][] = [
  'human',
  'chief_of_staff',
  'provider_adapter',
];

function requireKind(
  actor: Actor,
  command: string,
  kinds: readonly Actor['kind'][],
) {
  if (!kinds.includes(actor.kind)) {
    throw new IssueForbiddenError(command, actor.kind);
  }
}

/**
 * Moves a mission toward attention. Adapters report what they saw, so this is the one move they
 * may make, and only toward `reconciling` or `needs-attention`. Resuming to `verifying` is for a
 * person or a Chief of Staff. Nothing here can complete a mission.
 */
function attentionDecision(
  to: 'reconciling' | 'needs-attention' | 'verifying',
  reason: string,
): Decision<'mission.transitioned'> {
  return {
    type: 'mission.transitioned',
    payload: { to, reason },
    check(state, env) {
      const kinds = to === 'verifying' ? OPERATORS : READERS;
      if (!kinds.includes(env.actor.kind)) {
        throw new ForbiddenActorError(
          `move a mission to ${to}`,
          env.actor.kind,
        );
      }
      assertMissionTransition(state.id, state.state, to);
    },
  };
}

const ATTENTION_FROM: Partial<
  Record<MissionStatus, 'reconciling' | 'needs-attention'>
> = {
  verifying: 'reconciling',
  completed: 'needs-attention',
};

export function createIssueService(deps: IssueServiceDeps): IssueService {
  const { db, core, policy } = deps;
  const providers = deps.providers ?? {};
  const clock = deps.clock ?? (() => new Date());
  const ids = deps.newId ?? newId;
  const echoWindowMs = deps.echoWindowMs ?? DEFAULT_ECHO_WINDOW_MS;
  const nowIso = (): string => clock().toISOString();

  // Registered here so every path that completes a mission through this core meets it.
  if (!core.guards.list().some((g) => g.name === REQUIRED_ISSUES_GUARD)) {
    core.guards.register(
      createRequiredIssuesGuard(
        db,
        clock,
        deps.readbackMaxAgeMs ?? DEFAULT_READBACK_MAX_AGE_MS,
      ),
    );
  }

  function mission(workspaceId: string, missionId: string): MissionState {
    const found = core.missions.getMission(workspaceId, missionId);
    if (found === undefined) {
      throw new MissionNotFoundError(missionId);
    }
    return found;
  }

  function providerFor(
    url: string,
  ): { provider: IssueProvider; ref: IssueRef } | undefined {
    for (const provider of Object.values(providers)) {
      const ref = provider.parseUrl(url);
      if (ref !== undefined) {
        return { provider, ref };
      }
    }
    return undefined;
  }

  function effectiveConfig(
    workspaceId: string,
    provider: string,
    repo: string,
  ) {
    const found =
      loadConfig(db, workspaceId, provider, repo) ??
      loadConfig(db, workspaceId, provider, '*');
    return {
      mode: found?.mode ?? ('link-only' as SyncMode),
      readScope: found?.readScope ?? false,
      writeScope: found?.writeScope ?? false,
    };
  }

  /** The row for a mission link, created on first need. Idempotent. */
  function track(
    tx: SqlDatabase,
    state: MissionState,
    url: string,
  ): IssueLinkRecord {
    const existing = loadLinkByUrl(tx, state.workspaceId, state.id, url);
    if (existing !== undefined) {
      return existing;
    }
    const recognised = providerFor(url);
    const id = ids('lnk');
    insertLink(tx, state.workspaceId, {
      id,
      missionId: state.id,
      url,
      provider: recognised?.ref.provider ?? null,
      repo: recognised?.ref.repo ?? null,
      issueNumber: recognised?.ref.number ?? null,
      at: nowIso(),
    });
    const created = loadLink(tx, state.workspaceId, id);
    if (created === undefined) {
      throw new Error('Issue link was not written');
    }
    return created;
  }

  /**
   * URLs that hold the mission open: required now, or required at any earlier point. A removed or
   * downgraded link stays in this set until a read-back closes it or a person exempts it.
   */
  function countingUrls(state: MissionState): Set<string> {
    return new Set([
      ...state.links
        .filter((l) => l.classification === 'required')
        .map((l) => l.url),
      ...loadEverRequiredUrls(db, state.workspaceId, state.id),
    ]);
  }

  /** Rows for the mission's links and for every counting link an update removed from it. */
  function trackAll(state: MissionState): IssueLinkRecord[] {
    const urls = new Set([
      ...state.links.map((l) => l.url),
      ...countingUrls(state),
    ]);
    return db.transaction((tx) =>
      [...urls].map((url) => track(tx, state, url)),
    );
  }

  function view(
    link: IssueLinkRef | undefined,
    row: IssueLinkRecord | undefined,
    counts: boolean,
  ): LinkView {
    return {
      id: row?.id ?? '',
      url: link?.url ?? row?.url ?? '',
      classification: link?.classification ?? null,
      countsAsRequired: counts && row?.exemption.status !== 'approved',
      provider: row?.provider ?? null,
      state: row?.observedState ?? 'unknown',
      observedSource: row?.observedSource ?? null,
      observedAt: row?.observedAt ?? null,
      verifiedClosed: row?.verifiedClosedAt != null,
      verifiedClosedAt: row?.verifiedClosedAt ?? null,
      closedByTowerAt: row?.closedByTowerAt ?? null,
      retryNotBefore: row?.retryNotBefore ?? null,
      exemption: row?.exemption ?? {
        status: 'none',
        reason: null,
        requestedBy: null,
        requestedAt: null,
        approvedBy: null,
        approvedAt: null,
      },
      untrusted: {
        linkTitle: link?.title ?? null,
        observedTitle: row?.observedTitle ?? null,
      },
    };
  }

  function viewRow(
    state: MissionState,
    row: IssueLinkRecord,
    counting: Set<string> = countingUrls(state),
  ): LinkView {
    return view(
      state.links.find((l) => l.url === row.url),
      row,
      counting.has(row.url),
    );
  }

  function viewOf(state: MissionState, linkId: string): LinkView {
    const row = loadLinks(db, state.workspaceId, state.id).find(
      (r) => r.id === linkId,
    );
    if (row === undefined) {
      throw new IssueLinkNotFoundError(linkId);
    }
    return viewRow(state, row);
  }

  function history(
    tx: SqlDatabase,
    env: Pick<Env, 'workspaceId' | 'actorId'>,
    link: IssueLinkRecord,
    type: string,
    payload: unknown,
  ): void {
    appendHistory(tx, {
      workspaceId: env.workspaceId,
      linkId: link.id,
      missionId: link.missionId,
      type,
      actorId: env.actorId,
      payload,
      at: nowIso(),
    });
  }

  function addDiscrepancy(
    tx: SqlDatabase,
    env: Env,
    link: IssueLinkRecord,
    kind: DiscrepancyKind,
    detail: string,
    requiresAttention: boolean,
    retryAfterSeconds: number | null = null,
  ): void {
    // One open record per kind and link: a repeated observation does not add noise.
    if (
      loadOpenDiscrepancyOfKind(tx, env.workspaceId, link.id, kind) !==
      undefined
    ) {
      return;
    }
    const source: DiscrepancySource =
      env.source === 'readback' ? 'verify' : env.source;
    insertDiscrepancy(tx, env.workspaceId, {
      id: ids('dsc'),
      missionId: link.missionId,
      linkId: link.id,
      kind,
      detail,
      source,
      requiresAttention,
      retryAfterSeconds,
      detectedBy: env.actorId,
      detectedAt: nowIso(),
    });
    history(tx, env, link, 'discrepancy', { kind, detail, requiresAttention });
  }

  /**
   * Folds one sighting of a provider issue into the link row, records any discrepancy, and says
   * whether the mission now needs attention. Runs inside the caller's transaction and moves no
   * mission, which the caller does afterwards.
   */
  function apply(
    tx: SqlDatabase,
    env: Env,
    state: MissionState,
    link: IssueLinkRecord,
    seen: Seen,
  ): Applied {
    const at = nowIso();
    const matters =
      countingUrls(state).has(link.url) && link.exemption.status !== 'approved';
    const done: Applied = {
      discrepancy: null,
      identityLost: false,
      attention: false,
      verifiedClosed: false,
      resolved: 0,
      retryNotBefore: null,
    };
    const raise = (
      kind: DiscrepancyKind,
      detail: string,
      requiresAttention: boolean,
      retryAfterSeconds: number | null = null,
    ) => {
      if (matters || kind === 'identity_mismatch') {
        addDiscrepancy(
          tx,
          env,
          link,
          kind,
          detail,
          requiresAttention && matters,
          retryAfterSeconds,
        );
        done.discrepancy = kind;
        done.attention = requiresAttention && matters;
      }
    };

    if (seen.type === 'failure') {
      const { failure } = seen;
      const closing = env.source === 'close';
      if (failure.kind === 'rate_limited') {
        const seconds = failure.retryAfterSeconds ?? 60;
        const until = new Date(
          clock().getTime() + seconds * 1000,
        ).toISOString();
        updateLink(tx, env.workspaceId, link.id, { retryNotBefore: until }, at);
        done.retryNotBefore = until;
        raise('rate_limited', failure.message, closing, seconds);
      } else if (
        failure.kind === 'not_found' ||
        failure.kind === 'transferred'
      ) {
        updateLink(
          tx,
          env.workspaceId,
          link.id,
          {
            observedState: 'unknown',
            observedSource: env.source,
            observedAt: at,
            verifiedClosedAt: null,
          },
          at,
        );
        done.identityLost = true;
        raise('identity_mismatch', failure.message, true);
      } else if (failure.kind === 'permission') {
        raise('permission_denied', failure.message, closing);
      } else if (failure.kind === 'unavailable') {
        raise('provider_unavailable', failure.message, closing);
      } else {
        raise(
          closing ? 'close_failed' : 'provider_unavailable',
          failure.message,
          closing,
        );
      }
      history(tx, env, link, 'observation_failed', {
        kind: failure.kind,
        source: env.source,
      });
      return done;
    }

    if (seen.type === 'identity_lost') {
      updateLink(
        tx,
        env.workspaceId,
        link.id,
        {
          observedState: 'unknown',
          observedSource: env.source,
          observedAt: at,
          verifiedClosedAt: null,
        },
        at,
      );
      done.identityLost = true;
      raise('identity_mismatch', 'The issue was transferred or deleted', true);
      history(tx, env, link, 'identity_lost', { source: env.source });
      return done;
    }

    if (
      seen.nodeId !== null &&
      link.nodeId !== null &&
      seen.nodeId !== link.nodeId
    ) {
      updateLink(
        tx,
        env.workspaceId,
        link.id,
        {
          observedState: 'unknown',
          observedSource: env.source,
          observedAt: at,
          verifiedClosedAt: null,
        },
        at,
      );
      done.identityLost = true;
      raise(
        'identity_mismatch',
        'The URL now names a different issue than the one linked',
        true,
      );
      history(tx, env, link, 'identity_mismatch', { source: env.source });
      return done;
    }

    const wasVerified = link.verifiedClosedAt !== null;
    const verified = seen.readback && seen.state === 'closed';
    const stillVerified = seen.state === 'closed' && wasVerified;
    updateLink(
      tx,
      env.workspaceId,
      link.id,
      {
        ...(link.nodeId === null && seen.nodeId !== null && seen.readback
          ? { nodeId: seen.nodeId }
          : {}),
        ...(seen.state === null ? {} : { observedState: seen.state }),
        observedSource: env.source,
        observedAt: at,
        ...(seen.title === null
          ? {}
          : { observedTitle: cleanUntrustedText(seen.title, TITLE_MAX) }),
        verifiedClosedAt: verified
          ? at
          : stillVerified
            ? link.verifiedClosedAt
            : null,
        retryNotBefore: null,
      },
      at,
    );

    if (verified) {
      done.verifiedClosed = true;
      done.resolved = resolveDiscrepancies(
        tx,
        env.workspaceId,
        { linkId: link.id, kinds: RESOLVED_BY_CLOSED },
        env.actorId,
        'the provider read-back shows the issue closed',
        at,
      );
      history(tx, env, link, 'verified_closed', { source: env.source });
    } else if (seen.state === 'open' && !seen.echo) {
      if (wasVerified || state.state === 'completed') {
        raise(
          'reopened',
          'A required issue is open again after it was verified closed',
          state.state === 'completed',
        );
      }
      history(tx, env, link, 'observed_open', { source: env.source });
    } else {
      history(tx, env, link, seen.echo ? 'echo' : 'observed', {
        source: env.source,
        state: seen.state,
      });
    }
    return done;
  }

  /** Moves a mission toward attention when an unresolved discrepancy asks for it. */
  function settle(
    workspaceId: string,
    missionId: string,
    actor: Actor,
    reason: string,
  ): MissionStatus | null {
    try {
      return core.missions.withMission(
        workspaceId,
        missionId,
        actor,
        (session) => {
          const target = ATTENTION_FROM[session.state.state];
          if (target === undefined) {
            return null;
          }
          // A full mission cannot take `reconciling`, but may still be flagged.
          const to = session.full ? 'needs-attention' : target;
          session.step(attentionDecision(to, reason), {
            correlationId: ids('cor'),
            at: nowIso(),
          });
          return to;
        },
      );
    } catch (error) {
      if (
        error instanceof CommandNotAllowedError ||
        error instanceof ForbiddenActorError
      ) {
        return null;
      }
      throw error;
    }
  }

  /** `reconciling` goes back to `verifying` once nothing needs attention. Completion stays guarded. */
  function resume(
    workspaceId: string,
    missionId: string,
    actor: Actor,
  ): MissionStatus | null {
    if (!OPERATORS.includes(actor.kind)) {
      return null;
    }
    return core.missions.withMission(
      workspaceId,
      missionId,
      actor,
      (session) => {
        if (
          session.state.state !== 'reconciling' ||
          countOpenAttention(db, workspaceId, missionId) > 0
        ) {
          return null;
        }
        session.step(
          attentionDecision('verifying', 'issue discrepancies are resolved'),
          {
            correlationId: ids('cor'),
            at: nowIso(),
          },
        );
        return 'verifying' as const;
      },
    );
  }

  function satisfied(state: MissionState): boolean {
    const rows = new Map(
      loadLinks(db, state.workspaceId, state.id).map((r) => [r.url, r]),
    );
    return (
      countOpenAttention(db, state.workspaceId, state.id) === 0 &&
      [...countingUrls(state)].every((url) => {
        const row = rows.get(url);
        return (
          row?.exemption.status === 'approved' ||
          (row?.verifiedClosedAt != null && row.observedState === 'closed')
        );
      })
    );
  }

  /** Reads one link and folds the result in. Returns an outcome, or a refusal reason without calling out. */
  async function readOne(
    actor: Actor,
    state: MissionState,
    link: IssueLinkRecord,
    source: 'readback' | 'poll' | 'close',
    includeBlockers = false,
  ): Promise<{
    outcome: LinkOutcome;
    applied?: Applied;
    /** Null: not read, or the provider would not say. Unknown is not zero. */
    snapshotOpenBlockers?: number | null;
  }> {
    const base = { url: link.url, linkId: link.id };
    if (link.exemption.status === 'approved' && source === 'poll') {
      return { outcome: { ...base, status: 'exempt' } };
    }
    const recognised = providerFor(link.url);
    if (
      link.provider === null ||
      link.repo === null ||
      recognised === undefined
    ) {
      return {
        outcome: {
          ...base,
          status:
            link.provider === null ? 'unsupported' : 'provider_not_configured',
        },
      };
    }
    const config = effectiveConfig(state.workspaceId, link.provider, link.repo);
    if (!config.readScope) {
      return { outcome: { ...base, status: 'read_scope_disabled' } };
    }
    if (
      link.retryNotBefore !== null &&
      Date.parse(link.retryNotBefore) > clock().getTime()
    ) {
      return {
        outcome: {
          ...base,
          status: 'backoff',
          retryNotBefore: link.retryNotBefore,
        },
      };
    }
    const result = await recognised.provider.getIssue(recognised.ref, {
      includeBlockers,
    });
    const env: Env = {
      workspaceId: state.workspaceId,
      actorId: actor.id,
      source,
    };
    const applied = db.transaction((tx) =>
      apply(
        tx,
        env,
        state,
        loadLink(tx, state.workspaceId, link.id) ?? link,
        result.ok
          ? {
              type: 'issue',
              state: result.value.state,
              nodeId: result.value.nodeId,
              title: result.value.title,
              readback: true,
              echo: false,
            }
          : { type: 'failure', failure: result.error },
      ),
    );
    // An issue that is open again is still open: a discrepancy about it does not make the read fail.
    const status: LinkOutcomeStatus = applied.verifiedClosed
      ? 'verified_closed'
      : result.ok && !applied.identityLost
        ? 'open'
        : 'failed';
    return {
      outcome: {
        ...base,
        status,
        ...(applied.discrepancy === null
          ? {}
          : { discrepancy: applied.discrepancy }),
        ...(applied.retryNotBefore === null
          ? {}
          : { retryNotBefore: applied.retryNotBefore }),
      },
      applied,
      ...(result.ok ? { snapshotOpenBlockers: result.value.openBlockers } : {}),
    };
  }

  function finishMission(
    workspaceId: string,
    missionId: string,
    actor: Actor,
    results: LinkOutcome[],
    attention: boolean,
    resolved: number,
  ): MissionReport {
    let transitioned: MissionStatus | null = null;
    if (attention) {
      transitioned = settle(
        workspaceId,
        missionId,
        actor,
        'A required issue link needs attention',
      );
    } else if (resolved > 0) {
      transitioned = resume(workspaceId, missionId, actor);
    }
    const state = mission(workspaceId, missionId);
    return {
      missionId,
      results,
      satisfied: satisfied(state),
      state: state.state,
      transitioned,
    };
  }

  /** Every link that holds the mission open, including ones an update removed or downgraded. */
  function countingLinks(state: MissionState): IssueLinkRecord[] {
    const counting = countingUrls(state);
    return trackAll(state).filter((r) => counting.has(r.url));
  }

  /** Links Tower may close: required on the mission now. A downgraded link is read, never closed. */
  function closableLinks(
    state: MissionState,
    urls?: readonly string[],
  ): IssueLinkRecord[] {
    const rows = trackAll(state);
    const wanted = state.links.filter((l) => l.classification === 'required');
    if (urls !== undefined) {
      for (const url of urls) {
        const link = state.links.find((l) => l.url === url);
        if (link === undefined) {
          throw new IssueLinkNotFoundError(url);
        }
        if (link.classification !== 'required') {
          throw new IssueStateError(
            'link_not_required',
            `${url} is ${link.classification}, and Tower closes only required links`,
          );
        }
      }
    }
    return wanted
      .filter((l) => urls === undefined || urls.includes(l.url))
      .flatMap((l) => rows.filter((r) => r.url === l.url));
  }

  function linkIn(state: MissionState, linkId: string): IssueLinkRecord {
    const row = trackAll(state).find((r) => r.id === linkId);
    if (row === undefined) {
      throw new IssueLinkNotFoundError(linkId);
    }
    return row;
  }

  function requireLive(state: MissionState, command: string): void {
    if (state.state === 'cancelled') {
      throw new IssueStateError(
        'mission_cancelled',
        `${command} is not allowed: the mission is cancelled`,
      );
    }
  }

  async function closeOne(
    ctx: CommandContext,
    state: MissionState,
    link: IssueLinkRecord,
    overrideUnknownBlockers: boolean,
  ): Promise<{ outcome: LinkOutcome; attention: boolean; resolved: number }> {
    const base = { url: link.url, linkId: link.id };
    const env: Env = {
      workspaceId: state.workspaceId,
      actorId: ctx.actor.id,
      source: 'close',
    };
    const recognised = providerFor(link.url);
    const refuse = (
      status: LinkOutcomeStatus,
      extra: Partial<LinkOutcome> = {},
    ) => ({
      outcome: { ...base, status, ...extra },
      attention: false,
      resolved: 0,
    });
    if (link.exemption.status === 'approved') {
      return refuse('exempt');
    }
    if (
      link.provider === null ||
      link.repo === null ||
      link.issueNumber === null
    ) {
      return refuse('unsupported');
    }
    if (recognised === undefined) {
      return refuse('provider_not_configured');
    }
    const config = effectiveConfig(state.workspaceId, link.provider, link.repo);
    if (!config.writeScope) {
      return refuse('write_scope_disabled');
    }
    if (
      link.retryNotBefore !== null &&
      Date.parse(link.retryNotBefore) > clock().getTime()
    ) {
      return refuse('backoff', { retryNotBefore: link.retryNotBefore });
    }

    const risk: Risk = state.risk;
    const request = {
      workspace: state.workspaceId,
      principal: ctx.actor.id,
      action: CLOSE_ACTION,
      resource: `${link.provider}:${link.repo}#${link.issueNumber}`,
      scope: `repo:${link.repo}`,
      risk,
      missionId: state.id,
    };
    // Authority is checked before anything goes out and again right before the write.
    const authorize = ():
      | { ok: true }
      | { ok: false; reason: string; policyRef: string } => {
      try {
        policy.guard(request);
        return { ok: true };
      } catch (error) {
        if (error instanceof PolicyDeniedError) {
          return {
            ok: false,
            reason: error.reason,
            policyRef: error.policyRef,
          };
        }
        throw error;
      }
    };
    const first = authorize();
    if (!first.ok) {
      return refuse('policy_denied', {
        detail: first.reason,
        policyRef: first.policyRef,
      });
    }

    const read = await readOne(ctx.actor, state, link, 'close', true);
    if (read.outcome.status === 'verified_closed') {
      return {
        outcome: { ...base, status: 'already_closed' },
        attention: false,
        resolved: read.applied?.resolved ?? 0,
      };
    }
    if (read.outcome.status !== 'open') {
      return {
        outcome: read.outcome,
        attention:
          read.applied?.attention === true || read.outcome.status === 'failed',
        resolved: 0,
      };
    }
    const blockers = read.snapshotOpenBlockers ?? null;
    const overridden = blockers === null && overrideUnknownBlockers;
    if (overridden) {
      db.transaction((tx) =>
        history(tx, env, link, 'blockers_unknown_override', {
          resource: request.resource,
          by: ctx.actor.id,
        }),
      );
    }
    if ((blockers === null && !overridden) || (blockers ?? 0) > 0) {
      db.transaction((tx) =>
        addDiscrepancy(
          tx,
          env,
          link,
          'blocked',
          blockers === null
            ? 'Open blockers could not be read, so they are unknown and not counted as none'
            : `${blockers} open issue(s) block this one`,
          true,
        ),
      );
      return {
        outcome: {
          ...base,
          status: 'blocked',
          discrepancy: 'blocked',
          ...(blockers === null ? { detail: 'blockers_unknown' } : {}),
        },
        attention: true,
        resolved: 0,
      };
    }

    const second = authorize();
    if (!second.ok) {
      return refuse('policy_denied', {
        detail: second.reason,
        policyRef: second.policyRef,
      });
    }
    const marker = ids('iop');
    db.transaction((tx) => {
      insertOutboundOp(tx, state.workspaceId, {
        id: marker,
        linkId: link.id,
        requestedBy: ctx.actor.id,
        at: nowIso(),
      });
      history(tx, env, link, 'close_requested', {
        marker,
        resource: request.resource,
      });
    });

    const closed = await recognised.provider.closeIssue(recognised.ref, {
      marker,
      note: `Closed by Auto Tower for mission ${state.id}.`,
    });
    if (!closed.ok) {
      const applied = db.transaction((tx) => {
        completeOutboundOp(tx, state.workspaceId, marker, 'failed', nowIso());
        return apply(
          tx,
          env,
          state,
          loadLink(tx, state.workspaceId, link.id) ?? link,
          {
            type: 'failure',
            failure: closed.error,
          },
        );
      });
      return {
        outcome: {
          ...base,
          status: 'failed',
          ...(applied.discrepancy === null
            ? {}
            : { discrepancy: applied.discrepancy }),
          ...(applied.retryNotBefore === null
            ? {}
            : { retryNotBefore: applied.retryNotBefore }),
        },
        attention: true,
        resolved: 0,
      };
    }
    db.transaction((tx) =>
      completeOutboundOp(tx, state.workspaceId, marker, 'succeeded', nowIso()),
    );

    const back = await recognised.provider.getIssue(recognised.ref);
    const applied = db.transaction((tx) => {
      const fresh = loadLink(tx, state.workspaceId, link.id) ?? link;
      if (!back.ok) {
        return apply(tx, env, state, fresh, {
          type: 'failure',
          failure: back.error,
        });
      }
      const result = apply(tx, env, state, fresh, {
        type: 'issue',
        state: back.value.state,
        nodeId: back.value.nodeId,
        title: back.value.title,
        readback: true,
        echo: false,
      });
      if (result.verifiedClosed) {
        updateLink(
          tx,
          state.workspaceId,
          link.id,
          { closedByTowerAt: nowIso(), observedSource: 'close' },
          nowIso(),
        );
        history(tx, env, fresh, 'closed_by_tower', { marker });
      } else if (result.discrepancy === null) {
        addDiscrepancy(
          tx,
          env,
          fresh,
          'read_back_mismatch',
          'The provider accepted the close but the read-back still shows the issue open',
          true,
        );
        result.discrepancy = 'read_back_mismatch';
        result.attention = true;
      }
      return result;
    });
    if (applied.verifiedClosed) {
      return {
        outcome: { ...base, status: 'closed' },
        attention: false,
        resolved: applied.resolved,
      };
    }
    return {
      outcome: {
        ...base,
        status: 'failed',
        ...(applied.discrepancy === null
          ? {}
          : { discrepancy: applied.discrepancy }),
      },
      attention: true,
      resolved: 0,
    };
  }

  function observeWebhook(
    tx: SqlDatabase,
    env: Env,
    link: IssueLinkRecord,
    state: MissionState,
    observation: Exclude<WebhookObservation, { kind: 'ping' }>,
  ): { attention: boolean; echo: boolean } {
    if (observation.kind === 'comment') {
      const op =
        observation.marker === null
          ? undefined
          : loadOpById(tx, env.workspaceId, observation.marker);
      if (op !== undefined && op.linkId === link.id) {
        markEchoSeen(tx, env.workspaceId, op.id, nowIso());
        history(tx, env, link, 'echo', { via: 'comment' });
        return { attention: false, echo: true };
      }
      return { attention: false, echo: false };
    }
    let echo = false;
    if (observation.action === 'closed') {
      const pending = loadPendingEchoOp(tx, env.workspaceId, link.id);
      if (
        pending !== undefined &&
        clock().getTime() - Date.parse(pending.requestedAt) <= echoWindowMs
      ) {
        markEchoSeen(tx, env.workspaceId, pending.id, nowIso());
        echo = true;
      }
    }
    const seen: Seen = observation.identityLost
      ? { type: 'identity_lost' }
      : {
          type: 'issue',
          state: observation.state,
          nodeId: observation.nodeId,
          title: observation.title,
          readback: false,
          echo,
        };
    const applied = apply(tx, env, state, link, seen);
    return { attention: applied.attention, echo };
  }

  return {
    getSyncConfigs: (workspaceId) => loadConfigs(db, workspaceId),
    effectiveConfig,

    setSyncConfig(ctx, input) {
      // Widening what Tower may do to an outside system is a person's call.
      requireKind(ctx.actor, 'change the issue sync configuration', ['human']);
      const issues = [];
      if (!(SYNC_MODES as readonly string[]).includes(input.mode)) {
        issues.push({
          path: 'mode',
          message: `must be one of ${SYNC_MODES.join(', ')}`,
        });
      }
      const repo = input.repo.toLowerCase();
      if (
        repo !== '*' &&
        !/^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/.test(repo)
      ) {
        issues.push({ path: 'repo', message: 'must be * or owner/name' });
      }
      if (repo.endsWith('/.') || repo.endsWith('/..')) {
        issues.push({ path: 'repo', message: 'must be * or owner/name' });
      }
      if (input.provider !== 'github') {
        issues.push({ path: 'provider', message: 'must be github' });
      }
      if (issues.length > 0) {
        throw new ValidationError(issues);
      }
      return db.transaction((tx) =>
        upsertConfig(tx, ctx.workspaceId, {
          provider: input.provider,
          repo,
          mode: input.mode,
          readScope: input.mode !== 'link-only',
          writeScope: input.mode === 'bidirectional',
          updatedBy: ctx.actor.id,
          updatedAt: nowIso(),
        }),
      );
    },

    addLink(ctx, missionId, expectedVersion, input) {
      requireKind(ctx.actor, 'link an issue', OPERATORS);
      const parsed = parsePublicHttpsUrl(input.url);
      if (!parsed.ok) {
        throw new ValidationError([{ path: 'url', message: parsed.message }]);
      }
      const recognised = providerFor(parsed.url.href);
      const url = recognised?.ref.url ?? parsed.url.href;
      const current = mission(ctx.workspaceId, missionId);
      if (current.links.some((l) => l.url === url)) {
        throw new ValidationError([
          { path: 'url', message: `${url} is already linked` },
        ]);
      }
      const result = core.missions.updateMission(
        ctx,
        missionId,
        expectedVersion,
        {
          links: [
            ...current.links,
            { url, classification: input.classification, title: input.title },
          ],
        },
      );
      const row = db.transaction((tx) => {
        const tracked = track(tx, result.mission, url);
        history(
          tx,
          { workspaceId: ctx.workspaceId, actorId: ctx.actor.id },
          tracked,
          'link_added',
          {
            classification: input.classification,
          },
        );
        return tracked;
      });
      if (!result.mission.links.some((l) => l.url === url)) {
        throw new Error('Link was not stored');
      }
      return { result, link: viewRow(result.mission, row) };
    },

    listLinks(workspaceId, missionId) {
      const state = mission(workspaceId, missionId);
      const counting = countingUrls(state);
      return trackAll(state).map((row) => viewRow(state, row, counting));
    },

    history: (workspaceId, missionId, page) => {
      mission(workspaceId, missionId);
      return loadHistory(db, workspaceId, missionId, page);
    },

    discrepancies: (workspaceId, missionId, status) => {
      mission(workspaceId, missionId);
      return loadDiscrepancies(db, workspaceId, missionId, status);
    },

    resolveDiscrepancy(ctx, missionId, discrepancyId, note) {
      requireKind(ctx.actor, 'resolve a discrepancy', ['human']);
      const state = mission(ctx.workspaceId, missionId);
      const found = loadDiscrepancy(
        db,
        ctx.workspaceId,
        missionId,
        discrepancyId,
      );
      if (found === undefined) {
        throw new DiscrepancyNotFoundError(discrepancyId);
      }
      if (found.resolvedAt !== null) {
        throw new IssueStateError(
          'discrepancy_resolved',
          'The discrepancy is already resolved',
        );
      }
      const resolved = db.transaction((tx) => {
        const n = resolveDiscrepancies(
          tx,
          ctx.workspaceId,
          { id: discrepancyId },
          ctx.actor.id,
          note,
          nowIso(),
        );
        const link = loadLink(tx, ctx.workspaceId, found.linkId);
        if (link !== undefined) {
          // A person who clears a lost identity accepts the issue the URL names now. The next
          // read-back pins that one, so the link is not stuck on the old identity for good.
          const repin = found.kind === 'identity_mismatch';
          if (repin) {
            updateLink(
              tx,
              ctx.workspaceId,
              link.id,
              {
                nodeId: null,
                observedState: 'unknown',
                verifiedClosedAt: null,
              },
              nowIso(),
            );
          }
          history(
            tx,
            { workspaceId: ctx.workspaceId, actorId: ctx.actor.id },
            link,
            'discrepancy_resolved',
            { discrepancyId, repin },
          );
        }
        return n;
      });
      return finishMission(
        ctx.workspaceId,
        state.id,
        ctx.actor,
        [],
        false,
        resolved,
      );
    },

    async verifyMission(ctx, missionId) {
      requireKind(ctx.actor, 'verify issue links', READERS);
      const state = mission(ctx.workspaceId, missionId);
      requireLive(state, 'Verifying links');
      const results: LinkOutcome[] = [];
      let attention = false;
      let resolved = 0;
      for (const link of countingLinks(state)) {
        const read = await readOne(ctx.actor, state, link, 'readback');
        results.push(read.outcome);
        attention ||= read.applied?.attention === true;
        resolved += read.applied?.resolved ?? 0;
      }
      return finishMission(
        ctx.workspaceId,
        missionId,
        ctx.actor,
        results,
        attention,
        resolved,
      );
    },

    async closeRequired(ctx, missionId, urls, options) {
      requireKind(ctx.actor, 'close issues', OPERATORS);
      const override = options?.overrideUnknownBlockers === true;
      if (override) {
        requireKind(ctx.actor, 'override unknown blockers', ['human']);
      }
      const state = mission(ctx.workspaceId, missionId);
      requireLive(state, 'Closing links');
      if (state.state !== 'verifying' && state.state !== 'reconciling') {
        throw new IssueStateError(
          'mission_not_closable',
          `Required issues close once the mission is verifying or reconciling, not ${state.state}`,
        );
      }
      const results: LinkOutcome[] = [];
      let attention = false;
      let resolved = 0;
      for (const link of closableLinks(state, urls)) {
        // Each link sees the mission as it is now, since an earlier one may have moved it.
        const outcome = await closeOne(
          ctx,
          mission(ctx.workspaceId, missionId),
          link,
          override,
        );
        results.push(outcome.outcome);
        attention ||= outcome.attention;
        resolved += outcome.resolved;
        if (
          outcome.outcome.retryNotBefore !== undefined &&
          outcome.outcome.status === 'failed'
        ) {
          // The provider asked everyone to wait. Do not try the next link against it.
          break;
        }
      }
      return finishMission(
        ctx.workspaceId,
        missionId,
        ctx.actor,
        results,
        attention,
        resolved,
      );
    },

    async poll(ctx, options) {
      requireKind(ctx.actor, 'poll issue links', READERS);
      const limit = options?.limit ?? DEFAULT_POLL_LIMIT;
      const byMission = new Map<string, LinkOutcome[]>();
      const flags = new Map<string, { attention: boolean; resolved: number }>();
      let checked = 0;
      let skipped = 0;
      let discrepancies = 0;
      const missionStates = new Map<
        string,
        { state: MissionState; counting: Set<string> } | undefined
      >();
      // Least recently polled first, so that more than `limit` links are all reached over time.
      for (const link of loadAllTrackedLinks(db, ctx.workspaceId)) {
        if (checked >= limit) {
          break;
        }
        if (!missionStates.has(link.missionId)) {
          const found = core.missions.getMission(
            ctx.workspaceId,
            link.missionId,
          );
          missionStates.set(
            link.missionId,
            found === undefined
              ? undefined
              : { state: found, counting: countingUrls(found) },
          );
        }
        const known = missionStates.get(link.missionId);
        if (
          known === undefined ||
          known.state.state === 'cancelled' ||
          !known.counting.has(link.url)
        ) {
          skipped += 1;
          continue;
        }
        const { state } = known;
        const read = await readOne(ctx.actor, state, link, 'poll');
        if (
          read.outcome.status === 'backoff' ||
          read.outcome.status === 'exempt'
        ) {
          skipped += 1;
          continue;
        }
        // Stamped whatever the answer was: a link that keeps failing must not hold the front of the queue.
        db.transaction((tx) =>
          updateLink(
            tx,
            state.workspaceId,
            link.id,
            { polledAt: nowIso() },
            nowIso(),
          ),
        );
        checked += 1;
        byMission.set(state.id, [
          ...(byMission.get(state.id) ?? []),
          read.outcome,
        ]);
        const flag = flags.get(state.id) ?? { attention: false, resolved: 0 };
        flag.attention ||= read.applied?.attention === true;
        flag.resolved += read.applied?.resolved ?? 0;
        flags.set(state.id, flag);
        if (read.applied?.discrepancy != null) {
          discrepancies += 1;
        }
      }
      // A crash can leave a discrepancy that asked for attention before the mission moved.
      for (const missionId of missionsNeedingAttention(db, ctx.workspaceId)) {
        const flag = flags.get(missionId) ?? { attention: false, resolved: 0 };
        flag.attention = true;
        flags.set(missionId, flag);
        byMission.set(missionId, byMission.get(missionId) ?? []);
      }
      const missions: MissionReport[] = [];
      for (const [missionId, results] of byMission) {
        const flag = flags.get(missionId);
        missions.push(
          finishMission(
            ctx.workspaceId,
            missionId,
            ctx.actor,
            results,
            flag?.attention === true,
            flag?.resolved ?? 0,
          ),
        );
      }
      return { checked, skipped, discrepancies, missions };
    },

    handleWebhook(input) {
      const {
        workspaceId,
        actor,
        provider,
        deliveryId,
        event,
        observation,
        payloadHash,
      } = input;
      const env: Env = { workspaceId, actorId: actor.id, source: 'webhook' };
      const touched = new Set<string>();
      const result = db.transaction((tx): WebhookResult => {
        if (
          deliverySeen(tx, workspaceId, provider, deliveryId) ||
          (payloadHash !== undefined &&
            payloadSeen(tx, workspaceId, provider, payloadHash))
        ) {
          return { status: 'duplicate', echoes: 0, affected: 0 };
        }
        const log = (
          status: WebhookResult['status'],
          echoes = 0,
          affected = 0,
        ): WebhookResult => {
          recordDelivery(tx, workspaceId, {
            provider,
            deliveryId,
            event,
            outcome: status,
            at: nowIso(),
            payloadHash,
          });
          return { status, echoes, affected };
        };
        if (observation === undefined) {
          return log('ignored');
        }
        if (observation.kind === 'ping') {
          return log('pong');
        }
        const links = loadLinksForIssue(
          tx,
          workspaceId,
          provider,
          observation.repo,
          observation.number,
        );
        if (links.length === 0) {
          return log('untracked');
        }
        let echoes = 0;
        for (const link of links) {
          const state = core.missions.getMission(workspaceId, link.missionId);
          if (state === undefined || state.state === 'cancelled') {
            continue;
          }
          const seen = observeWebhook(tx, env, link, state, observation);
          echoes += seen.echo ? 1 : 0;
          if (seen.attention) {
            touched.add(state.id);
          }
        }
        return log('processed', echoes, links.length);
      });
      for (const missionId of touched) {
        settle(
          workspaceId,
          missionId,
          actor,
          'A required issue link needs attention',
        );
      }
      return result;
    },

    requestExemption(ctx, missionId, linkId, reason) {
      requireKind(ctx.actor, 'request an exemption', OPERATORS);
      const state = mission(ctx.workspaceId, missionId);
      requireLive(state, 'An exemption');
      const link = linkIn(state, linkId);
      if (!countingUrls(state).has(link.url)) {
        throw new IssueStateError(
          'link_not_required',
          'Only a required link needs an exemption',
        );
      }
      if (link.exemption.status === 'approved') {
        throw new IssueStateError(
          'exemption_approved',
          'The exemption is already approved',
        );
      }
      db.transaction((tx) => {
        const at = nowIso();
        updateLink(
          tx,
          ctx.workspaceId,
          link.id,
          {
            exemptionStatus: 'requested',
            exemptionReason: reason,
            exemptionRequestedBy: ctx.actor.id,
            exemptionRequestedAt: at,
          },
          at,
        );
        history(
          tx,
          { workspaceId: ctx.workspaceId, actorId: ctx.actor.id },
          link,
          'exemption_requested',
          { reason },
        );
      });
      return viewOf(state, link.id);
    },

    approveExemption(ctx, missionId, linkId) {
      // A person decides that a mission may finish with a required issue still open.
      requireKind(ctx.actor, 'approve an exemption', ['human']);
      const state = mission(ctx.workspaceId, missionId);
      requireLive(state, 'An exemption');
      const link = linkIn(state, linkId);
      if (link.exemption.status !== 'requested') {
        throw new IssueStateError(
          'exemption_not_requested',
          'Only a requested exemption can be approved',
        );
      }
      db.transaction((tx) => {
        const at = nowIso();
        updateLink(
          tx,
          ctx.workspaceId,
          link.id,
          {
            exemptionStatus: 'approved',
            exemptionApprovedBy: ctx.actor.id,
            exemptionApprovedAt: at,
          },
          at,
        );
        history(
          tx,
          { workspaceId: ctx.workspaceId, actorId: ctx.actor.id },
          link,
          'exemption_approved',
          {},
        );
      });
      return viewOf(state, link.id);
    },

    revokeExemption(ctx, missionId, linkId) {
      requireKind(ctx.actor, 'revoke an exemption', ['human']);
      const state = mission(ctx.workspaceId, missionId);
      const link = linkIn(state, linkId);
      if (link.exemption.status === 'none') {
        throw new IssueStateError(
          'exemption_not_requested',
          'There is no exemption to revoke',
        );
      }
      db.transaction((tx) => {
        const at = nowIso();
        updateLink(
          tx,
          ctx.workspaceId,
          link.id,
          {
            exemptionStatus: 'none',
            exemptionReason: null,
            exemptionRequestedBy: null,
            exemptionRequestedAt: null,
            exemptionApprovedBy: null,
            exemptionApprovedAt: null,
          },
          at,
        );
        history(
          tx,
          { workspaceId: ctx.workspaceId, actorId: ctx.actor.id },
          link,
          'exemption_revoked',
          {},
        );
      });
      return viewOf(state, link.id);
    },
  };
}
