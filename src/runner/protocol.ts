/**
 * The runner's view of `tower.runner.v1`. These types are written from docs/runner-protocol.md, not
 * imported from Tower's fleet module, so the runner depends on the wire and nothing else.
 */

export interface Binding {
  version: string;
  buildDigest: string;
}

export interface Directives {
  cancel: boolean;
  pause: boolean;
}

export interface LeaseView {
  leaseId: string;
  attemptId: string;
  scopeKey: string;
  fence: number;
  status: string;
  expiresAt: string;
  progressSeq: number;
  directives: Directives;
}

export interface Resume {
  progressSeq: number;
  checkpoint: { ref: string; commit: string | null } | null;
}

export interface Assignment extends LeaseView {
  missionId: string;
  packetId: string;
  ttlMs: number;
  packet: { title: string; instructions: string; scope: string[] };
  mission: {
    title: string;
    intent: string;
    outcome: string;
    constraints: string[];
  };
  resume: Resume | null;
}

/** Evidence that matched nothing. `cancel` means Tower closed the lease and the runner must stop. */
export interface Unmatched {
  leaseId: string;
  reason: string;
  cancel: boolean;
}

export interface ClaimResponse {
  leases: LeaseView[];
  unmatched: Unmatched[];
  reconcile: LeaseView[];
  assignments: Assignment[];
  withheld: Array<{ attemptId: string; reason: string }>;
  retryAfterMs: number;
}

export interface ReconcileResponse {
  lease: LeaseView;
  assignment: Assignment | null;
  withheld: string | null;
  resume: Resume;
}

export interface RegisterResponse {
  runnerId: string;
  token: string;
  pollIntervalMs: number;
}

export interface ProgressResponse {
  seq: number;
  replayed: boolean;
  directives: Directives;
}

export interface ReceiptResponse {
  receiptId: string;
  replayed: boolean;
  /**
   * Present when the receipt claimed the Office contract. `ingested: false` means Tower stored the
   * receipt but did not read an Office verdict from it, and says why. A runner that sees it must
   * not treat the work as reviewed.
   */
  office?: { ingested: boolean; reason?: string; message?: string };
}

/** The active-lease evidence a poll presents. Only what Tower already stored may be claimed. */
export interface Evidence {
  leaseId: string;
  attemptId: string;
  fence: number;
  progressSeq: number;
}

/** A receipt body. Its `receiptId` is the idempotency key, so a resend is a replay. */
export interface ReceiptBody {
  receiptId: string;
  fence: number;
  outcome: 'succeeded' | 'failed';
  summary: string;
  evidence: Record<string, unknown>;
}

/** Thrown when a response does not have the shape the protocol promises. */
export class ProtocolShapeError extends Error {
  override readonly name = 'ProtocolShapeError';
}

export function expectObject(
  value: unknown,
  what: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProtocolShapeError(`${what} is not an object`);
  }
  return value as Record<string, unknown>;
}

export function expectArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ProtocolShapeError(`${what} is not an array`);
  }
  return value;
}

export function expectString(value: unknown, what: string): string {
  if (typeof value !== 'string') {
    throw new ProtocolShapeError(`${what} is not a string`);
  }
  return value;
}

export function expectNumber(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ProtocolShapeError(`${what} is not a number`);
  }
  return value;
}

export function parseLeaseView(value: unknown): LeaseView {
  const o = expectObject(value, 'lease');
  const directives = expectObject(o.directives, 'lease.directives');
  return {
    leaseId: expectString(o.leaseId, 'lease.leaseId'),
    attemptId: expectString(o.attemptId, 'lease.attemptId'),
    scopeKey: expectString(o.scopeKey, 'lease.scopeKey'),
    fence: expectNumber(o.fence, 'lease.fence'),
    status: expectString(o.status, 'lease.status'),
    expiresAt: expectString(o.expiresAt, 'lease.expiresAt'),
    progressSeq: expectNumber(o.progressSeq, 'lease.progressSeq'),
    directives: {
      cancel: directives.cancel === true,
      pause: directives.pause === true,
    },
  };
}

