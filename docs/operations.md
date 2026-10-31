# Operations and monitoring

What to watch, what each signal means, and the one switch to throw when something is wrong. The code is in `src/ops/`, the MCP tools in `src/mcp/tools/ops.ts`, the CLI in `scripts/ops.ts`, and the tables in `migrations/0009_hardening.sql`.

## Where to look

| What                          | How                                                                               | Who                   |
| ----------------------------- | --------------------------------------------------------------------------------- | --------------------- |
| Is the process up             | `GET /health` answers `{"status":"ok"}`. No detail, no auth.                      | Anyone, by design     |
| Is the workspace healthy      | MCP `read_health`, or `pnpm ops status` on the host                               | Mission readers; host |
| Why is a mission stuck        | `read_mission` (holds, with the reason), `briefing`, the dashboard                | Mission readers       |
| What did a tool call do       | MCP `read_audit` with `source: tool_calls`                                        | Policy readers        |
| Who changed a feature flag    | MCP `read_audit` with `source: feature_flags`                                     | Policy readers        |
| What the fleet refused        | `GET /runners/audit`                                                              | Humans                |
| Every denied or escalated act | Policy receipts (`GET /policy/receipts`)                                          | Policy readers        |
| Halt and revocation history   | `read_health` (recent halts), the `ops_halt_history` and `ops_revocations` tables | Mission readers; host |

`/health` is liveness only so that it can stay public without describing the workspace. Do not put workspace detail behind it.

## Health status

`read_health` and `pnpm ops status` return one `status` and the active `signals`.

| Status     | Meaning                                                                          |
| ---------- | -------------------------------------------------------------------------------- |
| `ok`       | No signal is active and the workspace is running.                                |
| `degraded` | At least one warning signal. Work continues, something needs attention.          |
| `critical` | A critical signal is active, or the store could not be read. Treat as an outage. |
| `halted`   | A person halted the workspace on purpose. It outranks `degraded` and `critical`. |

Signals live in memory, per server process, because the failure they report is often a store that will not take writes, which is the one place a signal cannot be saved. A restart clears them and the next failure raises them again. Each signal has a stable `code`, a `message` that says what happened, an `action` that says what to do, the time it began, the time of the latest occurrence and a `count`.

### Signals

| Code                               | Severity | Raised when                                                      | Cleared when                                       |
| ---------------------------------- | -------- | ---------------------------------------------------------------- | -------------------------------------------------- |
| `storage.quota_exhausted`          | critical | The store refused a write for space or plan limits               | An operator runs `quota-reset` after freeing space |
| `fleet.claim_refusal_write_failed` | warning  | A claim-time authority refusal could not be written to the audit | The next claim writes its refusals                 |
| `ops.sweep_failed`                 | warning  | The scheduled sweep failed for a workspace                       | The next sweep succeeds everywhere                 |

## Storage quota: fail closed

When the store refuses a write because it is out of space or over its plan limit (SQLite `database or disk is full`, or a D1 storage limit), the quota guard trips. From then on:

- **Every mutation is refused at once**, with `storage_quota_exhausted` and a message that says what to do. The guard does not try the store again, so a nearly-full disk is not hammered.
- **Reads keep working.** You can inspect state and take a backup while writes are refused. MCP reads work too: an MCP call does not need a write to be answered.
- **Nothing is half done and nothing is falsely reported.** A mission moves by appending an event, a claim writes its lease, and an outbound issue close writes its marker before it calls the provider. A store that cannot take those writes cannot be told that work happened, so the work does not start. A transaction that hits the limit rolls back as a whole.
- **The signal `storage.quota_exhausted` stays up** until an operator clears it, even if space comes back by itself. Clearing is a decision, not a timer.

To recover: free space or raise the plan limit, take a backup (`pnpm ops backup`), then clear the guard with the MCP tool `reset_storage_guard` (a person only, `confirm: true`) or by restarting the server. The guard trips again at once if the store is still full. The Node server runs on the guarded database (`startHost`).

Tool-call audit rows are written on a best-effort basis, so while the guard is tripped the audit cannot record the refusals themselves. The health signal is the record of that window.

## Emergency halt

A halt stops what could do harm and keeps everything else.

