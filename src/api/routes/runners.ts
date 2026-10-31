import type { Context } from 'hono';
import {
  ingestOfficeEvidence,
  type OfficeIngest,
} from '../../adapters/office/ingest.js';
import type { Fleet, FleetErrorCode, RunnerCaller } from '../../fleet/index.js';
import { FleetError } from '../../fleet/index.js';
import {
  parseAuditQuery,
  parseCheckpoint,
  parseIssueEnrollment,
  parseLeaseQuery,
  parsePoll,
  parseProgress,
  parseReason,
  parseReceipt,
  parseReconcile,
  parseRegister,
  parseUpdateRunner,
} from '../../fleet/inputs.js';
import type { AppEnv, RouteSpec } from '../app.js';
import { errorBody } from '../errors.js';
import { callerOf, guarded, readJson } from './missions.js';

const STATUS_BY_CODE: Readonly<Record<FleetErrorCode, 401 | 403 | 404 | 409>> =
  {
    enrollment_invalid: 401,
    version_mismatch: 403,
    version_unsupported: 403,
    runner_required: 403,
    human_required: 403,
    credential_not_bound: 403,
    runner_quarantined: 403,
    runner_not_found: 404,
    lease_not_found: 404,
    lease_fenced: 409,
    lease_expired: 409,
    lease_closed: 409,
    attempt_cancelled: 409,
    claim_conflict: 409,
    receipt_conflict: 409,
    progress_conflict: 409,
  };

type Handler = (c: Context<AppEnv>) => Response | Promise<Response>;

/** Answers fleet refusals, then lets the shared guard answer core and request errors. */
function fleetGuarded(handler: Handler): Handler {
  return guarded(async (c) => {
    try {
      return await handler(c);
    } catch (error) {
      if (error instanceof FleetError) {
        const body = errorBody(error.code, error.message);
        return c.json(
          error.extra === undefined
            ? body
            : { error: { ...body.error, details: error.extra } },
          STATUS_BY_CODE[error.code],
          error.code === 'enrollment_invalid'
            ? { 'WWW-Authenticate': 'Bearer' }
            : {},
        );
      }
      throw error;
    }
  });
}

export function fleetOf(c: Context<AppEnv>): Fleet {
  const { fleet } = c.get('deps');
  if (fleet === undefined) {
    throw new Error('The runner fleet is not configured');
  }
  return fleet;
}

/** An enrolled runner using its own bound credential. Humans and other kinds are refused. */
function runnerCaller(c: Context<AppEnv>): RunnerCaller {
  const { principal, tokenId } = c.get('auth');
  if (principal.kind !== 'runner') {
    throw new FleetError(
      'runner_required',
      'Only an enrolled runner may call this route',
    );
  }
  return {
    workspaceId: principal.workspaceId,
    principalId: principal.id,
    tokenId,
  };
}

/**
 * Scopes alone cannot tell a human from a runner here, since both hold `runner:write`.
 * Operator routes also require the human principal kind.
 */
function humanCaller(c: Context<AppEnv>): {
  workspaceId: string;
  principalId: string;
} {
  const { workspaceId, actor } = callerOf(c);
  if (actor.kind !== 'human') {
    throw new FleetError(
      'human_required',
      'Only a human principal may call this route',
    );
  }
  return { workspaceId, principalId: actor.id };
}

const issueEnrollment: RouteSpec = {
  method: 'post',
  path: '/runners/enrollments',
  access: { scopes: ['admin:tokens'] },
  handler: fleetGuarded(async (c) => {
    const human = humanCaller(c);
    const input = parseIssueEnrollment(await readJson(c));
    const enrollment = fleetOf(c).issueEnrollment({
      workspaceId: human.workspaceId,
      issuedBy: human.principalId,
      ...input,
    });
    return c.json({ enrollment }, 201);
  }),
};

/**
 * The runner presents the enrollment token it was given. That token is an api token narrowed to
 * `runner:read` and revoked by this call, so it registers once. Runners and humans hold no
 * enrollment, so for them this is a 401.
 */
const registerRunner: RouteSpec = {
  method: 'post',
  path: '/runners/register',
  access: { scopes: ['runner:read'] },
  handler: fleetGuarded(async (c) => {
    const { principal, tokenId } = c.get('auth');
    const input = parseRegister(await readJson(c));
    const fleet = fleetOf(c);
    const registration = fleet.register(
      { workspaceId: principal.workspaceId, tokenId },
      input,
    );
    return c.json(
      {
        runnerId: registration.runnerId,
        token: registration.token,
        bound: registration.bound,
        pollIntervalMs: fleet.config.pollIntervalMs,
      },
      201,
    );
  }),
};

