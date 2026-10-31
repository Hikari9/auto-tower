# Mission Lifecycle

How Tower models a mission, moves it between states, decides when it may complete, and schedules its work. Code lives in `src/core/`. HTTP routes live in `src/api/routes/missions.ts` and `src/api/routes/work.ts`.

## Entities

Tower keeps four things apart so a finished run is never mistaken for a finished mission.

| Entity                | What it is                                                                                  | Verified by                                  |
| --------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------- |
| **Mission**           | The durable outcome: intent, outcome, constraints, risk, size, definition of done, links.   | Outcome evidence, then the completion guards |
| **Work packet**       | One bounded unit of work inside a mission, with dependencies on other packets.              | Tower's own verification with evidence       |
| **Execution attempt** | One try at a packet on one runner. Holds what the runner _claimed_.                         | Never. A report is self-reported             |
| **Issue link**        | A stored URL classified `required`, `optional` or `reference-only`. Grants no write access. | Not in this task (see Out of scope)          |

A mission carries: id, workspace, title, intent, outcome, constraints, risk (`low`/`medium`/`high`), size (`xs`..`xl`), priority (`low`..`urgent`), definition-of-done checklist, source, creator, parent and `requiredForParent`, links, policy refs, accumulated evidence refs, outcome verification, state, version, and timestamps.

## One stream per mission

Every change to a mission, its packets and its attempts is an event in one stream, `mission:<id>`, in the append-only `events` table. One stream means one version counter and one transaction for everything that must hold together, such as "all required packets are verified".

The tables `missions`, `work_packets`, `packet_dependencies` and `execution_attempts` (`migrations/0002_missions.sql`) are a projection of that stream. A command appends its event and rewrites the projection rows in the same transaction. The projection is derived data. It can be deleted and rebuilt from the events (`rebuildProjection`), and a test proves replay reproduces it exactly.

Event types:

| Event                      | Effect                                                                       |
| -------------------------- | ---------------------------------------------------------------------------- |
| `mission.created`          | Creates the mission in `draft`.                                              |
| `mission.updated`          | Changes descriptive fields. Discards any outcome verification.               |
| `mission.transitioned`     | Moves the mission to a new state. `cancelled` also cancels open packets.     |
| `mission.outcome_verified` | Records outcome evidence while `verifying`.                                  |
| `packet.added`             | Adds a packet. Discards any outcome verification.                            |
| `packet.dependency_added`  | Adds an edge to the dependency graph.                                        |
| `packet.authorized`        | Records who authorized the packet and under which policy refs.               |
| `packet.readied`           | `pending` to `ready`. Scheduler only.                                        |
| `attempt.dispatched`       | `ready` to `leased`, naming the runner. Scheduler only.                      |
| `attempt.started`          | `leased` to `running`.                                                       |
| `attempt.reported`         | Runner's claim. Packet becomes `reported` (success) or `failed`.             |
| `packet.verified`          | Tower verified a `reported` packet. Needs evidence refs.                     |
| `packet.rejected`          | A `reported` packet failed verification and becomes `failed`.                |
| `packet.requeued`          | `failed` back to `pending`. Clears the authorization, so it needs a new one. |

Every event records the actor, the expected previous version (the append fails if it is stale), a correlation id, and optional policy refs and evidence refs. Payloads hold request data only. State timestamps come from the event's recording time, except for scheduler events, which carry `at` from the injected clock.

## Mission states

`draft`, `planning`, `ready`, `running`, `waiting-runner`, `waiting-decision`, `waiting-external`, `verifying`, `reconciling`, `completed`, `needs-attention`, `cancelled`.

The full table is `MISSION_TRANSITIONS` in `src/core/transitions.ts`. Anything not listed is rejected with `InvalidTransitionError` (HTTP 409 `invalid_transition`). Highlights:

- `completed` is a target of `verifying` only.
- `cancelled` has no exits.
- `completed` can move to `reconciling` or `needs-attention`, so drift in an external required issue can reopen the mission. The completion event stays in the history.
- `reconciling` returns to `verifying`, never straight to `completed`.

Packet and attempt tables are in the same file.

## Completion

A mission completes only when all of this holds:

1. It is in `verifying`. The table allows no other source.
2. Every registered completion guard passes. Core guards:
   - `outcome-verified`: a verifier recorded evidence with `mission.outcome_verified`.
   - `definition-of-done`: every checklist item is done.
   - `required-packets-verified`: every required packet is `verified`. A packet a runner reported successful is only `reported`.
   - `required-children-completed`: every child mission with `requiredForParent` is `completed`. A cancelled child is a recorded decision to drop that scope and does not block the parent.