export function parseAssignment(value: unknown): Assignment {
  const o = expectObject(value, 'assignment');
  const packet = expectObject(o.packet, 'assignment.packet');
  const mission = expectObject(o.mission, 'assignment.mission');
  return {
    ...parseLeaseView(o),
    missionId: expectString(o.missionId, 'assignment.missionId'),
    packetId: expectString(o.packetId, 'assignment.packetId'),
    ttlMs: expectNumber(o.ttlMs, 'assignment.ttlMs'),
    packet: {
      title: expectString(packet.title, 'packet.title'),
      instructions: expectString(packet.instructions, 'packet.instructions'),
      scope: expectArray(packet.scope, 'packet.scope').map((s) =>
        expectString(s, 'packet.scope[]'),
      ),
    },
    mission: {
      title: expectString(mission.title, 'mission.title'),
      intent: expectString(mission.intent, 'mission.intent'),
      outcome: expectString(mission.outcome, 'mission.outcome'),
      constraints: expectArray(mission.constraints, 'mission.constraints').map(
        (s) => expectString(s, 'mission.constraints[]'),
      ),
    },
    resume:
      o.resume === null || o.resume === undefined
        ? null
        : parseResume(o.resume),
  };
}

export function parseResume(value: unknown): Resume {
  const o = expectObject(value, 'resume');
  const checkpoint =
    o.checkpoint === null || o.checkpoint === undefined
      ? null
      : expectObject(o.checkpoint, 'resume.checkpoint');
  return {
    progressSeq: expectNumber(o.progressSeq, 'resume.progressSeq'),
    checkpoint:
      checkpoint === null
        ? null
        : {
            ref: expectString(checkpoint.ref, 'checkpoint.ref'),
            commit:
              checkpoint.commit === null || checkpoint.commit === undefined
                ? null
                : expectString(checkpoint.commit, 'checkpoint.commit'),
          },
  };
}

export function parseClaim(value: unknown): ClaimResponse {
  const o = expectObject(value, 'claim response');
  return {
    leases: expectArray(o.leases, 'leases').map(parseLeaseView),
    unmatched: expectArray(o.unmatched, 'unmatched').map((u) => {
      const item = expectObject(u, 'unmatched[]');
      return {
        leaseId: expectString(item.leaseId, 'unmatched.leaseId'),
        reason: expectString(item.reason, 'unmatched.reason'),
        cancel: item.cancel === true,
      };
    }),
    reconcile: expectArray(o.reconcile, 'reconcile').map(parseLeaseView),
    assignments: expectArray(o.assignments, 'assignments').map(parseAssignment),
    withheld: expectArray(o.withheld, 'withheld').map((w) => {
      const item = expectObject(w, 'withheld[]');
      return {
        attemptId: expectString(item.attemptId, 'withheld.attemptId'),
        reason: expectString(item.reason, 'withheld.reason'),
      };
    }),
    retryAfterMs: expectNumber(o.retryAfterMs, 'retryAfterMs'),
  };
}

export function parseReconcile(value: unknown): ReconcileResponse {
  const o = expectObject(value, 'reconcile response');
  return {
    lease: parseLeaseView(o.lease),
    assignment:
      o.assignment === null || o.assignment === undefined
        ? null
        : parseAssignment(o.assignment),
    withheld:
      o.withheld === null || o.withheld === undefined
        ? null
        : expectString(o.withheld, 'withheld'),
    resume: parseResume(o.resume),
  };
}

export function parseRegister(value: unknown): RegisterResponse {
  const o = expectObject(value, 'register response');
  return {
    runnerId: expectString(o.runnerId, 'runnerId'),
    token: expectString(o.token, 'token'),
    pollIntervalMs: expectNumber(o.pollIntervalMs, 'pollIntervalMs'),
  };
}

export function parseProgress(value: unknown): ProgressResponse {
  const o = expectObject(value, 'progress response');
  const directives = expectObject(o.directives, 'directives');
  return {
    seq: expectNumber(o.seq, 'seq'),
    replayed: o.replayed === true,
    directives: {
      cancel: directives.cancel === true,
      pause: directives.pause === true,
    },
  };
}

export function parseReceiptResponse(value: unknown): ReceiptResponse {
  const o = expectObject(value, 'receipt response');
  const response: ReceiptResponse = {
    receiptId: expectString(o.receiptId, 'receiptId'),
    replayed: o.replayed === true,
  };
  if (o.office !== undefined) {
    const office = expectObject(o.office, 'office');
    response.office = {
      ingested: office.ingested === true,
      ...(typeof office.reason === 'string' ? { reason: office.reason } : {}),
      ...(typeof office.message === 'string'
        ? { message: office.message }
        : {}),
    };
  }
  return response;
}
