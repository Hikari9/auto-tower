import type { Context } from 'hono';
import {
  type CompletionGuardFailedError,
  CoreError,
  type DependencyCycleError,
  MissionNotFoundError,
  ValidationError,
} from '../../core/errors.js';
import { type Core, createCore } from '../../core/index.js';
import {
  parseActivity,
  parseCancel,
  parseCreateMission,
  parseEvidenceCommand,
  parseSearch,
  parseTransition,
  parseUpdateMission,
} from '../../core/inputs.js';
import type { CommandContext, CommandResult } from '../../core/service.js';
import type { AppDependencies, AppEnv, RouteSpec } from '../app.js';

const MAX_BODY_BYTES = 256 * 1024;
const HEADER_TOKEN = /^[\x21-\x7e]{1,128}$/;

type RouteHandler = (c: Context<AppEnv>) => Response | Promise<Response>;

/** A request the HTTP layer itself refuses before the core sees it. */
class RequestError extends Error {
  override readonly name = 'RequestError';

  constructor(
    readonly status: 400 | 413,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const cores = new WeakMap<AppDependencies, Core>();

/** The core for this app. Built once per set of dependencies unless the host supplied one. */
export function coreOf(c: Context<AppEnv>): Core {
  const deps = c.get('deps');
  if (deps.core !== undefined) {
    return deps.core;
  }
  let core = cores.get(deps);
  if (core === undefined) {
    core = createCore({
      db: deps.db,
      ...(deps.now === undefined ? {} : { clock: deps.now }),
    });
    cores.set(deps, core);
  }
  return core;
}

/** Who is calling and in which workspace, taken from the verified token and nothing else. */
export function callerOf(
  c: Context<AppEnv>,
): Pick<CommandContext, 'workspaceId' | 'actor'> {
  const { principal } = c.get('auth');
  return {
    workspaceId: principal.workspaceId,
    actor: { id: principal.id, kind: principal.kind },
  };
}

function headerToken(c: Context<AppEnv>, name: string): string | undefined {
  const value = c.req.header(name);
  if (value === undefined) {
    return undefined;
  }
  if (!HEADER_TOKEN.test(value)) {
    throw new RequestError(
      400,
      'invalid_header',
      `${name} must be 1 to 128 printable characters`,
    );
  }
  return value;
}

export function commandContext(c: Context<AppEnv>): CommandContext {
  return {
    ...callerOf(c),
    correlationId: headerToken(c, 'x-correlation-id'),
    idempotencyKey: headerToken(c, 'idempotency-key'),
  };
}

/** Reads a JSON body, refusing anything over the size cap without buffering it all. */
export async function readJson(c: Context<AppEnv>): Promise<unknown> {
  const declared = Number(c.req.header('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) {
    throw new RequestError(
      413,
      'payload_too_large',
      'The request body is too large',
    );
  }
  const stream = c.req.raw.body;
  if (stream === null) {
    throw new RequestError(400, 'invalid_json', 'A JSON body is required');
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new RequestError(
        413,
        'payload_too_large',
        'The request body is too large',
      );
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new RequestError(400, 'invalid_json', 'The body is not valid JSON');
  }
}

const STATUS_BY_CODE: Readonly<Record<string, 400 | 403 | 404 | 409 | 422>> = {
  validation_failed: 400,
  mission_not_found: 404,
  packet_not_found: 404,
  attempt_not_found: 404,
  invalid_transition: 409,
  command_not_allowed: 409,
  completion_guard_failed: 409,
  dependency_cycle: 422,
  forbidden_actor: 403,
  self_verification: 403,
};

function errorResponse(c: Context<AppEnv>, error: CoreError): Response {
  const details =
    error instanceof ValidationError
      ? { issues: error.issues }
      : error.code === 'completion_guard_failed'
        ? { failures: (error as CompletionGuardFailedError).failures }
        : error.code === 'dependency_cycle'
          ? { path: (error as DependencyCycleError).path }
          : undefined;
  return c.json(
    {
      error: {
        code: error.code,
        message: error.message,
        ...(details === undefined ? {} : { details }),
      },
    },
    STATUS_BY_CODE[error.code] ?? 409,
  );
}

/**
 * Turns the core's typed errors and the HTTP layer's own request errors into JSON
 * responses. Anything else is rethrown to the app's error handler, which answers a
 * generic 500, and version and idempotency conflicts, which it already maps.
 */
export function guarded(handler: RouteHandler): RouteHandler {
  return async (c) => {
    try {
      return await handler(c);
    } catch (error) {
      if (error instanceof CoreError) {
        return errorResponse(c, error);
      }
      if (error instanceof RequestError) {
        return c.json(
          { error: { code: error.code, message: error.message } },
          error.status,
        );
      }
      throw error;
    }
  };
}

/** The response shape shared by every command. */
function commandBody(result: CommandResult) {
  return {
    mission: result.mission,
    event: {
      seq: result.event.seq,
      version: result.event.version,
      type: result.event.type,
      correlationId: result.event.correlationId,
    },
    replayed: result.replayed,
  };
}

/** 201 for the first creation, 200 for a replay or any non-creating command. */
export function respond(
  c: Context<AppEnv>,
  result: CommandResult,
  created = false,
): Response {
  return c.json(commandBody(result), created && !result.replayed ? 201 : 200);
}

const createMission: RouteSpec = {
  method: 'post',
  path: '/missions',
  access: { scopes: ['mission:write'] },
  handler: guarded(async (c) => {
    const input = parseCreateMission(await readJson(c));
    return respond(
      c,
      coreOf(c).missions.createMission(commandContext(c), input),
      true,
    );
  }),
};

const searchMissions: RouteSpec = {
  method: 'get',
  path: '/missions',
  access: { scopes: ['mission:read'] },
  handler: guarded((c) => {
    const query = parseSearch(c.req.query());
    const { workspaceId } = callerOf(c);
    return c.json(coreOf(c).missions.search(workspaceId, query));
  }),
};

const readMission: RouteSpec = {
  method: 'get',
  path: '/missions/:id',
  access: { scopes: ['mission:read'] },
  handler: guarded((c) => {
    const id = c.req.param('id') ?? '';
    const mission = coreOf(c).missions.getMission(callerOf(c).workspaceId, id);
    if (mission === undefined) {
      throw new MissionNotFoundError(id);
    }
    return c.json({ mission });
  }),
};

const updateMission: RouteSpec = {
  method: 'patch',
  path: '/missions/:id',
  access: { scopes: ['mission:write'] },
  handler: guarded(async (c) => {
    const { expectedVersion, changes } = parseUpdateMission(await readJson(c));
    return respond(
      c,
      coreOf(c).missions.updateMission(
        commandContext(c),
        c.req.param('id') ?? '',
        expectedVersion,
        changes,
      ),
    );
  }),
};

/** Cancels Tower's mission and its packets. Linked external issues are never touched. */
const cancelMission: RouteSpec = {
  method: 'post',
  path: '/missions/:id/cancel',
  access: { scopes: ['mission:write'] },
  handler: guarded(async (c) => {
    const { expectedVersion, reason } = parseCancel(await readJson(c));
    return respond(
      c,
      coreOf(c).missions.cancelMission(
        commandContext(c),
        c.req.param('id') ?? '',
        expectedVersion,
        reason,
      ),
    );
  }),
};

const transitionMission: RouteSpec = {
  method: 'post',
  path: '/missions/:id/transitions',
  access: { scopes: ['mission:write'] },
  handler: guarded(async (c) => {
    const { expectedVersion, to, reason } = parseTransition(await readJson(c));
    return respond(
      c,
      coreOf(c).missions.transitionMission(
        commandContext(c),
        c.req.param('id') ?? '',
        expectedVersion,
        to,
        reason,
      ),
    );
  }),
};

const verifyOutcome: RouteSpec = {
  method: 'post',
  path: '/missions/:id/outcome-verification',
  access: { scopes: ['mission:write'] },
  handler: guarded(async (c) => {
    const { expectedVersion, evidenceRefs } = parseEvidenceCommand(
      await readJson(c),
    );
    return respond(
      c,
      coreOf(c).missions.verifyOutcome(
        commandContext(c),
        c.req.param('id') ?? '',
        expectedVersion,
        evidenceRefs,
      ),
    );
  }),
};

const readActivity: RouteSpec = {
  method: 'get',
  path: '/missions/:id/activity',
  access: { scopes: ['mission:read'] },
  handler: guarded((c) => {
    const page = parseActivity(c.req.query());
    return c.json(
      coreOf(c).missions.activity(
        callerOf(c).workspaceId,
        c.req.param('id') ?? '',
        page,
      ),
    );
  }),
};

export const missionRoutes: readonly RouteSpec[] = [
  createMission,
  searchMissions,
  readMission,
  updateMission,
  cancelMission,
  transitionMission,
  verifyOutcome,
  readActivity,
];
