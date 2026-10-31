# MCP Endpoint and OAuth Resource Surface

How an AI client (a Chief of Staff in ChatGPT, Claude or another MCP client) reads and drives Tower, and how that access is authenticated. Code lives in `src/mcp/`, `src/auth/oauth/`, `src/api/routes/mcp.ts` and `src/api/routes/oauth.ts`. The schema is `migrations/0007_mcp.sql`.

## What it is

One endpoint, `POST /mcp`, speaks MCP over Streamable HTTP, JSON responses only. Tower is the **resource server**. It never mints OAuth tokens. The identity provider is a port (`AuthProvider`), faked in tests and listed in `DEFERRED.md` with ChatGPT connector registration.

The endpoint is a second front door onto the same services as the HTTP API, not a second implementation. `createApp` resolves one core, authority layer, fleet and issue service through `resolveDependencies` (`src/api/app.ts`), and the MCP server is built only from that result. It cannot build a core of its own, so every registered completion guard (the core guards, the required-issues guard, the Auto-Office high-risk review guard) applies to a mission closed over MCP exactly as it does over HTTP. A core a host injects gets the Auto-Office and required-issues guards registered on it when it lacks them, idempotently by name.

| Method and path                                   | Purpose                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------- |
| `POST /mcp`                                       | JSON-RPC 2.0 request or notification. 200 with a body, 202 without. |
| `GET /mcp`                                        | 405 for a caller who authenticates. Tower opens no server stream.   |
| `DELETE /mcp`                                     | Ends the session named by `Mcp-Session-Id`. 204, or 404 if none.    |
| `GET /.well-known/oauth-protected-resource[/mcp]` | RFC 9728 metadata. Public. 404 until a provider is configured.      |

Protocol versions `2025-06-18`, `2025-03-26` and `2024-11-05` are accepted. An unknown version gets the newest. Batches are refused with 400. Bodies are capped at 256 KiB.

## Authentication

Every call needs `Authorization: Bearer <token>`. Two kinds are accepted:

1. **A Tower token** (`twr_…`), exactly as the HTTP API takes. Its scopes are the token's.
2. **A provider access token**, when `mcp.publicBaseUrl` and `mcp.authProvider` are set. Tower asks the provider to verify it, then refuses unless all of these hold: the issuer is one the provider lists, the audience includes `<publicBaseUrl>/mcp` (so a token minted for another service is useless here), it has not expired, a human linked that `(issuer, subject)` to a Tower principal, the link is not revoked and the principal is not disabled. The scopes are the **intersection** of what the provider granted, what the link allows and what the principal's kind may ever hold, so a provider cannot widen a Chief of Staff into a policy writer.

Provider tokens work on `/mcp` only. The HTTP API takes Tower tokens.

Failures follow the MCP authorization spec:

- No credential: `401`, `WWW-Authenticate: Bearer resource_metadata="<publicBaseUrl>/.well-known/oauth-protected-resource/mcp"`.
- A credential that does not verify: `401`, the same plus `error="invalid_token"`.
- A tool the credential's scopes do not cover: `403`, `error="insufficient_scope", scope="<needed>"`, plus the metadata URL.

Without a configured provider the challenge is a plain `Bearer`, because Tower will not name an authorization server it does not have. `publicBaseUrl` is configuration, never read from request headers, and must be an https origin (or loopback http) with no path. A bad value fails `createApp` at startup.

A request carrying an `Origin` header is refused unless the origin is in `mcp.allowedOrigins`, which defaults to empty. This stops a web page from driving a local Tower. Server-to-server clients send no `Origin`.

## Sessions

`initialize` opens a session and returns `Mcp-Session-Id`. Sessions are rows in `mcp_sessions`, bound to the principal that opened them. Another principal's id looks the same as an unknown one (404). Sessions survive a restart. A client that never initializes still works, since a session carries no authority: the credential does.

## Tools

Each tool declares, in `tools/list`, `annotations.readOnlyHint`, `destructiveHint`, and `_meta["tower/requiredScopes"]`, `"tower/mutating"`, `"tower/material"`. `tools/list` returns only the tools the caller's scopes cover. Calling one without its scopes is refused with 403 whatever the listing said.

