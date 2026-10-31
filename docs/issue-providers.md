# Issue links and providers

How Tower links missions to external issues, reads them back, closes them under authority, and notices drift. Code lives in `src/issues/`. Routes are in `src/api/routes/issues.ts` and `src/api/routes/webhooks.ts`. Tables are in `migrations/0006_issue_links.sql`. The provider contract id is `tower.issues.v1` (see `docs/adapters.md`).

## The short version

- A link is a stored URL with a class: `required`, `optional` or `reference-only`. The class lives on the mission. Links work with no provider configured, and a link grants no write access.
- Tower's copy of an issue is a snapshot read from the provider. Issue titles and bodies are untrusted data. Tower never treats them as instructions.
- A mission completes only when every `required` link is verified closed by a provider read-back, or a person approved an exemption. A link counts from the moment it is required. Removing it from the mission, or downgrading it to `optional` or `reference-only`, does not stop it counting: it keeps holding the mission open until a read-back shows it closed or a person approves an exemption. Verify and poll still read such a link, and `GET .../issue-links` still lists it (`classification: null` when removed, `countsAsRequired: true`). Tower never closes a link that is no longer `required`.
- Tower writes to a provider only when the repository's sync scope allows writes **and** a Tower `authorize` returns `allow` for that exact issue.
- Optional and reference-only links are never closed. Cancelling a mission closes nothing.
- A failed or doubtful close leaves the mission `reconciling` or `needs-attention` with a discrepancy record. A required issue that reopens or drifts after completion does the same, and the completion event stays in the history.

## Sync modes

A sync config row says what Tower may do for one repository (`owner/name`, lower-case) or, with `*`, the workspace default. A repository row beats the default. With no row at all the mode is `link-only`.

| Mode            | Read scope | Write scope | Meaning                                                                        |
| --------------- | ---------- | ----------- | ------------------------------------------------------------------------------ |
| `link-only`     | no         | no          | Store URLs. Fetch nothing.                                                     |
| `observe`       | yes        | no          | Read issues for read-back, polling and webhooks. Write nothing.                |
| `bidirectional` | yes        | yes         | May also close a required issue, if Tower's own `authorize` allows that close. |

The scopes follow from the mode. A request may name them (`readScope`, `writeScope`) to make the intent explicit, and a mismatch is `400`. A config is changed by a person only (`PUT /issues/sync-config` needs `policy:write`, held by humans), since it widens what Tower may do to an outside system.

## Links

`POST /missions/:id/issue-links` adds a link through the mission's own update, so it needs `expectedVersion` and `mission:write` and appears in the mission's `links`. The URL must be `https`, name a public DNS host, carry no credentials and use the default port. IP literals in every notation (decimal, hex, octal, IPv6), `localhost`, single-label names and internal suffixes such as `.internal` or `.local` are refused with `400`. The fragment is dropped. A recognised GitHub issue URL is normalized to `https://github.com/<owner>/<repo>/issues/<n>`. Any other public https URL is kept as a link-only reference and can only be completed by exemption.

Tower never fetches a stored URL. A provider builds its API URLs from a parsed owner, repository and number against its own fixed API host, and never follows a redirect (a redirect means the issue moved, and is reported as `transferred`). A DNS name that later resolves to a private address therefore cannot be reached through a link.

The mission routes accept links too (`POST /missions`, `PATCH /missions/:id`) with the same check, so an http, loopback, private, link-local or metadata URL is refused with `400` there as well. A public https URL that is not a GitHub issue is stored and shown, and the issue layer will not fetch it, because no provider owns it.

Each linked URL gets one tracking row (`issue_links`) the first time anything lists, verifies, closes or adds it. A webhook or poll for a link with no row has nothing to compare against and is ignored. It holds the last observed state, where that came from (`readback`, `poll`, `webhook` or `close`), the provider's identity for the issue (`node_id`, captured by the first read-back), `verified_closed_at`, and any exemption. Only a provider read-back sets `verified_closed_at`. A webhook never does.

## The completion guard

`required-issues-closed` is registered on the core's guard registry by `createIssueService`. `createApp` builds the service before it handles any request, so no route can complete a mission ahead of it. A host that builds its own core and calls `core.missions` directly must build the service over the same core. The check is synchronous and reads what the last read-back stored. The set of links it answers for is every URL the mission has carried as `required`, read from the mission's event stream. For each of them:

