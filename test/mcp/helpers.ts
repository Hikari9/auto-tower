export interface Reply {
  status: number;
  headers: Headers;
  // biome-ignore lint/suspicious/noExplicitAny: replies are untyped JSON
  body: any;
}

export type Requester = (path: string, init: RequestInit) => Promise<Response>;

export const appRequester =
  (app: {
    request: (path: string, init?: RequestInit) => Response | Promise<Response>;
  }): Requester =>
  (path, init) =>
    Promise.resolve(app.request(path, init));

export interface ToolReply {
  status: number;
  isError: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: tool data is untyped JSON
  data: any;
  meta: Record<string, unknown> | undefined;
  reply: Reply;
}

/** A minimal MCP client over the app's own fetch, so no socket is opened. */
export class McpClient {
  sessionId: string | undefined;
  private nextId = 1;

  constructor(
    private readonly request: Requester,
    readonly token: string | undefined,
    private readonly extraHeaders: Record<string, string> = {},
  ) {}

  async post(
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<Reply> {
    const res = await this.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(this.token === undefined
          ? {}
          : { authorization: `Bearer ${this.token}` }),
        ...(this.sessionId === undefined
          ? {}
          : { 'mcp-session-id': this.sessionId }),
        ...this.extraHeaders,
        ...headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    return {
      status: res.status,
      headers: res.headers,
      body: text === '' ? undefined : JSON.parse(text),
    };
  }

  async rpc(method: string, params?: unknown): Promise<Reply> {
    return this.post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method,
      ...(params === undefined ? {} : { params }),
    });
  }

  async initialize(protocolVersion = '2025-06-18'): Promise<Reply> {
    const reply = await this.rpc('initialize', {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1' },
    });
    this.sessionId = reply.headers.get('mcp-session-id') ?? undefined;
    return reply;
  }

  async call(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<ToolReply> {
    const reply = await this.rpc('tools/call', { name, arguments: args });
    const result = reply.body?.result;
    return {
      status: reply.status,
      isError: result?.isError === true,
      data: result?.structuredContent,
      meta: result?._meta,
      reply,
    };
  }

  /** Calls a tool and fails the test if it did not succeed. */
  async ok(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<ToolReply['data']> {
    const reply = await this.call(name, args);
    if (reply.isError || reply.status !== 200) {
      throw new Error(
        `${name} failed: ${reply.status} ${JSON.stringify(reply.data ?? reply.reply.body)}`,
      );
    }
    return reply.data;
  }
}

let counter = 0;
/** A fresh idempotency key. */
export const key = (label = 'k'): string => `${label}-${++counter}`;