| Tool                     | Kind     | Scopes           | Does                                                                                                                          |
| ------------------------ | -------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `briefing`               | read     | `mission:read`   | Missions by state, what blocks them, open decisions (only with `decision:read`).                                              |
| `search_missions`        | read     | `mission:read`   | Search by text, state, parent, priority, risk.                                                                                |
| `read_mission`           | read     | `mission:read`   | One mission with packets, attempts, links, verification, and any claim-time authority holds (as the HTTP route reports them). |
| `recent_activity`        | read     | `mission:read`   | Latest events, or one mission's history. No payloads in the cross-mission view.                                               |
| `list_runs`              | read     | `mission:read`   | Execution attempts. A claim is labelled self-reported. A runner principal sees only its own attempts.                         |
| `inspect_evidence`       | read     | `mission:read`   | Verification, runner claims, Auto-Office receipt facts, issue links.                                                          |
| `preview_dispatch`       | read     | `mission:read`   | What `request_dispatch` would do, and whether cited policy would be accepted.                                                 |
| `list_runners`           | read     | `runner:read`    | Enrolled runners. A runner principal sees only itself.                                                                        |
| `list_decisions`         | read     | `decision:read`  | Decision Inbox items.                                                                                                         |
| `read_policy`            | read     | `policy:read`    | Policy version, active rules, pending proposals.                                                                              |
| `read_feature_flags`     | read     | `policy:read`    | The two flags and why a requested one is not in effect.                                                                       |
| `create_mission`         | mutating | `mission:write`  | Creates a draft mission.                                                                                                      |
| `update_mission`         | mutating | `mission:write`  | Changes descriptive fields. Risk lowering by a Chief of Staff is refused and receipted.                                       |
| `request_reconciliation` | material | `mission:write`  | Reads linked issues back from the provider. Writes nothing to a provider, and can put the mission in needs-attention.         |
| `answer_decision`        | material | `decision:write` | Answers a decision. Only the authority it requires may.                                                                       |
| `request_expansion`      | material | `decision:write` | Settles work beyond a mission's authorization at the right tier. Asking approves nothing.                                     |
| `propose_policy_change`  | mutating | `decision:write` | Raises a decision for a person. Changes no policy.                                                                            |
| `close_mission`          | material | `mission:write`  | `completed` (runs every guard) or `cancelled`.                                                                                |
| `request_dispatch`       | material | `mission:write`  | Authorizes one packet and runs one scheduler pass.                                                                            |
| `grant_policy`           | material | `policy:write`   | Creates an allow rule. Humans only.                                                                                           |
| `revoke_policy`          | material | `policy:write`   | Revokes a rule. Blocks the next guarded effect at once. Humans only.                                                          |
| `set_feature_flag`       | material | `policy:write`   | Turns a flag on or off. Humans only. The flag counts only the rule it names. Every change is kept in the flag history.        |
| `read_audit`             | read     | `policy:read`    | Append-only history: `feature_flags` (who, old and new setting, rule, time) or `tool_calls` (no arguments or results).        |
| `read_health`            | read     | `policy:read`    | Status (`ok`, `degraded`, `critical`, `halted`), active signals with what to do, and recent halts. See `docs/operations.md`.  |
| `halt_workspace`         | material | `policy:write`   | Emergency halt: stops new dispatch and guarded effects, keeps all state. Humans only.                                         |
| `resume_workspace`       | material | `policy:write`   | Lifts the halt. Humans only.                                                                                                  |
| `reset_storage_guard`    | material | `policy:write`   | Clears the storage guard after space was freed. Humans only. Trips again if the store is still full.                          |

**Mutating** tools require an `idempotencyKey` (1 to 100 printable characters). The first result is stored in `mcp_idempotency`, scoped to the caller. A retry with the same key and arguments returns it with `_meta["tower/replayed"] = true` and acts once. The same key with another tool or other arguments is `idempotency_key_reused`. A failed call stores nothing, so its key can be reused. The key is also passed to the core as its idempotency and correlation key, so a retry after a crash between the effect and the stored result is still deduplicated by the event log.

**Material** tools also require `confirm: true`, exactly the boolean. They are the ones that grant or revoke authority, dispatch, close, change a flag, or authorize work: `answer_decision` (an approval authorizes the packets linked to the decision) and `request_expansion` (under a covering grant it authorizes the packet at once) count, because they reach the same effect as `request_dispatch`. Anything else is `confirmation_required`, nothing runs and nothing is stored. The schema says what a confirmed call does.

Mutating mission tools take `expectedVersion`. A stale one is `version_conflict`.