3. The actor is a human or chief of staff. Runner and adapter principals are refused.

All failing guards are reported together (HTTP 409 `completion_guard_failed` with `details.failures`). A guard that throws counts as failed. Later tasks register more guards on `core.guards`, for example the required-linked-issue check.

Separation of producer and verifier: a principal that reported an attempt cannot verify that packet or the mission's outcome (`SelfVerificationError`, HTTP 403). Editing a mission, adding a packet, sending it back from `verifying`, or reopening a completed mission discards the outcome verification (and clears `completedAt`), so evidence always matches what was verified and a mission that drifted cannot re-complete on old evidence.

Not yet in this task: independent review gates for high-risk missions and provider read-back. Those arrive with the policy and provider tasks, as guards.

## Work packets and the dependency graph

An update must change at least one field, so an empty update cannot discard a verified outcome. A new mission's checklist items are all not done. Only an update marks them done.

A packet is `pending` until it has an authorization and every packet it depends on is `verified`. Then the scheduler marks it `ready`. Only `verified` satisfies a dependency, so a failed or cancelled prerequisite keeps its dependents `pending`.

Adding an edge that would close a cycle is rejected with `DependencyCycleError` (HTTP 422, `details.path`). Only `pending` packets can gain prerequisites.

After a requeue, authorize the packet again and move the mission back to `ready`. The scheduler does not visit `needs-attention` missions, because a person put them there.

Branches are independent. A failed packet blocks its own dependents only. Packets on other branches keep running, and the mission is not marked `needs-attention` until nothing else can move.

## Scheduler

`scheduler.tick(workspaceId, actor)` visits missions in `ready`, `running`, `waiting-runner` and `waiting-decision`, most urgent first and oldest first within a priority. For each mission, in one transaction, it:

1. Marks authorized packets with verified prerequisites `ready`.
2. Asks the runner pool for an eligible runner per ready packet and dispatches an attempt when it finds one.
3. Moves the mission to the state its packets imply (`deriveMissionState`):

| Packets                                                  | Mission state      |
| -------------------------------------------------------- | ------------------ |
| Any `leased`, `running` or `reported`                    | `running`          |
| Any `ready` with no runner took it                       | `waiting-runner`   |
| Every required packet `verified`                         | `verifying`        |
| A packet that could start is waiting for authorization   | `waiting-decision` |
| Anything else, such as a failed packet blocking the rest | `needs-attention`  |

Authorized ready work with no runner is `waiting-runner`. It is never failed, and it stays that way for any length of time. When a runner appears, the next tick dispatches it with no human action. Until the runner protocol lands, `NO_RUNNERS` is the default pool, so every authorized mission waits.

A tick is deterministic for a given state, pool and clock. It stamps its events with the injected clock, takes ids from the injected generator, and a second tick over unchanged state appends nothing. `POST /work/schedule` runs one pass for the caller's workspace.

A runner principal may start or report only an attempt dispatched to its own id. A human or chief of staff may report on a runner's behalf and is then recorded as the producer, so it cannot verify that work.

## Limits

- A mission accepts at most 5,000 events (`maxEventsPerMission`). Every command replays the stream, so the cap bounds the cost of one command. At the cap a mission records only what winds it down: moves to `cancelled` or `needs-attention` (even from `completed`), and a runner starting or reporting an attempt that was already dispatched. A retry of the command that reached the cap still returns its first result. The scheduler stops adding work at the cap, never appends past it, and can still flag the mission `needs-attention`.
- At most 200 packets per mission, 100 list items, and 256 KiB per request body.
- Replay mutates one state in place instead of copying it per event. It works on copies of event payloads, so the history read from the log is never changed by a later event.

## Idempotency and concurrency

- Every mutation of an existing mission carries `expectedVersion`. A stale value fails with 409 `version_conflict` and writes nothing.
- A request with an `Idempotency-Key` header is replayed from its first result: the mission as it was after that event, with `replayed: true`. The same key with a different body is rejected (409 `idempotency_key_reused`). Keys are scoped to the workspace and the calling principal.
- A replay is answered before state checks, so a retry still succeeds after the mission has moved on. A failed request leaves no record, so its key can be reused.
- The event log includes the correlation id in its request hash, so a retry must send the same `X-Correlation-Id` as the first attempt, or none. A different one is rejected as key reuse. With none, it defaults to the key.
- When a key is present, new entity ids (mission, packet) derive from it, so a retried create names the same entity.
- Delivery is at least once. Business effects are protected by idempotent transitions, not by an exactly-once claim.

