# Threat Model

Scope: the Auto Tower control plane, its HTTP and MCP surfaces, the runner protocol, and the issue-provider adapters. This document states what v1 defends against, how, and what is still open. Items marked **planned** belong to later tasks and are not yet implemented.

## Assets

1. Mission, decision, and evidence records. Their integrity matters most, since completion claims rest on them.
2. Policy and grants. A forged or widened grant is a direct path to unauthorized side effects.
3. Owner tokens. An owner token holds every scope.
4. Secrets held by providers and runners, such as subscription sessions and repository credentials. Tower must not hold them.
5. External issue content. It is attacker-influenceable text.

## Actors and trust

| Actor                         | Trust                                  | Notes                                                           |
| ----------------------------- | -------------------------------------- | --------------------------------------------------------------- |
| Owner (human)                 | Fully trusted for decisions            | Holds all scopes. Its token is the highest-value credential.    |
| Chief of Staff client         | Trusted to reason, not to self-approve | Holds mission and decision scopes. Holds no policy write scope. |
| Runner                        | Partly trusted                         | Can be compromised or misreport. Holds runner scopes only.      |
| Provider adapter              | Partly trusted                         | Reads external systems. Holds `provider:sync` only.             |
| External issue or log content | Untrusted data                         | Never treated as instructions.                                  |
| Network attacker              | Untrusted                              | Can send arbitrary HTTP and replay captured requests.           |

## Threats and mitigations

### T-01 Compromised runner rewrites policy or approves its own expansion

- **Mitigation:** Scope ceilings. A `runner` principal cannot be issued `policy:write`, `decision:write`, or `admin:tokens`, and `issueToken` refuses it (`src/auth/principals.ts`). Tests cover this in `test/auth/tokens.test.ts`.
- **Mitigation (planned, T3):** Policy evaluation and the Decision Inbox run server-side. A runner's claim never counts as an approval.

### T-02 Stolen or leaked token

- **Mitigation:** Only the SHA-256 digest is stored (`api_tokens.token_hash`). Tokens carry 256 bits of randomness, so a digest lookup is not brute-forceable. Tokens can expire, be revoked, or be disabled through their principal.
- **Gap:** No rotation endpoint and no token listing. Revocation requires direct database access until the admin surface lands (see `DEFERRED.md`).

### T-03 Token guessing and enumeration

- **Mitigation:** Unknown, malformed, revoked, expired, and disabled credentials all return the same 401 body with no differentiating detail (`test/auth/middleware.test.ts`).

### T-04 Under-scoped or unauthenticated access

- **Mitigation:** Routes are declared with either `public: true` or a non-empty scope tuple. Mounting a route with no access declaration throws. Only `/health` is public, and it returns `{"status":"ok"}` with no workspace or storage detail (`test/api/app.test.ts`, `test/api/health.test.ts`).

### T-05 Event tampering or silent rewrite

- **Mitigation:** `events` and `idempotency_keys` reject UPDATE and DELETE through triggers. Each stream has a unique `(workspace_id, stream_id, version)`, and appends check the expected version inside a write transaction.
- **Gap:** The triggers do not stop someone with direct file access from editing the database file. Hash-chaining the event log is deferred.

### T-06 Duplicate or replayed writes

- **Mitigation:** Idempotency keys are scoped per principal. A replay with the same body returns the original event. A reused key with a different body is rejected (`test/events/event-log.test.ts`).

### T-07 Webhook replay (planned, T6)

- **Plan:** Verify the provider's signature on the raw body, reject timestamps outside a replay window, and dedupe on the provider delivery id. Webhook processing is idempotent, and origin markers prevent event loops.

### T-08 SSRF through stored issue or link URLs (planned, T6)

- **Current state:** T1 stores link URLs as strings and fetches nothing.
- **Plan:** Any future fetch uses an allow-list of hosts and rejects private, loopback, and link-local addresses, including after redirects.

### T-09 Untrusted issue text as instructions (planned, T2 and T6)

- **Plan:** Issue descriptions, comments, and log output are stored and displayed as data. Instructions from them never change scope, grants, or dispatch. Anything they request goes through the same policy checks as any other request.

### T-10 Secret leakage through errors, logs, or receipts

- **Mitigation:** Unhandled errors return a generic 500 body. The error handler logs only the error name, never the message or stack (`src/api/errors.ts`, `test/api/app.test.ts`).
- **Mitigation:** Tokens are never logged. The CLI prints the raw token once and tells the operator it cannot be shown again (`src/auth/cli.ts`).
- **Gap:** Evidence redaction for runner-submitted artifacts is planned with the runner protocol (T4).

### T-11 Cross-workspace data access

- **Mitigation:** Every tenant-owned table has `workspace_id`. Event-log reads and appends take the workspace explicitly. Tokens are bound to one workspace through their principal.
- **Gap:** Later query code must filter by workspace on every read. This is a review requirement for T2 onward.

### T-12 Local development exposure

- **Mitigation:** The Node host binds to `127.0.0.1` only. The Workers entry answers 503 until the storage binding exists, so it cannot serve data.

### T-13 Owner token compromise

- **Gap, accepted for v1:** An owner token has full control. Mitigations are expiry, revocation, and the planned emergency halt (a later task). Owner tokens are issued locally by the CLI.

### T-14 Denial of service and quota exhaustion (planned, T9)

- **Plan:** Rate limits, backpressure on free-tier quotas, and fail-closed behavior for unsafe mutations when quota is exhausted.

## Explicit non-goals for v1

- No hosted model reads untrusted content on Tower's behalf. The cloud AI path is off by default.
- Tower does not store subscription credentials for Claude, Codex, or other providers.
- Tower does not write to external systems without an explicit grant and provider permission.
