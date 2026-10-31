# Auto-Office adapter (`tower.office.v1`)

The Auto-Office adapter runs Tower work packets through the Auto-Office engine and reads back the
receipt. It lives in `src/adapters/office/`. The runner client that polls Tower and drives the
adapter lives in `src/runner/`, and its entry point is `bin/tower-runner.ts`. The contract rules are in
[adapters.md](../adapters.md).

Tower does not import Auto-Office code. The only shared surface is the JSON the CLI prints and the
packet and receipt shapes below.

## Packet (Tower to Office)

`buildOfficePacket` in `src/adapters/office/packet.ts` builds the packet from a runner lease.

| Field                                                                | Source                                                                     |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `contract`, `kind`                                                   | `tower.office.v1`, `work-packet`                                           |
| `correlationId`                                                      | the attempt id. Office must echo it back.                                  |
| `missionId`, `packetId`, `attemptId`, `leaseId`, `fence`, `scopeKey` | the lease                                                                  |
| `title`, `instructions`, `scope`                                     | the packet                                                                 |
| `outcome`, `intent`, `constraints`                                   | the mission                                                                |
| `resume`                                                             | Tower's stored progress sequence and last checkpoint                       |
| `policyRefs`                                                         | always `[]`. The runner's assignment does not carry the policy references. |
| `evidenceProfile`                                                    | always `standard`                                                          |

The runner's assignment carries no risk level and no acceptance criteria, so the packet cannot tell
Office either one. The high-risk rule is enforced when the mission completes (below), not when the
packet is dispatched.

## Running the CLI

`OfficeCliEngine` runs:

```
office start --json --no-prs --end-state ask --blast-radius repo -- <goal>
```

The goal is one argument: the packet title, outcome, intent, constraints and instructions, joined by
newlines. The argv is an array passed to `execFile` with no shell, so the goal is never interpreted.
Because the goal follows `--`, text that starts with a dash is a value and not an option. A goal
over 32,000 characters is refused rather than truncated.

The child process runs in the repository set by `repoPath`. The default timeout is two hours.

`--no-prs` keeps Office from pushing or opening pull requests. `--end-state ask` stops at a question
for a human rather than merging.

**Not verified against a real run.** The flags come from `office start --help` in Auto-Office 3.14.
The adapter also expects `--json` to print one receipt in the shape below. The current `start --json`
output is a run record, not that receipt, so a real run needs an Office-side receipt emitter or a shim.
See `DEFERRED.md`.

## Receipt (Office to Tower)

`parseOfficeReceipt` reads the receipt from an untrusted body. The contract id is checked first, so a
newer major fails with `unsupported_major` before any field is read. Unknown fields are ignored.

| Field                    | Meaning                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------- |
| `receiptId`              | Unique per run. Letters, digits, `. _ : -`, at most 128 characters.                   |
| `correlationId`          | Must equal the attempt id. Otherwise the receipt is refused.                          |
| `outcome`                | `succeeded` or `failed`                                                               |
| `selfVerification`       | The engine's own check. It is never independent review.                               |
| `independentReview`      | `{reviewer, result}`. The reviewer is the identity that reviewed the work.            |
| `integratedVerification` | `{result, testsRun, commitSha}`. Checks the integrated result.                        |
| `executor`               | The engine's executor identity                                                        |
| `failure`                | `{class, message}`. An unknown class becomes no class, and the adapter classifies it. |
| `residualRisks`          | Free text, kept in evidence only                                                      |

## Ingestion and completion

`factsOf` reads what Tower takes from a receipt:

- **Independent review is satisfied** only when the reviewer is not a producer. The producers are
  Tower's runner principal and the engine's executor id. Identities compare case-insensitively,
  ignoring surrounding space. A reviewer equal to a producer is recorded as `self-reviewed` and
  satisfies nothing.
- **Self-verification** passing is needed for any completion, and is not review.

`isReady` decides whether one receipt satisfies its risk level:

| Risk        | Ready when                                                                      |
| ----------- | ------------------------------------------------------------------------------- |
| low, medium | the outcome succeeded and self-verification passed                              |
| high        | the above, plus independent review satisfied and integrated verification passed |

