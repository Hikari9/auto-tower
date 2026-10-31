# Versioned contracts

Tower integrates with engines, machines, issue trackers and chat clients only through these contracts. Breaking changes get a new version string; old versions stay accepted until every runner has upgraded.

| Contract | Version | Defined in | Consumers |
| --- | --- | --- | --- |
| Dispatch contract | `tower.dispatch/v1` | `src/contracts/office-v1.ts` | Runner engine adapters |
| Receipt | `tower.receipt/v1` | `src/contracts/office-v1.ts` | Tower `POST /api/v1/runner/receipts` |
| Runner protocol | `tower.runner/v1` | `src/contracts/office-v1.ts`, `src/service/runners.ts` | `tower-runner`, any third-party runner |
| Issue provider | `tower.issues/v1` | `src/adapters/issues/contract.ts` | GitHub provider; future providers |
| Backup | `auto-tower.backup/v1` | `src/service/admin.ts` | `tower backup` / `tower restore` |
| MCP | protocol `2025-06-18` (also `2025-03-26`, `2024-11-05`) | `src/http/mcp.ts` | ChatGPT and other MCP clients |

## Runner protocol (`/api/v1/runner/*`, bearer runner token)

| Call | Purpose |
| --- | --- |
| `POST register` | `{ name, clientVersion, platform, engines[], capabilities[], allowedScopes[], maxConcurrency }`. Returns lease and heartbeat intervals. Re-register to update capabilities. |
| `POST heartbeat` | `{ attempts: [{ attemptId, fence, phase?, localRunId? }], draining? }`. Renews leases, recovers `lost` attempts the runner still holds, and returns directives: `continue`, `hold`, `pause`, `cancel`, `stop`. |
| `POST claim` | Returns `{ claim: { attempt, contract } }` or `{ claim: null }`. |
| `POST receipts` | A `tower.receipt/v1`. `kind`: `progress`, `checkpoint`, `complete`, `fail`. Duplicate `receiptId` is a no-op; a stale fence returns `409 fenced`. |
| `POST effects` | `{ attemptId, fence, action, resource, risk?, producerSessionId?, review? }`. Point-of-effect authorization. `403 policy_denied` means do not perform the effect. |
| `POST followups` | In-envelope follow-up packet. Out-of-envelope returns `403`; use expansions. |
| `POST expansions` | `{ attemptId, fence, action, resource, risk?, reason, alternatives?, recommendation?, blocking, followup? }`. Returns `in_scope`, `approved_by_rule`, `denied`, or `pending` with a decision id and audience. |

## Dispatch contract (`tower.dispatch/v1`)

`attemptId`, `fence`, `leaseExpiresAt`, `correlationId`, mission summary (outcome, constraints, acceptance, risk, definition of done), packet (goal, kind, scope, acceptance, engine, risk), links (url, role, untrusted title), authority snapshot (advisory; effects still need `effects`), guards (`singleWriterScope`, `landingRequiresGate`), `evidenceProfile` (`selfVerification`, `independentReview`, `integratedVerification`, `commitSha`), `resumeFrom` (portable checkpoint or null), `untrustedFields`.

## Completion receipt

`outcome`, `producer { engine, engineVersion?, runId, sessionId }`, `commitSha?`, `selfVerification { status, summary }`, `independentReview? { status, reviewer { id, sessionId, kind }, independence, sha?, summary }`, `tests?`, `integratedVerification?`, `landing? { status: not_landed | pr_open | landed, ref?, sha? }`, `residualRisks[]`, `dodItemsMet[]`, `nextAction?`, `evidence[]`.

Gate rules (`src/domain/gates.ts`): success outcome; self-verification `pass`; tests not `fail`; commit SHA for repo work; for review-required or high/critical packets an `approved`, `independent` review from a different session that is not a chief, covering the same SHA; integration packets need integrated verification `pass`.

## Auto-Office adapter (runner side)

`src/adapters/office/auto-office.ts` targets the Auto-Office 3.x CLI (`office --version`, `office list --json`, `office --run <id> status --json`, `office --run <id> land`, `office --run <id> close --abandon`, `office --run <id> queue pause`) and reads `~/.local/state/auto-office/runs/<run_id>/archive-receipt.json`. It launches the machine's own orchestrator (default `claude -p "/auto-office …"`) with end-state `preview`, so Auto-Office stops at a reviewed PR; the adapter lands only after Tower authorizes `merge`. Tower never reads Auto-Office's database and never reimplements its SDLC. Mappings that still need a live run to confirm are listed in `DEFERRED.md` (D5).

## MCP tools

Read-only: `tower_briefing`, `mission_search`, `mission_get`, `dispatch_preview`, `runners_list`, `decisions_list`, `evidence_get`, `activity_recent`, `policy_get`.
Mutating: `mission_create`, `mission_update`, `mission_control`, `mission_add_work`, `mission_link_issue`, `mission_verify`, `reconcile_request`, `decision_answer`, `decision_escalate`, `policy_propose`, `policy_grant`, `policy_revoke`, `proposal_resolve`.

Tools are filtered by the caller's scopes; owner-only tools are invisible to a chief. `policy_grant`, accepting a proposal, cancelling a mission and approving high-risk or sensitive decisions return a preview and a confirmation token first; the second call with `confirm` commits. Mutating tools accept `idempotencyKey`.