- an approved exemption passes it;
- otherwise it needs `verified_closed_at`, the last observed state `closed`, a captured identity, no unresolved discrepancy that needs attention, and a read-back no older than 15 minutes.

Everything else fails with the link named. `required-issues-closed` appears beside the core guards in `details.failures` of a `409 completion_guard_failed`.

## Authorized close

`POST /missions/:id/issue-links/close` (`mission:write`, human or Chief of Staff, mission `verifying` or `reconciling`) takes an optional `{ "urls": [...] }`. Without it, every required link is attempted, in order. Naming an optional or reference-only link is `409 link_not_required`. For each link:

1. An exempt link, a link no provider owns, and a repository without write scope are reported (`exempt`, `unsupported`, `write_scope_disabled`) and nothing is sent.
2. `authorize` runs for action `issue.close`, resource `<provider>:<owner>/<repo>#<n>`, scope `repo:<owner>/<repo>`, the mission's risk and the mission id. A denial is recorded as a policy receipt and reported as `policy_denied` with the policy reference. Nothing is sent. `issue.close` is in the sensitive-action registry in `src/policy/actions.ts` (`external_issue_close`), so only a grant that names the action, resource and scope allows it. A wildcard grant does not.
3. Tower reads the issue, with its open blockers. A closed issue is verified and not written again (`already_closed`). A different identity, a transfer or deletion (`identity_mismatch`) and open blockers (`blocked`) stop here.
4. `authorize` runs a second time just before the write, so a grant revoked during the read stops it.
5. Tower records the outbound write with a fresh origin marker, then asks the provider to close the issue and note the marker in a comment.
6. Tower reads the issue back. It must be closed and be the same issue. Otherwise the result is a discrepancy.

A rate limit (`429`, or a `403` with `retry-after`, an exhausted limit or the secondary-limit message) is stored as `retry_not_before` on the link. Until it passes, closes, verifies and polls for that link answer `backoff` and send nothing, and a close stops trying the remaining links.

Every outcome comes back in `results[]` with HTTP `200`, so one refused link does not hide the others. `satisfied` says whether every required link is now verified closed or exempt with nothing open that needs attention.

`POST /missions/:id/issue-links/verify` (`mission:write`) reads every required link back without writing to the provider. `POST /issues/poll` (`provider:sync`, held by provider adapters and humans) does the same across the workspace's live missions and is the fallback for missed webhooks. It visits the least recently polled links first, and stamps every link it tries, so a workspace with more tracked links than the `limit` reaches all of them over successive polls.

## Discrepancies

A discrepancy is a row in `issue_discrepancies`, written once and only ever resolved, never deleted (triggers enforce it). Its `detail` is Tower's own wording and never copies issue text.

| Kind                   | Raised when                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| `close_failed`         | The provider refused the close for a reason that is not one of the others.                   |
| `read_back_mismatch`   | The provider accepted the close and the read-back still shows the issue open.                |
| `permission_denied`    | The provider rejected the credential or the action.                                          |
| `rate_limited`         | The provider asked Tower to wait (`retryAfterSeconds` is recorded).                          |
| `provider_unavailable` | Network failure, timeout, 5xx or an unusable response.                                       |
| `identity_mismatch`    | The URL names a different issue than the one linked, or it was transferred or deleted.       |
| `blocked`              | Open issues block the one Tower was about to close.                                          |
| `reopened`, `drifted`  | A required issue that was verified closed, or sits under a completed mission, is open again. |

A discrepancy with `requiresAttention` moves a `verifying` mission to `reconciling` and a `completed` one to `needs-attention`. Failures of a close always need attention. A transient failure while polling or verifying (outage, rate limit) is recorded without moving a completed mission, because an outage is not drift. A lost identity and a reopened issue under a completed mission do move it.

A later provider read-back that shows the same issue closed resolves everything except `identity_mismatch`. When a `reconciling` mission has nothing left that needs attention, a person or Chief of Staff's call moves it back to `verifying`. It never goes straight to `completed`. A person can resolve any discrepancy by hand (`POST /missions/:id/issue-discrepancies/:id/resolve`, a note is required). Resolving an `identity_mismatch` accepts the issue the URL names now: the stored identity is cleared and the next read-back pins the new one. `poll` also repairs a mission left behind by a crash between the record and the move.

Provider adapters cannot change mission state through the core, so the issue layer moves a mission with its own narrow decision. An adapter may move a mission only to `reconciling` or `needs-attention`. Resuming to `verifying` needs a person or Chief of Staff. Nothing in the issue layer can complete a mission.

