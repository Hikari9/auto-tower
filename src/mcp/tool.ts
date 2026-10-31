import type { Scope } from '../auth/principals.js';
import type { Core } from '../core/index.js';
import type { CommandContext } from '../core/service.js';
import type { Actor } from '../core/types.js';
import type { Authority } from '../decisions/index.js';
import type { Fleet } from '../fleet/index.js';
import type { IssueService } from '../issues/index.js';
import type { SqlDatabase } from '../storage/database.js';
import type { McpSettings } from './settings.js';

/** Everything a tool may touch. Built once per server from the same services the HTTP routes use. */
export interface Services {
  db: SqlDatabase;
  core: Core;
  authority: Authority;
  fleet: Fleet;
  issues: IssueService;
  settings: McpSettings;
  now: () => Date;
}

export interface Caller {
  workspaceId: string;
  actor: Actor;
  scopes: readonly Scope[];
  sessionId: string | undefined;
}

export interface ToolContext {
  services: Services;
  caller: Caller;
  /** Core command context. The idempotency key is the tool call's own, or undefined for a read. */
  command(idempotencyKey?: string): CommandContext;
}

/** What the model sees. Structured content carries the data and the text mirrors it. */
export interface ToolOutput {
  data: Record<string, unknown>;
}

export type JsonSchema = Record<string, unknown>;

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  /** True when the call writes nothing. A read-only tool takes no idempotency key. */
  readOnly: boolean;
  /** Every one is required. The server checks them before the tool runs. */
  scopes: readonly [Scope, ...Scope[]];
  /**
   * Never answered from a stored result. For a tool whose answer is the live state of something that
   * can change between two calls with one key (halt, resume, the storage guard): a retry runs again,
   * so a stale `halted: true` is never returned for a workspace that has since resumed.
   */
  noReplay?: boolean;
  /** Grant, revoke, dispatch request and close. The call must carry `confirm: true`. */
  material?: boolean;
  /** Properties of the call, without `idempotencyKey` and `confirm`, which the server adds. */
  properties: Record<string, JsonSchema>;
  required?: readonly string[];
  /** Plain statement of what a confirmed call does, shown when confirmation is missing. */
  effect?: string;
  run(
    ctx: ToolContext,
    args: Record<string, unknown>,
    idempotencyKey: string | undefined,
  ): Promise<ToolOutput> | ToolOutput;
}

export const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,100}$/;