Green tests alone are not enough on high risk.

`ingestOfficeReceipt` writes the facts to `office_receipts` (migration `0005`). The table is
append-only at the database. Ingesting the same receipt again is a replay that writes nothing. A
different receipt for an attempt that already has one is refused with `ReceiptConflictError`. The
table stores verdict facts only, not free text, so it holds no engine-supplied secrets.

`createOfficeReviewGuard(db)` returns a completion guard named `office-high-risk-review`. Register it
on the core registry. On a high-risk mission, every required packet needs a ready receipt. A mission
with no required packets needs at least one. Medium and low risk missions pass this guard.

The core guards still apply: required packets must be verified, and required children must be
completed or cancelled. A parent with one open required child does not complete.

## Failure classes

Every failed outcome carries one class from `src/runner/failure.ts`:

| Class                   | Meaning                                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| `environment`           | The binary is missing or the machine is misconfigured                                           |
| `runner`                | Transport loss, a timeout, or a process the runner could not supervise                          |
| `adapter`               | Unparseable output, a receipt for another attempt, an unsupported contract, or an unknown error |
| `quota`                 | The engine is out of quota or rate limited. The output matches a quota message.                 |
| `policy-denial`         | Tower's authority rules refused the action. The engine reports it in its receipt.               |
| `review-failure`        | Review rejected the work, or none could be recorded                                             |
| `implementation-defect` | The work was checked and the checks failed                                                      |

When the receipt gives no class, the adapter derives one. A failed self-verification or integrated
verification is an implementation defect. A rejected or missing review is a review failure.

## Runner client

```
TOWER_ENROLLMENT_TOKEN=<token> tower-runner register --url <origin> --state <file> \
  --version <x.y.z> --digest sha256:<hex>
tower-runner run --url <origin> --state <file> --version <x.y.z> --digest sha256:<hex> \
  --repo <path> [--office-bin <path>] [--capability <name>]...
```

The enrollment token comes from the environment, not an argument, so it does not reach the process
list. Registration stores the runner credential in the state file. The file is written owner-only
(`0600`) and renamed into place, so a crash leaves the old state or the new state.

The runner's loop is:

1. Settle receipts owed from before a restart. These are resent unchanged, so Tower records each
   receipt once.
2. Reconcile every lease that has no live engine. Tower returns the lease under a new fence, with the
   progress sequence it stored. Work resumes from there. A lease Tower will not reassign yet is kept
   and retried.
3. Poll. Tower answers with new assignments, cancellations and reconcile requests.

A lease is dropped when Tower cancels it, or when a newer fence or a closed lease refuses the
runner's writes. Cancellation arrives either as a directive on a live lease or as `unmatched` evidence
with `cancel: true`. A fatal refusal (quarantine, unsupported version, a credential not bound to the
runner) stops the loop and exits with code 1.

### Engine contract

An engine must make its mutations idempotent under `(attemptId, step)`. A step can run once before a
crash and again after reconcile. The runner only skips steps Tower has confirmed. A step after that
point may already have happened, so the second run must find its earlier mutation and not repeat it.

Progress reports go out in order. A step at or below the confirmed one is a no-op. Evidence is kept
small. Tower refuses evidence over 16 KB, so `officeRunnerEngine` caps residual risks and failure
messages.

## Claim-time authority

`claim` and reconcile re-check each cited policy rule before they grant work. A chief of staff's
authorization cites rules. Each cited rule is evaluated again at the point of the claim, through the
same check the mission core uses at authorization (`refusalForPolicyRefs`). A revoked, expired, replaced
or deny-covered rule withholds only the packet it authorized. The offer comes back with a reason that
starts with `authority:`. Other branches of the mission are granted as before.

A human's authorization cites no rule and is not re-checked. Work already running is not affected. The
check governs new grants and re-sent assignments.

The implementation is in `src/fleet/broker.ts` (`authorityReason`) and `src/fleet/leases.ts`. The tests
are in `test/fleet/claim-authority.test.ts`.

## Tests

- `test/adapters/office/` covers the contract pins, receipt judgement, ledger and guard, the argv and
  the stubbed process runner, and the runner glue. No test runs the real `office` binary.
