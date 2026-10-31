# Authority: policy, three tiers, Decision Inbox

This document says who may do what in Tower, how that is checked, and how a question reaches a person. Code lives in `src/policy/` and `src/decisions/`. Routes are in `src/api/routes/policy.ts` and `src/api/routes/decisions.ts`.

## The short version

- Nothing is allowed unless an active **grant** covers it. An active **deny rule** beats any grant.
- Grants are scoped, versioned, attributable, revocable and may expire. Only a human writes them.
- **Preferences** and **proposals** are stored apart from grants. They never change an evaluation.
- Every guarded effect rechecks current authority at the moment it happens. A revoked grant stops the next effect.
- Requests that go beyond what is already authorized are routed in three tiers. Only the branch that needs an answer waits.
- Authority changes and decision changes are append-only events, readable through the API.

## Policy rules

A rule is one row of the policy store. A **grant** is a rule with effect `allow`. A **deny rule** has effect `deny`.

| Field                                 | Meaning                                                                                                           |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `action`                              | Dotted lower-case name such as `deploy.staging`. A pattern, where `*` matches any run of characters.              |
| `resource`                            | What the action touches, such as `repo:Hikari9/auto-tower`. A pattern.                                            |
| `scope`                               | The boundary the effect stays inside, such as `env:staging`. A pattern.                                           |
| `maxRisk`                             | Highest risk (`low`, `medium`, `high`) a grant covers. A deny rule applies at every risk.                         |
| `grantee`                             | `kind` (principal kind), `principalId`, or both. A grant needs one. A deny rule with neither applies to everyone. |
| `limits`                              | `maxAmount` (whole units of the smallest denomination) and `missionIds` (the grant covers only these missions).   |
| `expiresAt`                           | Optional. The rule stops applying at this instant.                                                                |
| `version`                             | Starts at 1 and moves on every amendment and on revocation.                                                       |
| `createdBy`, `updatedBy`, `revokedBy` | The principals responsible.                                                                                       |

Patterns have no syntax beyond `*`. They are matched without a regular expression engine, so a crafted pattern cannot stall evaluation. Patterns are limited to 256 characters and 8 wildcards.

The **policy version** is a workspace counter. It moves when a rule is created, amended or revoked, and only then. Each event in the `policy` stream carries it.

### Evaluation

`policy.authorize({ workspace, principal, action, resource, scope, risk, amount?, missionId? })` returns a `PolicyEvaluation`:

```
{ effect: 'allow' | 'deny' | 'escalate', code, reason, ruleId, ruleVersion, policyVersion, policyRef, evaluatedAt }
```

Callers store `policyRef` as the event `policyRef`. It reads `policy:v<policyVersion>:rule:<id>@<ruleVersion>`, or names the reason when no rule decided.

Only `allow` permits an effect. Evaluation reads the rules as they are committed when it is called. Nothing is cached, so a second service over the same database sees a revocation at once. The principal's kind is read from the store, never taken from the caller. `authorize` writes nothing, so it is safe inside any transaction.

Order of evaluation:

1. Unknown or disabled principal: `deny`.
2. An active deny rule that covers the request: `deny` (`explicit_deny`).
3. Independent review by a producer of the work: `deny` (`producer_cannot_review`). See below.
4. An active grant that covers the request: `allow`. It must cover the action, resource, scope and mission, the request's risk, and any amount.
5. Safe cleanup: `allow` (`safe_cleanup`).
6. Otherwise `deny`. If an expired or revoked grant would have covered it, the code says so (`grant_expired`, `grant_revoked`) and names the rule.

`escalate` is a refusal that the caller may route to a person or delegate. `authorize` returns it only when asked (`escalate: true`), which `routeExpansion` does. It never permits anything.

A grant with no `maxAmount` covers no request that carries an amount, and a grant with one covers no request that omits it. A spend request must state its amount, whatever grants exist. A request names one thing: a `*` or a `..` segment in its resource or scope is refused, so a rule can never match it as literal text and a pattern like `dir/*` cannot be walked out of.

