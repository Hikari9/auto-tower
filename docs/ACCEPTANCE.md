# Acceptance criteria → evidence

Spec: hikari9/auto-tower issue #1. "Test" names refer to `it(...)` titles in `test/`. "Live" items need deployment or accounts and are tracked in `DEFERRED.md`.

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| A1 | Repo operates independently of Auto-Office; versioned adapter, no copied runtime | Met | `docs/CONTRACTS.md`; `src/contracts/office-v1.ts`; `src/adapters/office/auto-office.ts`; `auto-office.test.ts` |
| A2 | Authenticated user creates a mission through MCP, closes the chat, sees it in the dashboard and another chat | Met locally (live ChatGPT: D1, D3) | `api-mcp.test.ts` "a mission created through MCP survives the chat…"; `scripts/smoke.ts` |
| A3 | Mission includes outcome acceptance, child work, links, dependencies, decisions, evidence history | Met | `mission.test.ts` dependency, parent/child, audit replay tests; `issues.test.ts`; `policy.test.ts` |
| A4 | Persists with all laptops off and states "waiting for eligible runner" | Met | `mission.test.ts` "creates a durable mission that waits for a runner…"; `resilience.test.ts` "sweeps are safe to repeat…" |
| A5 | Newly online eligible runner claims authorized work without human interaction | Met | `runner.test.ts` "dispatches automatically to a newly online runner, end to end over HTTP" |
| A6 | Two runners cannot both hold or land the same mutable scope; stale receipts fenced | Met | `runner.test.ts` "never gives two runners the same mutable scope…", "migrates checkpointed work…", "two machines share the queue…" |
| A7 | Sleeping runner reconnects and reconciles; no blind double execution | Met | `runner.test.ts` "marks a silent runner lost…", "asks the owner before restarting lost non-portable work…", "a restarted runner process replays…" |
| A8 | In-goal follow-ups proceed; expansion goes to a bounded chief decision or the inbox | Met | `policy.test.ts` "lets in-scope follow-up work proceed…", "routes an uncovered expansion…", "lets the chief approve only under a current delegated rule…" |
| A9 | Revoked/denied grant blocks the next guarded effect; history auditable | Met | `policy.test.ts` "blocks a guarded effect immediately after revocation…", "enforces explicit deny…" |
| A10 | Repeated approvals propose a rule; nothing enabled until accepted | Met | `policy.test.ts` "proposes a standing rule after repeated approvals…" |
| A11 | Inbox answer resumes only affected branches | Met | `policy.test.ts` "routes an uncovered expansion…" (other mission keeps dispatching), "dedupes decisions shared by several branches…" |
| A12 | No required independent review bypassed by a producer or delegated landing authority | Met | `policy.test.ts` "never lets a producer or a chief grant satisfy required independent review"; `runner.test.ts` "lands only after Tower authorizes…" |
| A13 | Link-only missions need no plugin; GitHub provider reads and reconciles | Met (live GitHub: D4) | `issues.test.ts` link-only, observe and bidirectional tests |
| A14 | Authorized close verified against the provider before completion | Met | `issues.test.ts` "closes an authorized required issue and completes only after read-back…" |
| A15 | Failed close, missing evidence, outage or reopened issue shows as a discrepancy | Met | `issues.test.ts` read-back mismatch, provider failure, reopened-webhook tests; `mission.test.ts` high-risk verification |
| A16 | Dashboard shows missions, agents, runners, decisions, authority and verified evidence | Met | `public/app.js` views; verified vs self-reported badges; checked in a browser against a seeded server |
| A17 | API and MCP require authn/z; runners cannot escalate grants, leak secrets or close issues | Met | `api-mcp.test.ts` auth and scope tests; `runner.test.ts` redaction; only `IssueService.reconcile` (Tower principal) can close |
| A18 | Cloud model triage/execution flag disabled by default; no hosted-AI spend | Met | `resilience.test.ts` "keeps cloud AI off by default…"; no model SDKs in dependencies |
| A19 | Recovery drill: mission, policy version and audit history survive restart/restore | Met | `resilience.test.ts` restart and restore drills |
| A20 | Documented install, first run, monitoring, backup, revocation, smoke tests | Met | `docs/OPERATIONS.md`; `scripts/smoke.ts` |
| Op | Tested from a fresh chat and a separate computer | Not yet (live) | Needs deployment (D1), OAuth for ChatGPT (D3), and a second machine running `tower-runner` |
