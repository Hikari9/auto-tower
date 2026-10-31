export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export const RPC_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  /** Application range: the credential is valid but lacks a scope the call needs. */
  forbidden: -32001,
  /** Application range: the session id is unknown, closed or belongs to another principal. */
  sessionNotFound: -32002,
} as const;

export interface JsonRpcError {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: { code: number; message: string; data?: unknown };
}

export interface JsonRpcResult {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: unknown;
}

export function rpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcError {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

export function rpcResult(id: JsonRpcId, result: unknown): JsonRpcResult {
  return { jsonrpc: '2.0', id, result };
}

/** A request, a notification (no id) or something that is neither. */
export type ParsedMessage =
  | { kind: 'request'; id: JsonRpcId; method: string; params: unknown }
  | { kind: 'notification'; method: string; params: unknown }
  | { kind: 'response' }
  | { kind: 'invalid'; id: JsonRpcId };

export function classify(body: unknown): ParsedMessage {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { kind: 'invalid', id: null };
  }
  const message = body as Record<string, unknown>;
  const rawId = message.id;
  const id: JsonRpcId =
    typeof rawId === 'string' || typeof rawId === 'number' ? rawId : null;
  if (message.jsonrpc !== '2.0') {
    return { kind: 'invalid', id };
  }
  if (typeof message.method !== 'string') {
    // A client answering a server request. Tower sends none, so there is nothing to match it to.
    return 'result' in message || 'error' in message
      ? { kind: 'response' }
      : { kind: 'invalid', id };
  }
  if (rawId === undefined) {
    return {
      kind: 'notification',
      method: message.method,
      params: message.params,
    };
  }
  if (id === null) {
    return { kind: 'invalid', id: null };
  }
  return {
    kind: 'request',
    id,
    method: message.method,
    params: message.params,
  };
}