### Sensitive actions

The first segments of an action name set its category.

| Category               | Matches                                                                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `spend`                | `spend`, `spend.*`                                                                                                                           |
| `production_deploy`    | a `deploy` or `release` segment with a segment starting `prod`, such as `deploy.production`, `release.production`, `infra.deploy.prod-eu`    |
| `security`             | `security.*`                                                                                                                                 |
| `destructive`          | `destructive.*`, or any segment starting `delete`, `destroy`, `drop`, `purge`, `wipe`, `truncate`, `remove`, or `force` together with `push` |
| `external_issue_close` | `issue.close`, `issue.close.*`                                                                                                               |
| `independent_review`   | `review.independent.*`                                                                                                                       |
| `cleanup`              | `cleanup.*`                                                                                                                                  |
| `standard`             | everything else                                                                                                                              |

Words match as the start of any segment, `_` reads as `-`, and a leading `cleanup.` does not hide them: `cleanup.drop-prod-db` is destructive, not cleanup. So `deploy.prod-eu`, `db.drop_table` and `billing.spend.create` are sensitive too. Every category except `standard` and `cleanup` is **sensitive**. A sensitive action is denied unless an active grant names the action, with no wildcard, and names a resource and a scope that are not made only of `*` (`**` counts as bare). A grant of `*` / `*` / `*` allows ordinary work and none of these. Callers choose action names, so a runner cannot relabel a sensitive effect. A name of the form `cleanup.*` whose remaining segments are not sensitive is allowed without a grant for a guarded effect, and is never an approval: the router and a Chief of Staff's answer accept only a real rule.

### Revocation and expiry

Revoking a grant makes the next guarded effect deny. A grant that was valid at dispatch is not trusted later: `policy.guard(request)` evaluates again at the point of effect, writes a receipt, and throws `PolicyDeniedError` unless the result is `allow`. A policy reference stored at dispatch is evidence of what was true then, and is not consulted again.

Safe cleanup (`cleanup.*`, such as releasing a lease or removing a scratch directory) stays allowed after revocation, so work in flight can wind down. An explicit deny rule blocks it too.

**Emergency halt** is a deny rule with action, resource and scope all `*` and no grantee. It stops every guarded effect and every cleanup until a human revokes it. No separate switch exists.

`guard` opens a transaction to write its receipt. Call it outside one, or call `authorize` and then `record(request, evaluation)`.

### Receipts

Refused effects and requests sent to a person leave a row in `policy_receipts`, which rejects update and delete. `GET /policy/receipts` lists them with the rule, rule version and policy version involved. Allowed effects leave none.

## Independent review

Permission to act and independent quality approval are separate gates.

- A grant of any width cannot make a producer satisfy a review. A principal that is a runner or reporter of any attempt on the mission, or that the caller names in `producerIds`, is denied `review.independent.*` whatever grants exist (`producer_cannot_review`).
- `review.independent.*` is sensitive, so a wildcard grant or a landing grant such as `land.merge` never satisfies it. Only a grant that names the review action does, and only for someone who did not produce the work.

Tower evaluates the gate. The code that requires a review, such as the Auto-Office adapter, has to ask for it with `authorize` or `guard`.

## Preferences and proposals

**Preferences** (`PUT /policy/preferences/:key`, human only) are signals Tower may show. Evaluation does not read them, and no preference can allow or deny anything.

**Proposals** come from repeated approvals. When a human approves a decision that carries a structured request, Tower counts it. At three approvals of the same action, resource, scope and risk it creates one pending proposal. The proposal records exactly what was approved: that action, resource, scope and risk, a grantee kind of `chief_of_staff`, and no more than the largest amount approved. It authorizes nothing.

A human resolves a proposal:

