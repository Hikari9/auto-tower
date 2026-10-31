# Runner Protocol (`tower.runner.v1`)

How runners enroll, receive work, hold leases and report results. The code is in `src/fleet/`, the routes in `src/api/routes/runners.ts`, and the tables in `migrations/0004_runner_fleet.sql`.

## Shape

- **Outbound only.** A runner connects to Tower and asks. Tower never connects to a runner, never pushes, and stores no runner address. No route accepts a callback URL, host or port (unknown fields are rejected).
- **Poll protocol.** `POST /runners/claims` is the poll. It is a heartbeat, it runs the scheduler for the workspace, and it returns any work dispatched to the runner. With no human action, authorized ready work dispatches on the next poll. With no runner enrolled, work stays `waiting-runner`.
- **Tower decides, the runner reports.** A runner's receipt moves an attempt to `self-reported-*` and a packet to `reported`. Only Tower's own verification (a human or chief of staff other than the producer) makes it `verified`.

## Enrollment and attestation

1. A **human** principal calls `POST /runners/enrollments` (scope `admin:tokens`, and the principal kind must be `human`). The body pins `version` (`major.minor.patch`), `buildDigest` (`sha256:` plus 64 lowercase hex), the `allowedScopes` the runner may touch, and `maxConcurrent`. The pinned version must be inside Tower's supported range. The response carries the enrollment token once.
2. The enrollment token is a real api token for the runner's future principal, expiring (default 15 minutes, at most 24 hours) and narrowed to `runner:read`. It can read and nothing else. Only its digest is stored.
3. The runner calls `POST /runners/register` with that token and its `version`, `buildDigest` and `capabilities`. Registration is refused unless the version and digest equal the pinned pair exactly, including when the presented version is another supported one. A mismatch is recorded and does not use the token up. On success the enrollment token is revoked in the same transaction, so it works once, and the runner receives its credential (`runner:read`, `runner:write`).
4. The credential is bound to the pinned version and digest and to that one token (`runners.token_id`). A second credential issued to the same principal is refused (`credential_not_bound`). The bound version, digest and token cannot be updated, even through SQL (trigger).
5. **Every claim** and heartbeat re-checks: the credential is the bound one, the runner is not quarantined, the reported version and digest equal the bound pair (`version_mismatch`), and the bound version is still inside Tower's supported range (`version_unsupported`). A runner outside the range cannot claim work and is not offered any.
6. **Upgrading a runner is a new human-issued enrollment.** There is no route that rebinds a runner. The old runner stays until a human quarantines it.

The supported range is `FleetConfig.supportedVersions()`, read on every check. The default is `1.0.0` to `1.99.99`. A host passes `fleetConfig` to `createApp` to change it.

## Poll, claim and the lease

`POST /runners/claims` takes `version`, `buildDigest`, optional `capabilities` and optional `active` evidence (below). In order:

1. Admission checks and heartbeat. A change in declared `capabilities` is recorded.
2. Sweep (below).
3. Scheduler tick for the workspace, as Tower's own fleet principal.
4. If the runner has leases in recovery, the response lists them under `reconcile` and grants nothing: the runner **reconciles first**.
5. Otherwise Tower grants a lease for each attempt dispatched to the runner, up to `maxConcurrent`, re-checking eligibility at that moment. Starting the attempt in the mission core happens in the same transaction as the lease insert.

**Assignments are sent until confirmed.** A lease is unconfirmed until Tower sees matching evidence for it (evidence, progress or a checkpoint). Every claim re-sends the assignment of each unconfirmed lease the runner is still eligible for, so a response lost on the way, or a runner that restarted, does not strand the work. A runner confirms by listing the lease under `active` on its next poll. A reassigned lease reaches its new runner the same way. A paused runner, or one that lost eligibility, is told the assignment is `withheld` instead.

The response carries `assignments`, `leases` (renewed), `unmatched`, `reconcile`, `withheld` (offers that were not granted, with a reason), and `retryAfterMs`.

### Broker

A runner is eligible for a packet when all hold: status `active`, bound version supported, heard from within `livenessWindowMs` (dispatch only), declares every `cap:` the packet needs, is allowed every scope the packet names, and is under `maxConcurrent` (leases plus attempts dispatched and not yet claimed). Among the eligible, **affinity** wins first (the runner that last held the execution scope, then one that already worked on the mission), then lighter load, then runner id.

Eligibility is computed from current rows at dispatch and again at every claim. A capability change, a quota or allowed-scope change by a human, a pause or a quarantine therefore takes effect on the next poll with no refresh step. An offer the runner no longer qualifies for stays dispatched and is reported under `withheld` until it qualifies again.

### Packet conventions

A packet's `scope` is a list of strings. The fleet reads:

