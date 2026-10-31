import {
  type CompletionGuardFailedError,
  CoreError,
  type DependencyCycleError,
  ValidationError,
} from '../core/errors.js';
import {
  IdempotencyKeyReuseError,
  VersionConflictError,
} from '../events/errors.js';
import { FleetError } from '../fleet/errors.js';
import { PolicyDeniedError } from '../policy/errors.js';

export interface ToolFailure {
  code: string;
  message: string;
  details?: unknown;
}

/** A refusal the MCP layer itself makes before or around a tool. */
export class McpToolError extends Error {
  override readonly name = 'McpToolError';

  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/**
 * Turns a domain error into what the model is told. Anything unrecognised becomes a generic
 * `internal_error` so no stack, path or SQL text reaches a client.
 */
export function toFailure(error: unknown): ToolFailure {
  if (error instanceof McpToolError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  if (error instanceof ValidationError) {
    return {
      code: error.code,
      message: error.message,
      details: { issues: error.issues },
    };
  }
  if (error instanceof PolicyDeniedError) {
    return {
      code: error.code,
      message: error.message,
      details: { policyRef: error.policyRef },
    };
  }
  if (error instanceof CoreError) {
    const details =
      error.code === 'completion_guard_failed'
        ? { failures: (error as CompletionGuardFailedError).failures }
        : error.code === 'dependency_cycle'
          ? { path: (error as DependencyCycleError).path }
          : undefined;
    return {
      code: error.code,
      message: error.message,
      ...(details === undefined ? {} : { details }),
    };
  }
  if (error instanceof FleetError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.extra === undefined ? {} : { details: error.extra }),
    };
  }
  if (error instanceof VersionConflictError) {
    return { code: 'version_conflict', message: error.message };
  }
  if (error instanceof IdempotencyKeyReuseError) {
    return { code: 'idempotency_key_reused', message: error.message };
  }
  console.error(
    `mcp tool error: ${error instanceof Error ? error.name : 'unknown'}`,
  );
  return { code: 'internal_error', message: 'Internal server error' };
}
