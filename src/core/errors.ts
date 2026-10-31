/** Typed domain errors. `code` is stable and is what the HTTP layer maps to a response. */
export abstract class CoreError extends Error {
  abstract readonly code: string;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export class ValidationError extends CoreError {
  override readonly name = 'ValidationError';
  readonly code = 'validation_failed';

  constructor(readonly issues: readonly ValidationIssue[]) {
    super(
      `Invalid input: ${issues.map((i) => `${i.path || '(body)'} ${i.message}`).join('; ')}`,
    );
  }
}

export class MissionNotFoundError extends CoreError {
  override readonly name = 'MissionNotFoundError';
  readonly code = 'mission_not_found';

  constructor(readonly missionId: string) {
    super(`Mission ${missionId} was not found`);
  }
}

export class PacketNotFoundError extends CoreError {
  override readonly name = 'PacketNotFoundError';
  readonly code = 'packet_not_found';

  constructor(readonly packetId: string) {
    super(`Work packet ${packetId} was not found in this mission`);
  }
}

export class AttemptNotFoundError extends CoreError {
  override readonly name = 'AttemptNotFoundError';
  readonly code = 'attempt_not_found';

  constructor(readonly attemptId: string) {
    super(`Execution attempt ${attemptId} was not found in this mission`);
  }
}

export class InvalidTransitionError extends CoreError {
  override readonly name = 'InvalidTransitionError';
  readonly code = 'invalid_transition';

  constructor(
    readonly entity: 'mission' | 'packet' | 'attempt',
    readonly entityId: string,
    readonly from: string,
    readonly to: string,
  ) {
    super(`A ${entity} cannot move from ${from} to ${to}`);
  }
}

/** The command is not valid in the entity's current state, though no transition is named. */
export class CommandNotAllowedError extends CoreError {
  override readonly name = 'CommandNotAllowedError';
  readonly code = 'command_not_allowed';

  constructor(
    readonly command: string,
    readonly reason: string,
  ) {
    super(`${command} is not allowed: ${reason}`);
  }
}

export interface GuardFailure {
  guard: string;
  reason: string;
}

export class CompletionGuardFailedError extends CoreError {
  override readonly name = 'CompletionGuardFailedError';
  readonly code = 'completion_guard_failed';

  constructor(
    readonly missionId: string,
    readonly failures: readonly GuardFailure[],
  ) {
    super(
      `Mission ${missionId} cannot complete: ${failures.map((f) => `${f.guard} (${f.reason})`).join('; ')}`,
    );
  }
}

export class DependencyCycleError extends CoreError {
  override readonly name = 'DependencyCycleError';
  readonly code = 'dependency_cycle';

  constructor(readonly path: readonly string[]) {
    super(`Dependency cycle: ${path.join(' -> ')}`);
  }
}

/** The acting principal's kind may not issue this command. */
export class ForbiddenActorError extends CoreError {
  override readonly name = 'ForbiddenActorError';
  readonly code = 'forbidden_actor';

  constructor(
    readonly command: string,
    readonly actorKind: string,
  ) {
    super(`A ${actorKind} principal may not ${command}`);
  }
}

/** The verifier is the same principal that produced the result being verified. */
export class SelfVerificationError extends CoreError {
  override readonly name = 'SelfVerificationError';
  readonly code = 'self_verification';

  constructor(readonly command: string) {
    super(`${command} must come from a principal other than the producer`);
  }
}