| Entry             | Meaning                                                        |
| ----------------- | -------------------------------------------------------------- |
| `cap:<name>`      | The runner must declare capability `<name>`.                   |
| `repo:<name>`     | Names the mutable repository.                                  |
| `worktree:<name>` | Names the worktree. Defaults to `default` when `repo:` is set. |
| anything else     | A scope the runner must be allowed.                            |

The **execution scope key** is `repo:<r>#worktree:<w>`. The prefixes match without regard to case or surrounding space (` REPO : Foo` is `repo:foo`). The names are lowercased and stripped of a trailing `/` or `.git`, so `Repo`, `repo/` and `repo.git` are one repository. A packet with no `repo:` entry shares nothing and is keyed by itself. A packet whose scope cannot be keyed is **never dispatched**: two `repo:` entries, two `worktree:` entries, a `worktree:` without a `repo:`, or a name that is not a plain name: path segments of `a-z 0-9 . _ -`, none empty, none ending in a dot (which also rules out `.` and `..`, and a name some filesystems read without its trailing dot), at most 128 characters. A segment may start with a dot, so `org/.github` is a name. It would otherwise lock only part of what it touches. The offer is withheld with `execution scope is ambiguous`, and a human fixes the packet. A runner's `allowedScopes` match exactly, by trailing `*` prefix, or `*` for everything.

### Exactly one live lease per scope

`runner_leases` has a partial unique index on `(workspace_id, scope_key)` for statuses `held` and `recovering`, and another on `(workspace_id, attempt_id)`. A claim checks the scope and inserts inside one write transaction, and the index is the backstop. Of two concurrent claims on one scope exactly one lease exists afterwards. The loser keeps its dispatched attempt, is told why under `withheld`, and retries with **bounded exponential backoff** (`backoff.baseMs` doubling to `backoff.capMs`, stored per attempt and cleared on success). Polling inside the window is not retried.

## Fencing

A lease carries a **fencing token** (`fence`), a per-scope counter that only grows. Progress, checkpoints and receipts carry the lease id and fence. A write is accepted only when the lease is `held`, owned by the caller, unexpired, and the fence equals the lease's current fence. Otherwise it is refused and **recorded in `fleet_audit`** with the presented and current fence:

| Situation                                                   | Code                |
| ----------------------------------------------------------- | ------------------- |
| Fence differs from the current one, or the lease was fenced | `lease_fenced`      |
| Lease ran out (`expiresAt` passed) or is recovering         | `lease_expired`     |
| Lease completed or released                                 | `lease_closed`      |
| Attempt cancelled                                           | `attempt_cancelled` |
| Lease unknown, or another runner's                          | `lease_not_found`   |

The token is compared first, so a token from before a reconcile or reassignment is always `lease_fenced`.

**Receipts are idempotent.** A receipt carries a `receiptId`, unique per runner. Repeating the same receipt (same lease, outcome, summary, evidence) returns the first result with `replayed: true` and reports to the mission core once. The same id with a different body is `receipt_conflict`. The repeat is answered before lease checks, because the first receipt closed the lease. Progress is ordered by `seq` and idempotent the same way.

## Liveness, recovery and reassignment

A lease lives `leaseTtlMs` (default 60 s) past its last **matching evidence**.

**Evidence.** A poll or heartbeat may carry `active: [{leaseId, attemptId, fence, progressSeq}]`. It matches only when the lease id, attempt id and fence equal Tower's record for a lease this runner holds, and it claims no progress Tower has not stored. Valid progress and checkpoints are evidence too. Only matching evidence renews a lease. A heartbeat or poll that carries none, or carries evidence that matches nothing, renews nothing, never counts as work proof, and is audited (`heartbeat.unmatched`). A runner that is alive and cannot show matching evidence still loses its lease.

**Sweep.** Every fleet operation first brings lease state up to date:

1. A lease whose attempt was cancelled, or already reported elsewhere, is closed. This frees the scope even if the runner never returns.
2. A held lease past its expiry, or held by a quarantined runner, moves to **`recovering`**. The attempt is not failed: the core attempt stays `running`, the packet stays `running`.
3. A lease that has been `recovering` for `reassignGraceMs` (default 120 s) may move to another runner, **only if a portable checkpoint was recorded**, and only by fencing the old lease: the old lease is closed as `fenced` and a new lease, on a higher fence, is created for the new runner. Without a checkpoint the work **waits**. If no other runner is eligible the retry is backed off with the same bounded policy.

**Checkpoints.** `POST /runners/leases/:id/checkpoints` records a `ref` and an optional full `commit`. The ref is a branch or tag name another runner can fetch: it starts with a letter or digit, uses only letters, digits and `. _ / -`, has no `..` or `//`, does not end in `/` or `.lock`, and must not look like a credential, so the runner that receives it cannot read it as a git option. It is the runner's own claim that the ref was pushed. Tower does not fetch it.

