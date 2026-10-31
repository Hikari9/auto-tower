# Source of Truth

Each kind of state has one authoritative owner. Tower records what it owns and treats everything else as an observed or linked reference.

## Ownership matrix

| Domain                                                                                                         | Authoritative owner                  | Tower behavior                                                  |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------- |
| Mission goals, acceptance, dependencies, status, dispatch, reconciliation, decision history, evidence pointers | Auto Tower                           | Canonical durable state, versioned transitions, queryable audit |
| Owner preferences and explicit authority grants, limits, expiry, revocations                                   | Auto Tower policy store              | Canonical, dynamically evaluated enforcement, auditable         |
| GitHub or other issue title, content, comments, open or closed state                                           | Issue provider                       | Optional link or adapter projection; authorized writes only     |
| Auto-Office work packets, harness routing, local run state, engineering SDLC                                   | Local Auto-Office runtime            | Tower assigns bounded work and consumes verified receipts       |
| ChatGPT conversations and temporary model context                                                              | Chat client or active Chief of Staff | Interface for reasoning; never authoritative grants             |
| Model subscriptions, host credentials, worktrees                                                               | Execution machine or provider        | Kept local; Tower records capability and availability only      |
| Human's original approvals and explicit policy changes                                                         | Human, recorded by Tower             | Never inferred from repeated patterns                           |

## Where each Tower fact lives (v1 Phase 0)

| Fact                                      | Storage             | Mutability                                                      |
| ----------------------------------------- | ------------------- | --------------------------------------------------------------- |
| Workspaces                                | `workspaces`        | Insert only                                                     |
| Principals and their kind                 | `principals`        | Insert; `disabled_at` may be set                                |
| Token digests, scopes, expiry, revocation | `api_tokens`        | Insert; `revoked_at` may be set. The raw token is never stored. |
| Mission and other domain events           | `events`            | Append only. Enforced by triggers.                              |
| Replay records for idempotent calls       | `idempotency_keys`  | Append only. Enforced by triggers.                              |
| Applied schema versions                   | `schema_migrations` | Insert only                                                     |

Domain tables for missions, decisions, policy grants, runners, and issue links arrive in later tasks. Each will name its owner here before it is written.

## Rules that follow from the matrix

- Tower never infers a grant from an event pattern. A grant exists only as an explicit, human-recorded row.
- Chat context is never a source of authority. A Chief of Staff acts only under a grant the policy store currently holds.
- A runner's self-report is recorded as self-reported until Tower verifies it.
- Issue state is read from the provider. Tower's copy is a snapshot with a timestamp.
- Local secrets and session credentials stay on the execution machine. Tower stores none of them.
