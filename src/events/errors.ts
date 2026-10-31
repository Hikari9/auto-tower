export class VersionConflictError extends Error {
  override readonly name = 'VersionConflictError';

  constructor(
    readonly streamId: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(
      `Stream ${streamId} is at version ${actualVersion}, expected ${expectedVersion}`,
    );
  }
}

export class IdempotencyKeyReuseError extends Error {
  override readonly name = 'IdempotencyKeyReuseError';

  constructor(readonly idempotencyKey: string) {
    super(
      `Idempotency key ${idempotencyKey} was already used for a different request`,
    );
  }
}