**Reconcile.** `POST /runners/leases/:id/reconcile` is the original runner coming back. If the lease is still its own (no one took over) it becomes `held` again under a **new fence** and the old token dies. The response carries `resume` (Tower's stored progress sequence and latest checkpoint). A retry whose answer was lost, presenting the replaced fence, gets the same lease back, until the runner shows matching evidence under the new fence. After that the replaced fence is `lease_fenced`. A runner that may not be sent the work (paused, scope narrowed, capability gone, mission paused) gets **no fence**: the lease stays in recovery, the response carries `assignment: null` and `withheld`, and the grace period keeps running, so the work can still move to an eligible runner. The response also carries `assignment`, the packet and mission context, for a runner that lost its state. If the work moved, the old fence gets `lease_fenced`.

**Reassigned work and the core.** The mission core allows a runner to report only an attempt dispatched to it, and offers no way to un-dispatch one. After a reassignment the new holder's receipt is therefore relayed to the core as Tower's fleet principal, with the summary prefixed `[runner <id>]`. See Limits.

## Cancel, pause and stuck work

- **Cancel.** When a mission is cancelled the core cancels its attempts. The next fleet operation closes the lease as `cancelled`, frees the scope, and answers heartbeat evidence with `cancel: true`. Progress, checkpoints and receipts get `attempt_cancelled`.
- **Pause.** A human pauses a runner with `PATCH /runners/:id {"paused": true}`: it gets no new work, and its leases carry `directives.pause`. A mission in `waiting-external` or `needs-attention` pauses its leases the same way and withholds its offers.
- **Quarantine.** `POST /runners/:id/quarantine` (human). The runner cannot claim, heartbeat, write progress or reconcile (`runner_quarantined`, recorded). Its held leases move to recovery at once. Its work is **not** reassigned automatically, because its checkpoint is its own word. `PATCH` cannot lift a quarantine. `POST /runners/:id/unquarantine` restores the status the runner had before (a pause survives) and restarts the grace period of its recovering leases, so the runner can reconcile before its work moves.
- **Release.** `POST /runners/leases/:id/release` (human) gives up on a stuck lease: the scope is freed and the attempt is reported failed, which puts the packet on the usual reject and requeue path. `POST /runners/attempts/:id/release` does the same for an attempt that was dispatched but never claimed, which has no lease. It is the way out when that runner is quarantined, retired or no longer eligible.

## Secrets

Progress, receipts, summaries, evidence objects, operator reasons, the lease id in an audit row and every audit detail are scanned and redacted **before** they are written (`src/fleet/redact.ts`). Token formats (GitHub, GitLab, Slack, Stripe, npm, Google, AWS key ids, provider `sk-` keys, JWTs, Tower tokens), PEM and PGP private key blocks, URL credentials, webhook URLs, signed-URL parameters, `Bearer` values, `Authorization` header values and `name=value` assignments with a secret-like name (a quoted value is taken whole) are replaced by `[REDACTED]`. Any value under a secret-named key is replaced whatever it looks like. Unquoted values are taken whole, up to whitespace or a quote, so a password with commas, semicolons or backslashes is not cut. Cookie header lines, `--password`-style flags, `curl -u user:pass`, `=>` assignments and URLs with an empty username or an `@` in the password are covered. A receipt id or checkpoint ref that looks like a credential is refused, because both are stored as identifiers. The receipt summary that reaches the mission event log is the redacted one. Every pattern is bounded, so scanning is linear in the input, and a string over 100,000 characters is truncated first. Redaction is best effort: it cannot see a secret split across fields or encoded.

## Routes

| Method and path                                 | Caller                       | Purpose                                              |
| ----------------------------------------------- | ---------------------------- | ---------------------------------------------------- |
| `POST /runners/enrollments`                     | human, `admin:tokens`        | Pin a version and digest, get an enrollment token.   |
| `POST /runners/register`                        | enrollment token             | Redeem it once. Returns the bound runner credential. |
| `POST /runners/claims`                          | runner                       | Poll: heartbeat, schedule, collect work.             |
| `POST /runners/heartbeat`                       | runner                       | Liveness and evidence, no new work.                  |
| `POST /runners/leases/:id/progress`             | runner                       | Ordered, redacted progress. Counts as evidence.      |
| `POST /runners/leases/:id/checkpoints`          | runner                       | Record a portable ref.                               |
| `POST /runners/leases/:id/receipts`             | runner                       | Idempotent outcome. Closes the lease.                |
| `POST /runners/leases/:id/reconcile`            | runner                       | Take a recovering lease back under a new fence.      |
| `GET /runners`                                  | human, or runner (self only) | Runners with status and load.                        |
| `GET /runners/leases`, `/audit`                 | human                        | Leases, and the audit of lifecycle and refusals.     |
| `GET /runners/leases/:id`                       | human, or owning runner      | Lease with progress, checkpoints, receipts.          |
| `PATCH /runners/:id`                            | human                        | `allowedScopes`, `maxConcurrent`, `paused`.          |
| `POST /runners/:id/quarantine`, `/unquarantine` | human                        | Stop or restore a runner.                            |
| `POST /runners/leases/:id/release`              | human                        | Give up on a stuck lease.                            |
| `POST /runners/attempts/:id/release`            | human                        | Give up on a dispatched attempt nobody claimed.      |

Scopes alone cannot tell a human from a runner here, since both hold `runner:write`. Operator routes also require the `human` principal kind. Runner routes require the `runner` kind and the bound credential. Runner credentials hold only `runner:read` and `runner:write`, and the kind ceiling in `src/auth/principals.ts` keeps `policy:*`, `decision:*`, `admin:tokens` and `provider:sync` out of any token a runner can hold. They get 403 on every policy, decision and write route (`test/api/runners.test.ts` walks the route table).

`/runners/register` is the only fleet route a not-yet-runner reaches. It is not public: the enrollment token authenticates it.

## Threat model

Each entry names the control and where it is tested.

- **R-01 Unenrolled or replayed registration.** Enrollment tokens are issued by a human, expire, and are revoked on first use. A used, expired or unknown token cannot register. `test/fleet/enrollment.test.ts`.
- **R-02 Wrong build enrolls.** The human pins version and digest at issue time. Registration needs exactly that pair, and every claim re-checks the binding and the supported range. `test/fleet/enrollment.test.ts`.
- **R-03 Stolen runner credential.** The credential is bound to one runner, one version and one digest, holds only runner scopes, and is refused if it is not the bound token. A human can quarantine the runner. **Residual:** a thief with the credential and the runner's pinned values acts as the runner until quarantined.
- **R-04 Stale or zombie runner writes.** Fencing tokens, expiry and one live lease per scope. Refusals are recorded. `test/fleet/leases.test.ts`.
- **R-05 Two runners mutate one scope.** Partial unique index plus transactional claim. `test/fleet/leases.test.ts`.
- **R-06 False progress.** A heartbeat claim without matching attempt evidence never renews a lease and never counts as work proof. Receipts and progress need the current fence. Tower's verification, not the runner's report, makes a packet `verified`.
- **R-07 Secrets in receipts and progress.** Redaction before persistence, including audit and the mission event log. `test/fleet/redaction.test.ts` plants secrets and scans every table and API response.
- **R-08 Runner escalates authority.** Scope ceiling, human-only operator routes, no rebind route. `test/api/runners.test.ts`.
- **R-09 Inbound exposure.** None. Runners only connect out.

**Residual risk, version and digest are self-reported.** The pinned version and build digest are what the runner **says** it is. The runner is a machine the owner controls, and Tower has no hardware attestation, signed build, or measured boot to check the claim against. The pin stops an honest mistake and an unenrolled client. It does not stop a compromised or modified runner from presenting the pinned values. The controls that limit that case are the narrow credential scopes, fencing, redaction, human verification of every packet, and quarantine.

Other residual risks: a runner **declares its own capabilities** on every poll, and only `allowedScopes` is a ceiling a human sets, so a compromised runner can claim any `cap:`-only work inside its allowed scopes. A checkpoint ref is the runner's own claim that it pushed work. A quarantined runner's work is never moved automatically for that reason. Redaction is pattern-based. A `human` principal holds every scope and so can use any operator route.

## Limits

- The mission core has no `attempt.cancelled` or re-dispatch event, and `attempt.dispatched` needs a `ready` packet. Tower cannot withdraw a dispatched attempt. An attempt dispatched to a runner that never polls again waits (visible as a `withheld` offer or a `recovering` lease) until the runner returns or a human releases the attempt or its lease. After a reassignment the core still records the original runner as the attempt's runner, and the receipt is relayed by the fleet principal.
- The fleet principal (`prn_fleet_<workspace>`) is a disabled principal of kind `chief_of_staff`. No token can be issued to it. It is the actor on scheduler events and relayed reports, and the producer of a relayed report, so it never verifies.
- Quota and scope changes do not revoke work already running. They stop new claims.
- Leases, receipts, progress and audit rows are never deleted, and there is no per-runner rate limit or per-lease row cap. One credential can grow the tables, and every refused call writes an audit row. A retention job and rate limits belong with the quota work (T-14).
- The lease claim, the audit-after-rollback second transaction and the core commands joined to the fleet transaction rely on `BEGIN IMMEDIATE` and `SAVEPOINT`. D1 supports neither, so the D1 adapter in `DEFERRED.md` has to replace them with a batch guarded by the expected state, and re-run the lease race test.
- Tower does not run the scheduler on a timer. The poll runs it, as does `POST /work/schedule`.