- `test/runner/fleet-e2e.test.ts` runs two runners against one in-process server with the fake engine.
  It covers claim and completion, kill and reconnect without duplicate work, a lost receipt resent
  after restart, and the full chain from stored evidence through ingestion to the guard.
- `test/runner/` covers the transport, the state files, the CLI and the runner's own behaviour.

## Process and runner hardening

- **Process group.** The Office child leads its own process group. An abort or the two-hour timeout signals the group, so the engine's own children stop with it. A child that ignores SIGTERM is killed after five seconds.
- **Environment.** Tower's own variables (`TOWER_*`) are removed from the child's environment, so an engine cannot read the runner's enrollment token or credential from its environment.
- **Output.** Each run keeps at most 16 MB of stdout and stderr.
- **Receipts.** A summary over 4,000 characters, or a residual-risk list over 50 items or over 500 characters each, is clipped rather than refused. A completed run is not turned into an adapter failure by its own length.
- **Identities.** Reviewer and producer identities are compared after compatibility characters are composed and invisible format and control characters are removed, with case and surrounding space ignored. Look-alike letters from other scripts are not folded.
- **Ingestion.** A receipt whose correlation id names another attempt is refused. A repeated receipt id with a different verdict is a conflict, not a replay.
- **Permanent refusals.** When Tower refuses a runner's receipt or reconcile for good, the lease is parked for the rest of the process, and the poll continues. Transport loss and fatal refusals still end the poll.
- **Relaunch.** A re-fenced lease starts its new run only after the old run has ended, so two runs never share a repository.
- **Shutdown.** A stopping runner starts no job. A fatal refusal (quarantine, unsupported version, unbound credential) stops every running job before the runner returns. The CLI drains them before exit.
- **Transport.** A response over 8 MB is refused. The runner sends the bearer token over https only, or over http to a loopback address.
- **State.** The state file is written to a temporary file opened exclusively, with any stale file or link at that name removed first, then fsynced and renamed, and the directory is fsynced. The CLI refuses a state file inside `--repo`.
- **Retry hints.** A Tower retry hint longer than the timer limit is clamped to it.
- **Entry point.** `bin/tower-runner.ts` uses a shebang that resolves `tsx` from the working directory, so run it as `pnpm runner ...` from the repository. The bare shebang only works from inside the repository tree.

## Production wiring

`createApp` and the mission route register `createOfficeReviewGuard` on the core they build. The runner receipt route ingests a `tower.office.v1` receipt into `office_receipts` after Tower has accepted and stored the receipt. An ingestion error is logged, and the runner's receipt is not rejected. `test/adapters/office/production-gate.test.ts` drives the whole path through the routes: a high-risk mission is refused without an independent review, and completes once one is recorded.

## Residual risks

These are accepted, and the code does not mitigate them.

- **Engine-named reviewer.** The engine supplies the reviewer identity. Tower compares it with the producer identities, but it cannot confirm the reviewer is a separate session. Independence is only as strong as the engine's own report. A reviewer principal that Tower can verify is not defined by this contract.
- **Process table.** The goal is one argument to `office`, so anyone who can list processes on the host can read the packet text while the run is alive. Run the runner only on a single-user host, or keep secrets out of packet instructions.
- **Same-user engine.** The engine runs as the runner's user. It can read any file that user can read. Keeping the state file outside the repository limits what the engine sees by default, and it does not stop a same-user process.
- **Enrollment token.** Registration redeems the token before the credential is saved. If the save fails after a successful redeem, the credential is lost, and a human must issue a new enrollment.
- **Durability.** The state write is fsynced, but on macOS `fsync` does not force the disk cache. A power loss can still lose the most recent save, and the runner then reconciles from Tower's record.
- **Running work after revocation.** The claim-time check governs new grants and re-sent assignments. A lease already running continues until it ends, as `docs/runner-protocol.md` describes for quota and scope changes.
- **Pause.** The runner does not act on a `pause` directive. Tower withholds new work from a paused runner, and the runner's in-flight step runs to its end.
- **Homoglyphs.** Look-alike letters from other scripts are not folded in identity comparison (see Identities above).