Results carry the data twice, as `structuredContent` and as JSON text. A refusal is `isError: true` with `{ error: { code, message, details? } }` using the same codes as the HTTP API. Unknown errors become `internal_error` with no detail. Protocol mistakes (unknown tool, bad `arguments`) are JSON-RPC errors.

Unknown arguments are rejected, not ignored, so a typo cannot silently drop a constraint.

### Authority

- A Chief of Staff holds no `policy:write`, so it cannot grant, revoke or change a flag. It can `propose_policy_change`, which raises a decision a human answers and grants nothing.
- `request_expansion` follows the three tiers. Inside approved scope it proceeds. A Chief of Staff is approved only under a current grant that covers the request and the packet's declared scope, and the packet is authorized citing that rule. Otherwise a decision is raised for the person (or for a Chief of Staff when a delegated rule would let one answer). Deny, expiry and revocation take effect on the next call.
- A Chief of Staff cannot satisfy independent review. The Auto-Office review guard judges receipts, not callers, and a landing grant never counts as a review. `close_mission` by a Chief of Staff on a high-risk mission without a satisfied independent review fails `completion_guard_failed`.
- `read_mission` replaces every policy ref (the mission's and each `packets[].authorization.policyRefs` entry) with `[redacted]` for a runner or provider principal, so no rule id reaches it. A person and a Chief of Staff see the refs.
- `recent_activity` with a `missionId` omits `policyRefs` from each item and its payload for a runner or provider principal and cleans rule ids written in payload strings. `preview_dispatch` does the same for the `citedPolicy` reason.
- A runner principal can read and see itself. It holds no `mission:write` or `decision:write`, so every mutating tool refuses it.
- `grant_policy` only ever creates `allow` rules. `effect` is overwritten. A deny rule is a different act and stays on the HTTP route.

## Audit

Every tool call, refused or not, appends a row to `mcp_audit` (principal, session, tool, mutating or not, outcome, error code). The table holds no arguments, results or credentials, and triggers refuse updates and deletes.

## Feature flags

`cloud_ai.triage` and `hosted_execution` are off by default, and a flag with no row is off. `set_feature_flag` turns one on only when all three hold, and otherwise refuses with the missing pieces named and stores nothing:

1. **Provider.** The provider id is in `mcp.approvedAiProviders`, a list a person sets when deploying. It is empty by default.
2. **Budget.** A positive integer number of cents.
3. **Policy.** The named rule is active and allow, and a delegated evaluation of `cloud_ai.triage.run` or `hosted_execution.run` on `provider:<id>` at that budget is granted. Another flag's rule does not count.

The effective state is recomputed on every read, so revoking the rule, shrinking its `maxAmount` or dropping the provider from the list turns the flag off with no write. Nothing consumes the flags yet. A capability must call `isEnabled` at the point of effect. See `DEFERRED.md`.

## Configuring

```ts
createApp({
  db,
  mcp: {
    publicBaseUrl: 'https://tower.example.com', // https origin, no path
    authProvider, // implements AuthProvider
    allowedOrigins: [], // browser origins, default none
    approvedAiProviders: [], // default none
  },
});
```

Link a provider identity to a principal (a human does this, by code for now):

```ts
linkIdentity(db, {
  issuer,
  subject,
  principalId,
  scopes: ['mission:read'],
  linkedBy: humanPrincipalId,
});
```

## Limits and open items

- No server-to-client stream, no resources, prompts or sampling, no JSON-RPC batches.
- `src/hosting` does not read MCP settings from the environment yet, and there is no admin route to link identities. See `DEFERRED.md`.
- Tool arguments are validated by the same parsers as the HTTP API. The published `inputSchema` is a guide for clients, not the source of truth.
- A principal holds at most 50 open sessions. Opening another closes the least recently used. Sessions are not otherwise expired by age.
- Stored results answer a retry for 7 days, then are pruned. A retry that arrives while the first call is still running joins it instead of running the tool twice.
- A tool must settle. A retry joins a call still running and waits as long as it does, so a hung provider call holds its key until it returns.
- A result that cannot be stored does not fail a call that already took effect. The core's own idempotency key still deduplicates a retry for the tools that pass it.

## Sessions and storage limits

A session ends after an hour idle (`SESSION_IDLE_TTL_MS`) and its row is purged a day after it closes. An ended session answers `-32002`, and the client initializes a new one. While the store refuses writes (`docs/operations.md`), reads and `read_health` still work, mutating tools fail with `storage_quota_exhausted`, and `initialize` answers 503 with the same code.