| Path    | Route                                | Result                                                                                        |
| ------- | ------------------------------------ | --------------------------------------------------------------------------------------------- |
| accept  | `POST /policy/proposals/:id/accept`  | A grant with exactly the proposal's qualifiers.                                               |
| narrow  | `POST /policy/proposals/:id/narrow`  | A grant with tighter qualifiers. A wider resource, scope, risk, cap or mission list is `422`. |
| decline | `POST /policy/proposals/:id/decline` | No grant. The same request is not proposed again.                                             |

Narrowing treats a candidate pattern as narrower only when the original pattern matches it as plain text, which never accepts a widening and may refuse a harmless narrowing.

A one-off approval of a decision never creates a grant. A CoS answer does not count toward a proposal. An approval later replaced by a decline stops counting.

## Three tiers

`routeExpansion(request)` settles a request that goes beyond what a mission already has. The requester is a principal. A runner or provider can ask. It can never approve.

| Tier | Condition                                                                                                                                                                                                                                                                                                   | Outcome                                                                              |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1    | In approved scope. The request's scope matches the scope of an authorized sibling packet, every scope the target packet declares lies inside it, the risk is no higher than the mission's, and the action is not sensitive, not cleanup and carries no amount. A scope with a `..` segment never qualifies. | `proceed`. No decision, no change.                                                   |
| 2    | A Chief A Chief of Staff asks, a current, matching grant held by that principal covers the request, and the target packet declares a scope that covers the requested scope.                                                                                                                                 | `approved`. The packet is authorized as that principal, citing the policy reference. |
| 2    | A runner A runner or provider asks, a delegated grant for Chief of Staff would cover it, and the packet declares a covering scope.                                                                                                                                                                          | A decision raised for a Chief of Staff.                                              |
| 3    | Anything else: no covering grant, an expired or revoked one, a sensitive or destructive action without a named grant, a limit exceeded.                                                                                                                                                                     | A decision raised for a person.                                                      |
| -    | A deny rule, an unknown or disabled requester.                                                                                                                                                                                                                                                              | `denied`. No decision. Nobody can approve past it.                                   |

Tiers 1 and 2 are judged against the mission's own data. A packet cannot vouch for its own scope, a scope of `*` does not count, and a claim about scope is checked against what the packet declared. A packet that declares no scope is never approved by a Chief of Staff. It goes to a person.

**Confidence is advisory.** The request may carry `advisory.confidencePercent`. It is stored with the decision for the answerer to read. It is not an input to evaluation, so 100 never authorizes and 0 never blocks.

Only the one branch waits. A branch is a work packet that is `pending` with no authorization. The scheduler already treats such a packet as waiting and keeps running every other packet in the mission and every other mission.

If no Chief of Staff is on hand, the branch simply waits on a durable decision. Nothing times out into an approval.

## Decision Inbox

A decision carries the fields the spec lists:

| Field                       | Meaning                                                                                                                                                          |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `links`                     | Mission and branch (packet) pairs that wait on it, each with a status.                                                                                           |
| `category`, `urgency`       | `scope_expansion`, `sensitive_action`, `destructive`, `spend`, `security`, `production`, `novel`, `clarification`. Urgency is `low`, `normal`, `high`, `urgent`. |
| `question`                  | The precise question.                                                                                                                                            |
| `alternatives`              | The choices. Each says whether choosing it `resumes` the branches. The default pair is approve and decline.                                                      |
| `recommendation`            | The recommender's choice and reason, and who made it.                                                                                                            |
| `consequences`              | What follows from approving.                                                                                                                                     |
| `requiredAuthority`         | `human` or `chief_of_staff`.                                                                                                                                     |
| `evidence`, `affectedScope` | Supporting references and the scope affected.                                                                                                                    |
| `request`                   | The action, resource, scope, risk and amount an approval would authorize, when there is one.                                                                     |
| `dedupeKey`                 | Identity of the question. See below.                                                                                                                             |
| `status`, `version`         | `open` or `answered`, and the version of the item's event stream.                                                                                                |
| audit                       | `GET /decisions/:id/history` and `GET /decisions/:id`, which includes every answer.                                                                              |