**Stopped:** new dispatch (the scheduler dispatches nothing and does not run, so no packet moves from pending to ready and no mission changes state), new leases and re-sent offers (a polling runner is told `emergency halt: dispatch is stopped`), and every guarded effect (`policy.guard` refuses with code `workspace_halted`, so no provider issue is closed), and every feature flag reads as blocked.

**Kept:** missions, packets, attempts, leases, decisions and policy, exactly as they were. Work a runner already confirmed keeps its lease and can still report progress and its receipt: halting does not destroy a result. Leases still expire on the clock, so a runner that goes quiet during a halt still moves to recovery.

**Who:** a person only. A chief of staff, runner or provider cannot halt or resume. A halt and every resume is in the append-only `ops_halt_history` with who, why and when.

```sh
pnpm ops halt   --actor <human principal id> --reason "cos token leaked"
pnpm ops status                       # status: halted
pnpm ops resume --actor <human principal id> --reason "token revoked, rules reviewed"
```

The same two actions are MCP tools, `halt_workspace` and `resume_workspace`, both material (they need `confirm: true`) and both limited to a person with `policy:write`. Use the CLI when the token you would use might be the compromised one: it works on the database file and needs no running server and no bearer token.

Resuming does not restore anything that was revoked. Dispatch runs again under the policy as it stands now.

## The scheduled sweep

A mission should never wait for a runner to poll before it moves. A sweep ticks every workspace on an interval: it expires and recovers leases, then runs the scheduler.

- **Node server:** an interval, default 15 seconds (`TOWER_SWEEP_INTERVAL_MS`, `0` turns it off). The timer does not keep the process alive, and a sweep still running when the next tick fires is skipped, not stacked.
- **Workers:** a cron trigger (`[triggers]` in `wrangler.toml`, every minute) calls `scheduled` in `src/hosting/worker.ts`, which runs the sweep the host supplies as `env.SWEEP`. Until the D1 adapter exists there is no store and it does nothing (`DEFERRED.md`). A failing sweep fails the trigger, so Cloudflare records it.
- One workspace failing does not stop the others. A failure raises `ops.sweep_failed` with the error name only, never its message.

A halted workspace is swept for lease expiry and not scheduled.

## What to do when

| You see                                            | Do                                                                                                              |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `critical` with `storage.quota_exhausted`          | Free space, back up, clear the guard (above).                                                                   |
| `degraded` with `fleet.claim_refusal_write_failed` | Check database health. Runners are still refused. The refusals are written on the next claim.                   |
| `degraded` with `ops.sweep_failed`                 | Read the server log for the error name. Runner polls still schedule, so work is not stopped.                    |
| A mission `needs-attention`                        | Read its discrepancies and holds (`read_mission`). A hold's `reason` says which check refused it.               |
| A runner reports `officeNotIngested`               | The receipt was stored but no Office verdict was read. The work is not reviewed. See `docs/adapters/office.md`. |
| You suspect a leaked credential or a wrong grant   | `docs/policy-revocation.md`. Halt first.                                                                        |
| A restore or a rollback                            | `docs/backup-restore.md`.                                                                                       |

## Resilience guarantees, and where they are tested

`test/ops/resilience.test.ts` and the tests it points at hold these. Each says what must not happen.

| Failure                                                                            | Behavior                                                                                                             |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Retry storm of one receipt                                                         | One stored receipt, one effect. Every retry is a replay.                                                             |
| Retry storm of one webhook delivery id, or one signed body under many delivery ids | One effect. The delivery id and a hash of the raw signed body are both kept.                                         |
| Two hosts send different receipts for one lease                                    | The first is kept. The second is refused and cannot change the outcome.                                              |
| Network drops during a claim                                                       | The same lease is sent again until confirmed. Never a second lease.                                                  |
| A lease granted but never confirmed                                                | The work waits in recovery. It is never handed to another runner without a checkpoint, and never reported done.      |
| Heartbeat with no progress evidence                                                | The lease is not renewed, expires and recovers. The attempt is not reported.                                         |
| The issue provider is down                                                         | A discrepancy, no completion, no close. Completes only after a successful read-back.                                 |
| An unsupported provider                                                            | A required link on it cannot be verified closed, so it blocks completion.                                            |
| Hostile text in an issue, a title or a log                                         | Stored and shown as data. It grants nothing, closes nothing, and secrets in runner text are redacted before storage. |
| Quota exhaustion                                                                   | Mutations fail closed with an actionable signal. No lost mission, no false success.                                  |