## API

All routes need a bearer token. Reads need `mission:read`, writes `mission:write`. The workspace always comes from the token. A mission in another workspace answers 404, the same as a missing one.

| Method and path                                     | Purpose                                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `POST /missions`                                    | Create. 201 first time, 200 on replay.                                                |
| `GET /missions`                                     | Search: `q`, `state` (comma list), `parentId`, `priority`, `risk`, `limit`, `offset`. |
| `GET /missions/:id`                                 | Read, with packets and attempts.                                                      |
| `PATCH /missions/:id`                               | Update descriptive fields. Needs `expectedVersion`.                                   |
| `POST /missions/:id/cancel`                         | Cancel. Touches nothing outside Tower.                                                |
| `POST /missions/:id/transitions`                    | Move to another state through the table and guards.                                   |
| `POST /missions/:id/outcome-verification`           | Record outcome evidence while `verifying`.                                            |
| `GET /missions/:id/activity`                        | Event history in order. `after` and `limit` page it.                                  |
| `POST /missions/:id/work-packets`                   | Add a packet.                                                                         |
| `GET /missions/:id/work-packets`                    | Packets and attempts.                                                                 |
| `POST /missions/:id/work-packets/:pid/dependencies` | Add a dependency edge.                                                                |
| `POST /missions/:id/work-packets/:pid/authorize`    | Authorize a packet. A chief of staff must cite `policyRefs`.                          |
| `POST /missions/:id/work-packets/:pid/verify`       | Verify a reported packet with evidence.                                               |
| `POST /missions/:id/work-packets/:pid/reject`       | Mark a reported packet failed.                                                        |
| `POST /missions/:id/work-packets/:pid/requeue`      | Put a failed packet back to `pending`.                                                |
| `POST /work/schedule`                               | Run one scheduler pass.                                                               |

Headers: `Idempotency-Key` and `X-Correlation-Id` (1 to 128 printable ASCII characters). Bodies are JSON, capped at 256 KiB, and unknown fields are rejected.

Error codes: 400 `validation_failed` (with `details.issues`), `invalid_json`, `invalid_header`; 403 `forbidden_actor`, `self_verification`; 404 `mission_not_found`, `packet_not_found`; 409 `version_conflict`, `idempotency_key_reused`, `invalid_transition`, `command_not_allowed`, `completion_guard_failed`; 413 `payload_too_large`; 422 `dependency_cycle`.

Runner principals hold no `mission:write`, so they cannot call any mutating route here. The core refuses them too, as a second layer.

## Parent and child missions

A child names its parent at creation and cannot change it. Cancelling a parent does not cancel its children. They keep their own lifecycle until someone cancels them.

## Cancel and external issues

Cancelling a mission appends one `mission.transitioned` event. The projection cancels its open packets and live attempts. Links are stored data, and the core has no provider port, so cancel cannot reach an external issue. A required link on a cancelled mission is never closed because of the cancel.

## Hosting notes

The service runs each command in one synchronous transaction: read the stream, append, check, write the projection. That fits `node:sqlite`. A Cloudflare D1 adapter has no interactive transaction and is asynchronous, so it needs a different write path, such as one batch guarded by the expected version. The SQL in `migrations/0002_missions.sql` is plain and portable. Re-check long search patterns against D1's `LIKE` limit when that adapter is built.

## Out of scope for this task

- Policy enforcement. Evidence and policy references are opaque strings that nothing resolves yet, and a chief of staff may cancel a required child, tick checklist items and verify an outcome. Until the policy store lands, treat a chief of staff token as able to complete a mission it did not execute. The producer check only blocks principals that reported an attempt.
- Runner registration, heartbeats, leases, fencing and the real runner pool (the scheduler reads a `RunnerPool` port).
- Policy evaluation and the Decision Inbox. Packet authorization is recorded with its policy refs, and a chief of staff must cite one, but nothing evaluates them yet.
- Issue provider sync, read-back and the required-link guard.
- Mission-to-mission dependencies. Mission relationships are parent and child.
- Running the scheduler on a timer. `src/hosting` does not start it. Call `POST /work/schedule` or `scheduler.tick`.
