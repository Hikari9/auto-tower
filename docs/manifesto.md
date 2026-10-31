# Auto Tower Manifesto

Auto Tower is durable mission control. It holds the record of what should happen, who may decide, and what was verified. It does not do the engineering itself. Auto-Office and future engines execute. Issue providers own their issues.

These principles come from the Auto Office manifesto and apply at mission, fleet, delegation, and external-reconciliation scale. Auto-Office keeps its own engineering lifecycle. Tower does not copy it.

## Principles

1. **Missions outlive tools.** A chat, a laptop, a session, or a model can end. The mission record in Tower survives all of them.
2. **Understand before dispatch.** A mission states its outcome, constraints, risk, and definition of done before any work is handed out.
3. **Authority is explicit.** Permissions come only from a human's recorded grant. Preferences are observed signals. A repeated pattern never widens authority, and a deny always wins over an inferred preference.
4. **Enforce in the server, not in prompts.** Scope checks, grant checks, and guards run at the API. Every mutating effect rechecks current authority at the point of effect.
5. **Dispatch only authorized work to eligible runners.** A machine advertises availability and capability. It never advertises or holds shared credentials.
6. **One writer per mutable scope.** Leases carry fencing tokens. Stale claims and receipts from fenced attempts are rejected.
7. **Self-report is not verification.** The producing session cannot satisfy an independent review requirement. A high-risk outcome is not complete on an executor's success message or on green tests alone.
8. **Completion needs proof.** A mission completes only when its outcome is verified and every required linked issue is verified closed, or an explicit exemption exists.
9. **Waiting is a state, not a failure.** A mission with no eligible runner waits. A blocked branch does not freeze unrelated branches.
10. **Human attention is for decisions.** Tower routes mechanical choices itself and sends the human only true executive choices, each with a recommendation and its consequences.
11. **Scale ceremony to risk.** Trivial work gets light gates. Consequential work gets independent review and integration checks.
12. **Integrate through contracts.** Tower talks to Auto-Office, runners, and issue providers through versioned contract ids and adapters. It does not fork or absorb their runtimes.
13. **Keep evidence durable and redacted.** Evidence pointers outlive the agent session. Secrets never appear in receipts, logs, or events.
14. **Assume retries.** Delivery is at-least-once. Business effects are protected by idempotent transitions and expected-version checks.