The inbox lists open items by urgency, then age, with answered items after.

### Who raises a decision

`POST /decisions` is open to a person and to a Chief of Staff. Only a person may choose `requiredAuthority`, so a request from anyone else is held to a person (`403` otherwise), and a Chief of Staff cannot raise a decision for itself to answer. For anyone but a person, the choices have fixed meanings: `approve` resumes and no other choice does, whatever the request said. `routeExpansion` sets `requiredAuthority` itself, and code that calls `decisions.raise` must do the same and never pass a caller's claim.

### Deduplication

An open decision with the same dedupe key absorbs a new request: the new branches are linked to it and no second item is created. The key must name the same subject. If its category or request differs, the call fails with `409 dedupe_conflict`, so one request cannot hang a branch on a decision about something else. `routeExpansion` derives its key from the action, resource, scope, risk and amount, so branches that need the same permission share one question. An answered item no longer absorbs requests.

### Answering

`POST /decisions/:id/answers` takes `{ version, choice, note? }`.

- **Who.** A human may answer any decision. A Chief of Staff may answer only a decision raised for one that carries a request, and only while a current grant covers that request for every mission the decision is linked to. That is checked at answer time, including that each linked packet declares a scope covering the request. Runner and provider principals get `403`, and their tokens do not carry `decision:write`.
- **Versions.** Answers carry a version. The highest version is effective, whatever order they arrive in. A lower version that arrives late is recorded and has no effect. The same version with the same content is a replay. The same version with different content is `409 answer_conflict`. Answers cannot be edited or deleted.
- **Resuming.** An effective answer whose choice `resumes` authorizes each linked packet that is still pending, as the answerer, citing `decision:<id>@<version>` and, for a Chief of Staff, the policy reference. It touches those packets and no others. A packet that is no longer waiting, or whose mission is locked, is `skipped` with a reason, and the rest still resume. Each attempt runs under a savepoint, so a refused one leaves nothing in the mission's log. The scheduler then dispatches the resumed packets on its next tick.
- **Declining.** A non-resuming answer marks the links `declined` and changes nothing in the mission. A later answer at a higher version can still approve.
- **Limit.** Authorizing a packet is an event in the mission's log and is not retracted. If a higher-version decline arrives after a lower-version approval already resumed a branch, the decision record shows the decline and the branch stays authorized. Order of arrival can change which branches resumed. It cannot change which answer is effective.

The mission core in this repository has no `blockBranch` or `unblockBranch`. A blocked branch is a pending packet without authorization, and unblocking it is `authorizePacket`, which is what the inbox calls.

## Who may do what

| Principal        | Policy read | Policy write | Raise a decision | Answer a decision          | Ask for an expansion | Approve an expansion       |
| ---------------- | ----------- | ------------ | ---------------- | -------------------------- | -------------------- | -------------------------- |
| human            | yes         | yes          | yes              | any                        | yes                  | by answering               |
| chief_of_staff   | yes         | no           | yes              | only under a current grant | yes                  | only under a current grant |
| runner           | no          | no           | no               | no                         | server side only     | never                      |
| provider_adapter | no          | no           | no               | no                         | server side only     | never                      |

Two layers enforce this. The token scopes: `policy:write` is held only by humans, and runners and providers hold neither `policy:*` nor `decision:*`. And each service call checks the actor's kind again, so a mis-issued token or a direct call still fails with `403`.

## Routes

All routes need a bearer token with the scope shown. Errors use the shared `{ error: { code, message } }` body.

