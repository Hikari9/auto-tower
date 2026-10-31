# Glossary

Terms as Tower uses them. Where a term names a database concept, the column or table is given.

| Term                     | Meaning                                                                                                                                            |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Workspace**            | Tenant boundary. Every tenant-owned row carries `workspace_id`. v1 ships a single-owner workspace, but no code assumes only one exists.            |
| **Mission**              | A durable, verified outcome with acceptance criteria, constraints, risk and size, definition of done, child work, dependencies, and linked issues. |
| **Outcome**              | The measurable result a mission is meant to produce.                                                                                               |
| **Definition of done**   | The checklist that must hold before a mission can be completed.                                                                                    |
| **Work packet**          | A bounded unit of work handed to an engine, such as one Auto-Office run. Distinct from its mission.                                                |
| **Execution attempt**    | One try at a work packet on one runner. A packet can have several attempts over time.                                                              |
| **Runner**               | A registered machine that claims and executes work. Holds no mission authority.                                                                    |
| **Runner claim / lease** | A runner's time-limited right to execute a scope. Renewed while live, expires when not.                                                            |
| **Fencing token**        | A monotonically increasing number issued with each lease. Receipts carrying an older token are rejected.                                           |
| **Principal**            | An authenticated actor: `human`, `chief_of_staff`, `runner`, or `provider_adapter`. Stored in `principals`.                                        |
| **Scope**                | A named permission such as `mission:write` or `policy:write`. Each principal kind has a ceiling of scopes.                                         |
| **Token**                | A bearer credential bound to one principal and a subset of its scopes. Stored as a SHA-256 hash in `api_tokens`.                                   |
| **Event**                | An immutable record appended to a stream. Stored in `events`. Never updated or deleted.                                                            |
| **Stream**               | The ordered sequence of events for one aggregate, such as one mission. Ordered by `version`.                                                       |
| **Expected version**     | The stream version a writer believes is current. An append at a stale version fails with a conflict.                                               |
| **Idempotency key**      | A caller-supplied key scoped to (workspace, principal). A replay with the same body returns the original event.                                    |
| **Correlation ID**       | An identifier that links events produced by one logical operation.                                                                                 |
| **Evidence ref**         | A pointer to retained proof, such as a commit SHA, test report, or receipt.                                                                        |
| **Policy ref**           | A pointer to the policy version that authorized an action.                                                                                         |
| **Permission (grant)**   | Explicit, versioned, revocable human authority for a defined class of action. Optionally expiring.                                                 |
| **Preference**           | An observed, non-authoritative signal. Never enforced as a grant.                                                                                  |
| **Decision**             | A question that needs a human or an authorized Chief of Staff to answer.                                                                           |
| **Decision Inbox**       | The prioritized list of open decisions shown to the owner.                                                                                         |
| **Chief of Staff**       | The optional reasoner that interprets intent and decides within explicit grants. Rico Mode is the v1 configuration.                                |
| **Office engine**        | An execution backend that runs bounded engineering work. Auto-Office is the first.                                                                 |
| **Issue provider**       | An adapter that reads, observes, and (under grant) writes an external issue tracker. GitHub is the first optional one.                             |
| **Issue link**           | A stored URL to an external issue, classified as **required**, **optional**, or **reference-only**. Stores no write access.                        |
| **Required link**        | A linked issue that must be verified closed before the mission can complete, unless an exemption is approved.                                      |
| **Reference-only link**  | A linked issue that is informational. Tower never closes it.                                                                                       |
| **Verified status**      | A status confirmed by Tower through evidence or provider read-back.                                                                                |
| **Self-reported status** | A status an agent or runner claims without independent confirmation. Shown separately from verified status.                                        |
| **waiting-runner**       | Mission state: authorized work exists but no eligible runner is online. Not a failure.                                                             |
| **Contract id**          | A versioned identifier for an integration boundary, such as `tower.office.v1`. See `docs/adapters.md`.                                             |