const listRunners: RouteSpec = {
  method: 'get',
  path: '/runners',
  access: { scopes: ['runner:read'] },
  handler: fleetGuarded((c) => {
    const { workspaceId, actor } = callerOf(c);
    // A runner sees only itself.
    return c.json({
      runners: fleetOf(c).runners(
        workspaceId,
        actor.kind === 'runner' ? actor.id : undefined,
      ),
    });
  }),
};

const listLeases: RouteSpec = {
  method: 'get',
  path: '/runners/leases',
  access: { scopes: ['runner:read'] },
  handler: fleetGuarded((c) => {
    const { workspaceId } = humanCaller(c);
    return c.json({
      leases: fleetOf(c).leases(workspaceId, parseLeaseQuery(c.req.query())),
    });
  }),
};

const readAudit: RouteSpec = {
  method: 'get',
  path: '/runners/audit',
  access: { scopes: ['runner:read'] },
  handler: fleetGuarded((c) => {
    const { workspaceId } = humanCaller(c);
    return c.json({
      records: fleetOf(c).audit(workspaceId, parseAuditQuery(c.req.query())),
    });
  }),
};

const readLease: RouteSpec = {
  method: 'get',
  path: '/runners/leases/:id',
  access: { scopes: ['runner:read'] },
  handler: fleetGuarded((c) => {
    const { workspaceId, actor } = callerOf(c);
    return c.json(
      fleetOf(c).leaseDetail(workspaceId, c.req.param('id') ?? '', {
        principalId: actor.id,
        kind: actor.kind,
      }),
    );
  }),
};

const updateRunner: RouteSpec = {
  method: 'patch',
  path: '/runners/:id',
  access: { scopes: ['runner:write'] },
  handler: fleetGuarded(async (c) => {
    const human = humanCaller(c);
    const input = parseUpdateRunner(await readJson(c));
    return c.json({
      runner: fleetOf(c).updateRunner(human, c.req.param('id') ?? '', input),
    });
  }),
};

const quarantineRunner: RouteSpec = {
  method: 'post',
  path: '/runners/:id/quarantine',
  access: { scopes: ['runner:write'] },
  handler: fleetGuarded(async (c) => {
    const human = humanCaller(c);
    const reason = parseReason(await readJson(c));
    return c.json({
      runner: fleetOf(c).quarantine(human, c.req.param('id') ?? '', reason),
    });
  }),
};

const unquarantineRunner: RouteSpec = {
  method: 'post',
  path: '/runners/:id/unquarantine',
  access: { scopes: ['runner:write'] },
  handler: fleetGuarded((c) => {
    const human = humanCaller(c);
    return c.json({
      runner: fleetOf(c).unquarantine(human, c.req.param('id') ?? ''),
    });
  }),
};

const releaseLease: RouteSpec = {
  method: 'post',
  path: '/runners/leases/:id/release',
  access: { scopes: ['runner:write'] },
  handler: fleetGuarded(async (c) => {
    const human = humanCaller(c);
    const reason = parseReason(await readJson(c));
    return c.json({
      lease: fleetOf(c).releaseLease(human, c.req.param('id') ?? '', reason),
    });
  }),
};

const releaseOffer: RouteSpec = {
  method: 'post',
  path: '/runners/attempts/:id/release',
  access: { scopes: ['runner:write'] },
  handler: fleetGuarded(async (c) => {
    const human = humanCaller(c);
    const reason = parseReason(await readJson(c));
    return c.json(
      fleetOf(c).releaseOffer(human, c.req.param('id') ?? '', reason),
    );
  }),
};

const claim: RouteSpec = {
  method: 'post',
  path: '/runners/claims',
  access: { scopes: ['runner:write'] },
  handler: fleetGuarded(async (c) => {
    const caller = runnerCaller(c);
    return c.json(fleetOf(c).claim(caller, parsePoll(await readJson(c))));
  }),
};

const heartbeat: RouteSpec = {
  method: 'post',
  path: '/runners/heartbeat',
  access: { scopes: ['runner:write'] },
  handler: fleetGuarded(async (c) => {
    const caller = runnerCaller(c);
    return c.json(fleetOf(c).heartbeat(caller, parsePoll(await readJson(c))));
  }),
};

