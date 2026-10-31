# Glossary

| Term | Meaning |
| --- | --- |
| **Workspace** | Tenancy boundary. v1 ships single-owner, single-workspace, but every row carries `workspace_id`. |
| **Principal** | An authenticated identity: `human` (owner), `chief` (Chief of Staff client such as Rico Mode via ChatGPT), `runner` (a machine), `provider`/`system` (internal). Each has scopes. |
| **Mission** | A verified outcome with intent, constraints, risk, definition of done, acceptance, authority envelope, dependencies, links and evidence. States: `draft → active → verifying → reconciling → completed`, plus `paused`, `needs_attention`, `cancelled`. |
| **Activity** | Derived explanation of an active mission: `running`, `queued`, `waiting_runner`, `waiting_decision`, `waiting_dependency`, `waiting_external`, `verification_pending`, `planning`, `idle`, `done`. Never authoritative. |
| **Blocker** | Why one branch is waiting (decision, runner, dependency, external issue, review, recovery). |
| **Discrepancy** | A recorded mismatch: reopened issue, provider error, failed verification, read-back mismatch. |
| **Work packet** | A bounded unit of work for one office engine with a scope, acceptance, risk and review requirement. Kinds: `work`, `integration`. Origins: `planned`, `followup`, `expansion`. |
| **Integration packet** | Added by Tower when a mission has several outputs; verifies the assembled result. |
| **Execution scope** | The mutable thing a packet writes, e.g. `repo:acme/app#branch`. One holder at a time. |
| **Attempt** | One runner's try at a packet, with a lease, a fencing token and an immutable dispatch contract. States: `leased`, `running`, `lost`, `succeeded`, `failed`, `fenced`, `cancelled`. |
| **Lease** | Time-bounded claim renewed by heartbeat. Expiry makes the attempt `lost` and the packet `recovering`. |
| **Fence** | Monotonic token per execution scope. Receipts and effects with an old fence are rejected. |
| **Checkpoint** | Progress marker. Only a *portable* checkpoint (pushed branch, persisted artifact) allows another runner to take over. |
| **Dispatch contract** | `tower.dispatch/v1`: what Tower hands a runner for one attempt. |
| **Receipt** | `tower.receipt/v1`: progress, checkpoint, completion or failure reported by a runner. Idempotent by `receiptId`. |
| **Gate** | Tower's evaluation of a completion receipt against the packet's evidence profile (self-verification, tests, commit SHA, independent review, integrated verification). |
| **Authority envelope** | Owner-approved actions and resources for a mission (tier 1 scope). |
| **Expansion** | A request to act outside the envelope (tier 2/3). Goes to the Chief of Staff only under a delegated rule, otherwise to the owner. |
| **Rule** | Explicit authority: `allow` or `deny`, action pattern, resource pattern, grantee (`chief`, `runner`, `tower`, `any`), conditions (max risk, max uses, missions), expiry. Versioned via the workspace policy version. |
| **Proposal** | A suggested rule, from the Chief of Staff or from repeated owner approvals. Grants nothing until the owner accepts it (optionally narrowed). |
| **Preference** | A learned, non-authoritative signal. The policy evaluator never reads preferences. |
| **Decision** | An inbox item: question, alternatives, recommendation, consequences, required authority, affected scope, dedupe key, linked packets. Audience `chief` or `human`. |
| **Issue link** | A normalized external URL attached to a mission as `required`, `optional` or `reference`. Provider `link` (no plugin) or an installed provider such as `github`. |
| **Sync mode** | Per integration: `link` (store only), `observe` (read state), `bidirectional` (also close under grants). |
| **Point of effect** | The moment just before a guarded side effect. Authorization is evaluated here against the latest committed policy. |
| **Emergency halt** | Workspace switch that stops claims and guarded effects. Reads continue. |
