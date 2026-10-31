import type { Scope } from '../auth/principals.js';
import type { AuthenticatedToken } from '../auth/tokens.js';
import { McpToolError, type ToolFailure, toFailure } from './errors.js';
import {
  classify,
  type JsonRpcError,
  type JsonRpcId,
  type JsonRpcResult,
  RPC_ERRORS,
  rpcError,
  rpcResult,
} from './jsonrpc.js';
import {
  closeSession,
  findSession,
  openSession,
  recordAudit,
  replayFor,
  requestHash,
  storeResult,
} from './store.js';
import {
  type Caller,
  IDEMPOTENCY_KEY,
  type Services,
  type ToolContext,
  type ToolDefinition,
} from './tool.js';
import { findTool, TOOLS } from './tools/index.js';

export const SUPPORTED_PROTOCOLS = [
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;
const SERVER_INFO = { name: 'auto-tower', version: '0.0.0' } as const;
const INSTRUCTIONS =
  'Auto Tower is durable mission control. Call briefing first. Mutating tools need an idempotencyKey. Tools that grant, revoke, dispatch, close or authorize work also need confirm: true. Asking for authority never grants it.';

export interface McpRequest {
  auth: AuthenticatedToken;
  /** Value of the `Mcp-Session-Id` header, if sent. */
  sessionId: string | undefined;
  /** The parsed JSON body. */
  body: unknown;
}

export interface McpResponse {
  status: 200 | 202 | 400 | 403 | 404;
  body?: JsonRpcResult | JsonRpcError;
  headers?: Record<string, string>;
  /** Set on a 403 so the transport can write the `insufficient_scope` challenge. */
  missingScopes?: readonly Scope[];
}

export interface McpServer {
  handle(request: McpRequest): Promise<McpResponse>;
  /** Ends a session its owner holds. False when there was none open. */
  endSession(auth: AuthenticatedToken, sessionId: string): boolean;
}

function describe(tool: ToolDefinition) {
  const properties: Record<string, unknown> = { ...tool.properties };
  const required = [...(tool.required ?? [])];
  if (!tool.readOnly) {
    properties.idempotencyKey = {
      type: 'string',
      maxLength: 100,
      description:
        'Required. Retrying with the same key returns the first result instead of acting twice.',
    };
    required.push('idempotencyKey');
  }
  if (tool.material === true) {
    properties.confirm = {
      const: true,
      description: `Required. Set true to confirm. ${tool.effect ?? ''}`.trim(),
    };
    required.push('confirm');
  }
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    },
    annotations: {
      title: tool.title,
      readOnlyHint: tool.readOnly,
      destructiveHint: tool.material === true,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: {
      'tower/requiredScopes': tool.scopes,
      'tower/mutating': !tool.readOnly,
      'tower/material': tool.material === true,
    },
  };
}

function textResult(
  payload: Record<string, unknown>,
  isError: boolean,
  meta?: Record<string, unknown>,
) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError,
    ...(meta === undefined ? {} : { _meta: meta }),
  };
}

const failureResult = (failure: ToolFailure) =>
  textResult({ error: failure }, true);

