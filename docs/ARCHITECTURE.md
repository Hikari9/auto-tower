# Architecture

## Layout

```
src/domain/      Pure rules: types, lifecycle state machines, policy evaluation, broker selection, gates, redaction, crypto
src/store/       SqlDriver interface, node:sqlite and D1 drivers, migrations runner, row codec, UnitOfWork, read Repo
src/service/     Tower Core: missions, runners (protocol), decisions, policy, issues, admin, scheduler
src/contracts/   Versioned wire contracts: tower.dispatch/v1, tower.receipt/v1, tower.runner/v1
src/adapters/    office/ (Auto-Office, fake), issues/ (contract, link-only URL safety, GitHub, registry)
src/http/        REST API (one backend for all clients) and the MCP endpoint
src/runner/      Outbound runner client and agent loop
src/worker.ts    Cloudflare Workers host (fetch + cron)
src/node/        Self-hosted Node host
bin/             tower (operator CLI), tower-runner (machine agent)
public/          Static dashboard
migrations/      D1/SQLite schema
```

The domain and service layers depend only on `SqlDriver`, a clock and an id generator. Hosting (Workers, Node), storage (D1, SQLite), engines (Auto-Office) and issue providers (GitHub) are adapters.

## Source of truth

| Domain | Owner | Tower behavior |
| --- | --- | --- |
| Mission goals, acceptance, dependencies, status, dispatch, reconciliation, decisions, evidence pointers | Tower | Canonical rows plus an append-only event log |
| Owner grants, limits, expiry, revocations | Tower policy store | Versioned rules, evaluated server-side at the point of effect |
| Issue title, body, comments, open/closed | Issue provider | Link plus optional observed state; writes only under grants |
| Work packets' internal SDLC, routing, local run state | Auto-Office on the runner | Tower sends a bounded contract and ingests receipts |
| Chat context | ChatGPT / Chief of Staff | Interface only; never an authoritative grant |
| Subscriptions, credentials, worktrees | The machine | Runners attest availability and capabilities, never secrets |

## Persistence and concurrency

Every aggregate (mission, packet, attempt, runner, decision, rule, link, scope lock, workspace) is an event stream. A command:

1. reads current rows (with their `version`),
2. computes the next state with pure domain rules,
3. commits one atomic batch: `INSERT INTO events (stream, version = expected + 1, ...)` plus projection upserts.

`UNIQUE(stream_type, stream_id, stream_version)` rejects a concurrent writer, and the batch rolls back. This works identically on D1 (`batch()` is a transaction) and SQLite, with no interactive transactions. Conflicts surface as `409 conflict`; internal read-modify-write paths retry. Idempotency keys (`Idempotency-Key` header, MCP `idempotencyKey`, receipt `receiptId`) store the first response per principal.

Derived fields (mission `activity`/`blockers`, runner `last_seen_at`, lease renewals) are plain projection updates without events, because they are explanations or liveness, not authority.

## Mission lifecycle

```
draft --start--> active --all work done--> verifying --verified--> reconciling --required links closed/exempt--> completed
  |                |  ^                       |                          |                                        |
  |              pause|resume              (fail)                   (provider errors)                         (drift)
  v                v  |                       v                          v                                        v
cancelled        paused                needs_attention <----------------------------------------------------------+
```

- `active → verifying` needs every packet done (or cancelled) and every child mission completed. When there are two or more outputs, Tower first adds an **integration packet** that depends on all of them.
- `verifying → reconciling`: automatic for low/medium risk when the final (integration or only) packet passed its gate with integrated verification and all DoD items are met. High/critical risk needs an explicit verify by the owner, or a chief holding a `mission.verify` grant, plus an independently reviewed integration result.
- `reconciling → completed` only when every required link is verified closed by provider read-back, attested closed by the owner (link-only), or exempted by the owner.
- `completed → needs_attention` on drift (required issue reopened, deleted or transferred). The completion event stays in history.
- Cancel never closes linked issues.

## Dispatch, leases and recovery

- Runners poll `POST /runner/claim`. The broker picks the best eligible ready packet: engine, capabilities, allowed scopes, capacity, then checkpoint affinity, mission priority, age.
- Claim takes the scope lock with `fence + 1` in the same batch that creates the attempt. A concurrent claim collides on the scope stream version.
- Heartbeats renew leases and return directives (`continue`, `hold`, `pause`, `cancel`, `stop`).
- Sweep: an expired lease makes the attempt `lost` and the packet `recovering`. The original runner can reconnect and resume the same attempt (same fence). With a portable checkpoint, the packet becomes `ready` and the next claim fences the lost attempt. Without one, after `recoveryMs` the owner gets a `recovery` decision; nothing launches the same mutable job twice blindly.
- Receipts and effects check `(attempt, fence)` against the scope lock. Stale ones are rejected and audited (`receipt.rejected_fenced`).
- Failures are classified (`environment`, `runner`, `adapter`, `quota`, `policy_denial`, `review_failure`, `implementation_defect`, `cancelled`). Retryable ones back off exponentially (quota ×4) up to `maxAttempts`; gate failures become `review_pending` when attempts run out.

## Authority (three tiers)

1. **In scope**: actions and resources inside the mission envelope proceed. Runners create follow-up packets inside the envelope without asking.
2. **Expansion**: `POST /runner/expansions`. A runner-grantee rule approves directly. Otherwise, if a chief-grantee rule covers it, the decision goes to the Chief of Staff, who can approve only while that rule still covers the exact action, resource and risk (re-evaluated at answer time). Otherwise it goes to the owner.
3. **Owner judgment**: decisions in the inbox. Only linked packets wait.

`evaluatePolicy` order: emergency halt, explicit deny, mission envelope, explicit allow, default deny (sensitive prefixes `spend`, `deploy.prod`, `security`, `destructive`, `policy`, `secrets` are labelled as such). Every guarded effect calls `POST /runner/effects`; landing actions (`land`, `merge`, `deploy*`) on review-required packets also need an approved, independent review from a session other than the producer, never a chief.

## Issue reconciliation

Links are normalized (https only, no credentials, no private hosts). With `observe`/`bidirectional` sync and a configured repo, Tower reads state on demand, on a bounded poll schedule, and from signature-verified, replay-protected webhooks. Tower writes (close) only in `reconcile`, only with `bidirectional` sync, repo write scope and a policy allow for `issue.close` on `github:owner/repo#n` (envelope or `tower` rule), after checking the issue is the intended one (no transfer), not locked and not carrying a blocking label. It then re-reads. Webhooks only update observed state, so there is no write loop.

## Hosting

- **Cloudflare (recommended)**: Worker for API, MCP and webhooks; static assets for the dashboard; D1 as the source of truth; Cron Trigger every 5 minutes for the sweep. Durable Objects and Queues are not used until a measured need appears.
- **Node (local / self-hosted)**: `tower serve` with SQLite (WAL) and an in-process sweep timer.

Both use the same `createApi` handler and `Tower` core.

## Extension points (designed, not built)

- `IssueProvider` (`tower.issues/v1`) for Linear, Jira, Basecamp.
- `OfficeEngine` for other engines or hosted runners.
- `cloud_ai.classifier` / `cloud_ai.hosted_runner` flags: off by default; enabling needs provider, model, budget and credential name; never grants authority.
- Chief of Staff persona is workspace settings plus any `chief` principal; nothing in core names Rico.