| Method and path                                              | Scope                         | Purpose                                                               |
| ------------------------------------------------------------ | ----------------------------- | --------------------------------------------------------------------- |
| `GET /policy`                                                | `policy:read`                 | Policy version, active rules, preferences, pending proposals.         |
| `GET /policy/rules?status=`                                  | `policy:read`                 | Rules: `active`, `inactive` or `all` (default).                       |
| `GET /policy/rules/:id`                                      | `policy:read`                 | One rule.                                                             |
| `POST /policy/rules`                                         | `policy:write`                | Create a grant or deny rule. `Idempotency-Key` makes a retry safe.    |
| `PATCH /policy/rules/:id`                                    | `policy:write`                | Amend. Needs `expectedVersion`. `409` if stale.                       |
| `POST /policy/rules/:id/revoke`                              | `policy:write`                | Revoke. Needs `expectedVersion`.                                      |
| `GET /policy/history?after=&limit=`                          | `policy:read`                 | Every authority event in order: who, when, the rule as it became.     |
| `GET /policy/rules/:id/history`                              | `policy:read`                 | The same, for one rule.                                               |
| `POST /policy/evaluations`                                   | `policy:read`                 | Dry run for the caller, or for `principalId`. Records nothing.        |
| `GET /policy/receipts?after=&limit=`                         | `policy:read`                 | Refused effects and escalations.                                      |
| `GET /policy/preferences`, `PUT /policy/preferences/:key`    | `policy:read`, `policy:write` | Preferences.                                                          |
| `GET /policy/proposals?status=`, `GET /policy/proposals/:id` | `policy:read`                 | Proposals, with history for one.                                      |
| `POST /policy/proposals/:id/accept`, `/narrow`, `/decline`   | `policy:write`                | Resolve a proposal.                                                   |
| `POST /decisions`                                            | `decision:write`              | Raise a decision and link the branches it blocks.                     |
| `GET /decisions?status=&limit=`                              | `decision:read`               | The inbox, prioritized.                                               |
| `GET /decisions/:id`                                         | `decision:read`               | One decision with its answers.                                        |
| `POST /decisions/:id/answers`                                | `decision:write`              | Answer.                                                               |
| `GET /decisions/:id/history`                                 | `decision:read`               | Audit events for one decision.                                        |
| `POST /expansions`                                           | `decision:write`              | Settle an expansion request at its tier. The caller is the requester. |

A rule body names `grantee` and `limits` as nested objects, for example `{"action":"deploy.staging","resource":"repo:app","scope":"env:staging","maxRisk":"medium","grantee":{"kind":"chief_of_staff"},"limits":{"maxAmount":500},"expiresAt":"2026-12-31T00:00:00Z"}`. Unknown fields are rejected. `expiresAt` needs a time zone (`Z` or an offset). A value without one would be read in the host's zone, so it is refused.

## Audit

The `policy` event stream holds every authority change: `policy.rule.created`, `.amended`, `.revoked`, and `policy.proposal.created`, `.resolved`. Each event carries the full rule or proposal as it became, the actor, the correlation id and the policy version. `events` rejects update and delete, so history cannot be rewritten through the SQL interface. A decision's stream holds `decision.created`, `decision.linked` and `decision.answered`, and each resumed packet records a `packet.authorized` event in its mission citing the decision. `policy.rebuildProjection(workspace)` rebuilds rules, proposals and the version from the stream alone.

## Not covered here

- **The mission routes can still authorize a packet.** `POST /missions/:id/work-packets/:packetId/authorize` accepts a Chief of Staff token with any non-empty `policyRefs`, and the core does not evaluate them. A Chief of Staff can therefore authorize a pending packet there without a grant, around the tiers above. Closing it means evaluating policy inside `authorizePacketDecision` in `src/core`, or limiting that route to humans, which is outside this task's scope. Until then the tiers bind only callers that use `routeExpansion`, `/expansions` and the inbox.

- Hash-chaining the log is deferred (see `DEFERRED.md`). Someone with direct file access can still edit the database.
- A decline that arrives after a resume does not un-authorize the packet (see Answering).
- Receipts are written by `guard`, `routeExpansion` and a refused Chief of Staff answer. A caller that uses `authorize` alone and does not call `record` leaves none.
- The runner protocol, the Auto-Office adapter and the GitHub provider must call `guard` or `authorize` at their own points of effect. This layer provides the check. It cannot find effects it was never asked about.