export function createMcpServer(services: Services): McpServer {
  const { db, now } = services;
  const inFlight = new Map<
    string,
    { hash: string; tool: string; result: Promise<Record<string, unknown>> }
  >();

  function audit(
    caller: Caller,
    tool: ToolDefinition,
    outcome: 'ok' | 'replayed' | 'refused' | 'error',
    errorCode: string | null,
  ): void {
    try {
      recordAudit(db, {
        workspaceId: caller.workspaceId,
        principalId: caller.actor.id,
        sessionId: caller.sessionId,
        tool: tool.name,
        mutating: !tool.readOnly,
        outcome,
        errorCode,
        now: now(),
      });
    } catch (error) {
      console.error(
        `mcp audit not recorded: ${error instanceof Error ? error.name : 'error'}`,
      );
    }
  }

  async function callTool(
    tool: ToolDefinition,
    rawArgs: Record<string, unknown>,
    caller: Caller,
  ) {
    const refuse = (failure: ToolFailure) => {
      audit(caller, tool, 'refused', failure.code);
      return failureResult(failure);
    };
    const args = { ...rawArgs };
    let key: string | undefined;
    if (!tool.readOnly) {
      const given = args.idempotencyKey;
      delete args.idempotencyKey;
      if (typeof given !== 'string' || !IDEMPOTENCY_KEY.test(given)) {
        return refuse({
          code: 'idempotency_key_required',
          message:
            'A mutating tool needs an idempotencyKey of 1 to 100 printable characters',
        });
      }
      key = given;
    }
    if (tool.material === true) {
      const confirm = args.confirm;
      delete args.confirm;
      if (confirm !== true) {
        return refuse({
          code: 'confirmation_required',
          message:
            `${tool.title} is a material action. Repeat the call with confirm: true to proceed. ${tool.effect ?? ''}`.trim(),
        });
      }
    }
    const owner = {
      workspaceId: caller.workspaceId,
      principalId: caller.actor.id,
    };
    const ctx: ToolContext = {
      services,
      caller,
      command: (idempotencyKey = key) => ({
        workspaceId: caller.workspaceId,
        actor: caller.actor,
        correlationId: idempotencyKey,
        idempotencyKey,
      }),
    };
    try {
      const hash = key === undefined ? '' : requestHash(tool.name, rawArgs);
      if (key === undefined) {
        const { data } = await tool.run(ctx, args, key);
        audit(caller, tool, 'ok', null);
        return textResult(data, false);
      }
      const stored = replayFor(db, owner, key, tool.name, hash);
      if (stored !== undefined) {
        audit(caller, tool, 'replayed', null);
        return textResult(stored, false, { 'tower/replayed': true });
      }
      // An async tool can still be running when its retry arrives, and nothing is stored yet.
      // The retry joins the first call instead of running the tool a second time.
      const flight = `${owner.workspaceId}\0${owner.principalId}\0${key}`;
      const running = inFlight.get(flight);
      if (running !== undefined) {
        if (running.hash !== hash || running.tool !== tool.name) {
          throw new McpToolError(
            'idempotency_key_reused',
            'The idempotency key was already used for a different call',
          );
        }
        const data = await running.result;
        audit(caller, tool, 'replayed', null);
        return textResult(data, false, { 'tower/replayed': true });
      }
      const result = Promise.resolve(tool.run(ctx, args, key)).then(
        (output) => output.data,
      );
      inFlight.set(flight, { hash, tool: tool.name, result });
      let data: Record<string, unknown>;
      try {
        data = await result;
      } finally {
        inFlight.delete(flight);
      }
      // The effect is done. A failure to remember it must not report the call as failed, since a
      // retry would then run it again. The core's own idempotency still covers most tools.
      try {
        storeResult(db, owner, key, tool.name, hash, data, now());
      } catch (storeError) {
        console.error(
          `mcp result not stored: ${storeError instanceof Error ? storeError.name : 'error'}`,
        );
      }
      audit(caller, tool, 'ok', null);
      return textResult(data, false);
    } catch (error) {
      const failure = toFailure(error);
      audit(
        caller,
        tool,
        error instanceof McpToolError ? 'refused' : 'error',
        failure.code,
      );
      return failureResult(failure);
    }
  }

  return {
    endSession: (auth, sessionId) =>
      closeSession(
        db,
        sessionId,
        {
          workspaceId: auth.principal.workspaceId,
          principalId: auth.principal.id,
        },
        now(),
      ),

    async handle({ auth, sessionId, body }) {
      const message = classify(body);
      if (message.kind === 'invalid') {
        return {
          status: 400,
          body: rpcError(
            message.id,
            RPC_ERRORS.invalidRequest,
            'Not a JSON-RPC 2.0 message (batches are not supported)',
          ),
        };
      }
      const owner = {
        workspaceId: auth.principal.workspaceId,
        principalId: auth.principal.id,
      };
      const isInitialize =
        message.kind === 'request' && message.method === 'initialize';
      let session: { id: string } | undefined;
      if (!isInitialize && sessionId !== undefined) {
        session = findSession(db, sessionId, owner, now());
        if (session === undefined) {
          const id: JsonRpcId = message.kind === 'request' ? message.id : null;
          return {
            status: 404,
            body: rpcError(
              id,
              RPC_ERRORS.sessionNotFound,
              'The session is unknown or has ended. Initialize a new one.',
            ),
          };
        }
      }
      if (message.kind !== 'request') {
        return { status: 202 };
      }
      const caller: Caller = {
        workspaceId: auth.principal.workspaceId,
        actor: { id: auth.principal.id, kind: auth.principal.kind },
        scopes: auth.scopes,
        sessionId: session?.id,
      };

      switch (message.method) {
        case 'initialize': {
          const params = (
            typeof message.params === 'object' && message.params !== null
              ? message.params
              : {}
          ) as { protocolVersion?: unknown; clientInfo?: { name?: unknown } };
          const requested = params.protocolVersion;
          const protocolVersion =
            typeof requested === 'string' &&
            (SUPPORTED_PROTOCOLS as readonly string[]).includes(requested)
              ? requested
              : SUPPORTED_PROTOCOLS[0];
          const clientName =
            typeof params.clientInfo?.name === 'string'
              ? params.clientInfo.name.slice(0, 128)
              : null;
          const opened = openSession(db, {
            ...owner,
            protocolVersion,
            clientName,
            now: now(),
          });
          return {
            status: 200,
            headers: { 'Mcp-Session-Id': opened.id },
            body: rpcResult(message.id, {
              protocolVersion,
              capabilities: { tools: { listChanged: false } },
              serverInfo: SERVER_INFO,
              instructions: INSTRUCTIONS,
            }),
          };
        }
        case 'ping':
          return { status: 200, body: rpcResult(message.id, {}) };
        case 'tools/list':
          return {
            status: 200,
            body: rpcResult(message.id, {
              tools: TOOLS.filter((tool) =>
                tool.scopes.every((scope) => auth.scopes.includes(scope)),
              ).map(describe),
            }),
          };
        case 'tools/call': {
          const params = message.params;
          if (
            typeof params !== 'object' ||
            params === null ||
            typeof (params as { name?: unknown }).name !== 'string'
          ) {
            return {
              status: 200,
              body: rpcError(
                message.id,
                RPC_ERRORS.invalidParams,
                'tools/call needs a tool name',
              ),
            };
          }
          const { name, arguments: given } = params as {
            name: string;
            arguments?: unknown;
          };
          const tool = findTool(name);
          if (tool === undefined) {
            return {
              status: 200,
              body: rpcError(
                message.id,
                RPC_ERRORS.invalidParams,
                'Unknown tool',
              ),
            };
          }
          if (
            given !== undefined &&
            given !== null &&
            (typeof given !== 'object' || Array.isArray(given))
          ) {
            return {
              status: 200,
              body: rpcError(
                message.id,
                RPC_ERRORS.invalidParams,
                'arguments must be an object',
              ),
            };
          }
          const missing = tool.scopes.filter(
            (scope) => !auth.scopes.includes(scope),
          );
          if (missing.length > 0) {
            audit(caller, tool, 'refused', 'insufficient_scope');
            return {
              status: 403,
              missingScopes: missing,
              body: rpcError(
                message.id,
                RPC_ERRORS.forbidden,
                'The credential lacks a scope this tool requires',
                { requiredScopes: tool.scopes },
              ),
            };
          }
          const result = await callTool(
            tool,
            (given ?? {}) as Record<string, unknown>,
            caller,
          );
          return { status: 200, body: rpcResult(message.id, result) };
        }
        default:
          return {
            status: 200,
            body: rpcError(
              message.id,
              RPC_ERRORS.methodNotFound,
              'Method not found',
            ),
          };
      }
    },
  };
}