## Exemptions

A required link can be exempted so a mission finishes while the issue stays open. A person or Chief of Staff requests it with a reason (`POST .../issue-links/:linkId/exemption`). Only a person approves (`.../exemption/approve`) or revokes (`.../exemption/revoke`), because that decides a mission may finish with its issue open. An exempt link is never closed or polled, and drift on it is not a discrepancy. Every step is in the link's history.

## Webhooks

`POST /webhooks/:provider/:workspaceId` is mounted only when the host passes `webhooks` settings to `createApp`. It is not in `ROUTES`, so the shipped public surface stays `/health`. The host supplies, per workspace and provider, the signing secret and the id of a `provider_adapter` principal in that workspace. Secrets never enter Tower's database.

1. An unknown workspace, an unknown provider and a bad signature all answer the same `401`. The signature is the HMAC-SHA256 of the raw body (`X-Hub-Signature-256`), compared in constant time.
2. Only after the signature checks out is the delivery id (`X-GitHub-Delivery`) used. A repeated id answers `duplicate` and changes nothing. The id is stored in the same transaction as the processing, so a failed delivery can be retried. A forged request cannot use up an id.
3. GitHub sends no timestamp, so the replay control is the delivery id plus the signature, not a time window.
4. The body is capped at 1 MB.
5. The event is decoded, matched to tracked links by repository and issue number, and folded in with source `webhook`. A webhook can mark an issue open, closed, transferred or deleted. It never verifies a close.

**Origin marker.** Every write Tower makes is recorded in `issue_outbound_ops` before it is sent, under an id that is also placed in the close comment (`<!-- tower:origin:<id> -->`). A `closed` event for a link with a pending write of its own, inside ten minutes, is the echo of that write, and so is a comment carrying a known id. Echoes are recorded as such, do not raise a discrepancy and trigger nothing. Webhook handling never calls the provider, so it cannot start a write that echoes back. A `reopened` event is never an echo, and an invented marker matches nothing.

## Untrusted text

The provider's title is cleaned (control and bidirectional characters become spaces, 500 characters at most), stored in `observed_title` and returned under an `untrusted` key next to the link's own title. Bodies are not stored. Responses are JSON with `X-Content-Type-Options: nosniff`. Nothing derived from issue text feeds a decision, a policy request, a mission transition reason or a discrepancy.

## The GitHub provider

`createGitHubProvider({ token, fetch?, apiBase?, timeoutMs? })` implements `tower.issues.v1`.

- `token` is a function called per request. Tower stores no credential and never logs one.
- Reads use `GET /repos/{owner}/{repo}/issues/{n}`, and `.../dependencies/blocked_by` for blockers. A `404` or `403` on the blockers path means the blockers are unknown (`openBlockers: null`), which is not the same as none: an authorized close stops with a `blocked` discrepancy until the blockers can be read. Any other failure there fails the read.
- Close uses `PATCH` with `state: closed` and reason `completed`, then a best-effort comment carrying the origin marker.
- It checks the response is the issue asked for (same number, repository and a stable `node_id`) and is not a pull request.
- Redirects are never followed. `401` is `permission`. `403` with `retry-after`, an exhausted limit or the secondary-limit message, and `429`, are `rate_limited` with the wait capped at 24 hours. Other `403` is `permission`. `5xx`, network failure and timeout are `unavailable`.
- A custom `apiBase` (GitHub Enterprise) must pass the same public-https check as a link.

A provider's failure text is Tower's own wording. The provider's body is never copied into an error, a discrepancy or a log.

## Threat model notes

This task covers the planned parts of T-07 (signature, delivery id dedupe, origin markers), T-08 (no stored URL is ever fetched, links restricted to public https hosts, API calls to a fixed host without redirects) and T-09 (issue text is data). `docs/threat-model.md` still describes them as planned.

## Not covered here

- Credentials and public delivery. Provisioning a GitHub App or token, and exposing the webhook endpoint publicly, are in `DEFERRED.md`.
- A grant revoked in the instant between the second `authorize` and the provider receiving the write is not stopped. The check cannot be atomic with a network call.
- Only the GitHub provider exists. Other trackers are stored as link-only references.
- Cloudflare D1 needs an asynchronous path for the guard and the service. They read and write through the synchronous `SqlDatabase` port.
- Link classification is edited through the mission (`PATCH /missions/:id`), not through the issue routes.
