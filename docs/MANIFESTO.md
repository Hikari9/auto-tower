# Auto Tower Manifesto

Missions outlive tools, agents, sessions, machines, models and issue trackers.

Auto Tower applies the [Auto Office Manifesto](https://github.com/Hikari9/auto-office/blob/main/MANIFESTO.md) at mission, fleet, delegation and external-reconciliation scale. Auto-Office keeps owning its own engineering lifecycle. Tower does not copy it.

1. **The mission is the unit of truth.** A mission is a verified outcome, not a chat, a run, or an issue. Tower owns its lifecycle and evidence. A finished Auto-Office run is not a finished mission.
2. **Durable first, clever second.** Tower stays useful with no model running. The database is the record; queues, workers and sessions are replaceable.
3. **Waiting is a state, not a failure.** With no eligible runner, work waits and says so. Tower never claims a model is working when no runner is.
4. **Authority is explicit, scoped and current.** Default deny. Grants come from the owner, carry scope and limits, can expire, and are rechecked at the point of effect. Repetition creates proposals, never grants. Explicit deny always wins.
5. **Permission is not review.** Permission to act and independent quality approval are separate gates. A producer cannot approve its own work, and a Chief of Staff grant never counts as review.
6. **Ask only for real decisions.** Humans get executive choices with a recommendation, consequences and the authority needed. Mechanical routing, identifiers and routine testing never reach the inbox. Silence never approves.
7. **Block the branch, not the fleet.** A held decision stops only the work that depends on it.
8. **One writer per scope.** Leases and fencing tokens make sure only one runner holds a mutable scope. Work moves between machines only with a portable checkpoint.
9. **External systems own their issues.** Tower links, observes and writes only under explicit grants. Completion requires every required issue to be verified closed or explicitly exempted. Drift after completion is surfaced, never hidden.
10. **Evidence outlives the session.** Every transition records who, what, which rule version and which correlation id. Evidence is redacted and kept. Missing or stale evidence is never a pass.
11. **Scale ceremony to risk.** Low-risk work flows on integrated verification. High-risk outcomes need independent review and explicit verification.
12. **Nothing is hard-wired to one person.** Rico Mode and Auto-Office are the v1 defaults, configured per workspace. Personas, engines, policies and issue providers are adapters.
