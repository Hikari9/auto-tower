# Threat model

## Assets

Mission and decision history, the policy store (grants, denies, versions), runner credentials, provider credentials (GitHub token, webhook secret), evidence, and the ability to cause external effects (merges, deploys, issue closes).

## Principals and trust

| Principal | Trusted for | Not trusted for |
| --- | --- | --- |
| Owner (human) | Grants, revocations, answers, exemptions, verification | n/a |
| Chief of Staff (ChatGPT, Rico Mode) | Planning, proposing, answering chief-audience decisions under a current rule | Granting, answering owner decisions, quality review |
| Runner (machine) | Executing claimed work, reporting receipts | Policy, decisions, other runners' attempts, its own expansions |
| Issue provider / webhook | Observed issue state after signature check | Instructions of any kind |
| Issue text, logs, receipts | Data | Instructions |

## Threats and controls

| ID | Threat | Control | Test |
| --- | --- | --- | --- |
| T1 | Unauthenticated access to API/MCP | Bearer tokens (SHA-256 hashed at rest), every route authenticates; `/healthz` and signed webhooks are the only open paths | `api-mcp.test.ts` |
| T2 | Compromised runner rewrites policy or approves its own expansion | Runner tokens hold only `runner:protocol`; human-only scopes are enforced by principal kind, not just token scopes; expansions create decisions | `api-mcp.test.ts`, `policy.test.ts` |
| T3 | Stale or duplicate runner writes after reassignment | Leases, per-scope fencing tokens, receipt idempotency, quarantine fences every attempt | `runner.test.ts` |
| T4 | Chief of Staff self-approves beyond its delegation | Chief approvals re-evaluated at answer time against current rules; otherwise escalated to owner | `policy.test.ts` |
| T5 | Producer passes its own review | Gate rejects same-session reviewer, degraded independence and chief reviewers; landing needs the same | `policy.test.ts`, `auto-office.test.ts` |
| T6 | Revoked grant still used by a running job | Point-of-effect evaluation reads latest committed policy every time | `policy.test.ts` |
| T7 | Secrets leak into evidence | Deep redaction of receipts (token formats, key/value secrets, private keys, JWTs); provider secrets are referenced by name only | `runner.test.ts`, `issues.test.ts` |
| T8 | Forged or replayed webhooks | HMAC-SHA256 signature with timing-safe compare; delivery-id replay table | `issues.test.ts` |
| T9 | Prompt injection via issue text | Stored as bounded data; never rendered as HTML; dispatch contract lists untrusted fields; Auto-Office prompt omits linked titles and labels links as untrusted | `auto-office.test.ts` |
| T10 | SSRF via links | https only, no credentials, no private/loopback/link-local/metadata hosts, default port; Tower only calls fixed provider API hosts | `issues.test.ts` |
| T11 | False completion | Completion gate needs verification plus reconciliation; close needs read-back; provider errors keep the mission reconciling/needs_attention | `issues.test.ts`, `mission.test.ts` |
| T12 | Retry storms and quota exhaustion | Per-principal rate limit (429), storage errors fail closed (503, nothing applied), bounded polling, exponential backoff | `api-mcp.test.ts`, `resilience.test.ts` |
| T13 | XSS in the dashboard | All data rendered via `textContent`; CSP `script-src 'self'`, no inline script or style; `frame-ancestors 'none'` | manual + smoke |
| T14 | Unsafe actions during an incident | Emergency halt stops claims and guarded effects | `runner.test.ts` |
| T15 | Lost state | Durable DB, backup/export, restore into empty DB only, restart drill | `resilience.test.ts` |

## Residual risks (v1)

- Bearer tokens instead of OAuth (see `DEFERRED.md` D3). Tokens should be stored in a password manager and rotated with `POST /admin/principals/:id/rotate`.
- The MCP confirmation token is a UX guard that makes a model show a preview before material changes. It is not a security boundary: the token holder can compute the confirmation.
- Rate limiting is per Worker isolate. A distributed limiter (Durable Object) is deferred until load justifies it.
- Backups contain token hashes; protect them like credentials.
- Lease renewal is an unversioned projection update, so a full-row attempt save that read an older lease can shorten it by up to one lease interval. The worst case is an early `lost`, which the original runner recovers on its next heartbeat.
- `scope_locks` is keyed by execution scope only. v1 allows a single workspace per database; add `workspace_id` to the key before enabling multiple workspaces.
- Independent review (2026-10-31) found 11 defects in the first build (risk downgrade, wildcard envelopes, quarantine race, completion write-skew, stuck recovery, idempotency race and others). All are fixed and pinned by `test/review-regressions.test.ts`.