const progress: RouteSpec = {
  method: 'post',
  path: '/runners/leases/:id/progress',
  access: { scopes: ['runner:write'] },
  handler: fleetGuarded(async (c) => {
    const caller = runnerCaller(c);
    const result = fleetOf(c).progress(
      caller,
      c.req.param('id') ?? '',
      parseProgress(await readJson(c)),
    );
    return c.json(result, result.replayed ? 200 : 201);
  }),
};

const checkpoint: RouteSpec = {
  method: 'post',
  path: '/runners/leases/:id/checkpoints',
  access: { scopes: ['runner:write'] },
  handler: fleetGuarded(async (c) => {
    const caller = runnerCaller(c);
    return c.json(
      fleetOf(c).checkpoint(
        caller,
        c.req.param('id') ?? '',
        parseCheckpoint(await readJson(c)),
      ),
      201,
    );
  }),
};

/**
 * Records the Office verdict for a receipt Tower has already accepted and stored. The runner's
 * receipt is never rejected because of it. The outcome is returned, so a runner whose Office
 * contract did not parse is told nothing was ingested instead of getting a plain success.
 */
function ingestOfficeVerdict(
  c: Context<AppEnv>,
  caller: RunnerCaller,
  leaseId: string,
  receiptId: string,
): OfficeIngest {
  const { db, core, now } = c.get('deps');
  if (core === undefined) {
    return { status: 'not_office' };
  }
  const detail = fleetOf(c).leaseDetail(caller.workspaceId, leaseId, {
    principalId: caller.principalId,
    kind: 'runner',
  });
  const stored = detail.receipts.find((r) => r.receiptId === receiptId);
  const mission = core.missions.getMission(
    caller.workspaceId,
    detail.lease.missionId,
  );
  if (mission === undefined) {
    return { status: 'not_office' };
  }
  const outcome = ingestOfficeEvidence(db, {
    workspaceId: caller.workspaceId,
    missionId: detail.lease.missionId,
    packetId: detail.lease.packetId,
    attemptId: detail.lease.attemptId,
    risk: mission.risk,
    callerId: caller.principalId,
    evidence: stored?.evidence,
    recordedAt: (now ?? (() => new Date()))().toISOString(),
  });
  if (outcome.status === 'not_ingested') {
    console.error(
      `office receipt not recorded for lease ${leaseId}: ${outcome.reason}`,
    );
  }
  return outcome;
}

/** The part of the receipt response that tells the runner what became of its Office verdict. */
function officeField(outcome: OfficeIngest) {
  switch (outcome.status) {
    case 'not_office':
      return {};
    case 'ingested':
      return { office: { ingested: true } };
    case 'not_ingested':
      return {
        office: {
          ingested: false,
          reason: outcome.reason,
          message: outcome.message,
        },
      };
  }
}

const receipt: RouteSpec = {
  method: 'post',
  path: '/runners/leases/:id/receipts',
  access: { scopes: ['runner:write'] },
  handler: fleetGuarded(async (c) => {
    const caller = runnerCaller(c);
    const leaseId = c.req.param('id') ?? '';
    const result = fleetOf(c).receipt(
      caller,
      leaseId,
      parseReceipt(await readJson(c)),
    );
    const office = ingestOfficeVerdict(c, caller, leaseId, result.receiptId);
    return c.json(
      { ...result, ...officeField(office) },
      result.replayed ? 200 : 201,
    );
  }),
};

const reconcile: RouteSpec = {
  method: 'post',
  path: '/runners/leases/:id/reconcile',
  access: { scopes: ['runner:write'] },
  handler: fleetGuarded(async (c) => {
    const caller = runnerCaller(c);
    return c.json(
      fleetOf(c).reconcile(
        caller,
        c.req.param('id') ?? '',
        parseReconcile(await readJson(c)),
      ),
    );
  }),
};

export const runnerRoutes: readonly RouteSpec[] = [
  issueEnrollment,
  registerRunner,
  listRunners,
  listLeases,
  readAudit,
  readLease,
  updateRunner,
  quarantineRunner,
  unquarantineRunner,
  releaseLease,
  releaseOffer,
  claim,
  heartbeat,
  progress,
  checkpoint,
  receipt,
  reconcile,
];
