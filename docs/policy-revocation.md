# Policy revocation and incident runbook

How to stop a runner, a chief of staff or a credential, in what order, and how to know it worked. Every step is tested in `test/ops/revocation.test.ts`.

## What revocation does and does not do

- **Revoking a rule takes effect on the next guarded effect.** Policy is read at the point of effect, so a rule revoked now blocks the next close, the next claim and the next flag check. There is no cache to flush.
- **A packet a chief of staff authorized under that rule is withheld at the next claim.** The claim re-checks the cited rule and any deny rule that now covers the packet. The runner is told `authority: ...` and given no lease. The rule id is removed from what the runner sees, and is shown only to a person or a chief of staff in `read_mission` holds.
- **Work already running keeps running.** A lease a runner confirmed before the revocation continues until it ends, as `docs/runner-protocol.md` says for quota and scope changes. To stop it, quarantine the runner (step 3) or halt.
- **Nothing is deleted.** Revoked rules, receipts, events and history stay, so the record of what was allowed and when survives.
- **Revoking is for a person.** A chief of staff, runner or provider cannot revoke a rule, halt, or revoke a credential.

## Runbook

Do these in order. Stop at the earliest step that closes the hole, then review.

### 1. Halt

Stops new dispatch and every guarded effect at once, so nothing new starts while you work. It changes no row.

```sh
pnpm ops halt --actor <your principal id> --reason "<what happened>"
```

Over MCP: `halt_workspace` with `confirm: true`. Use the CLI if you doubt the token you would use. Check with `pnpm ops status`: `status` is `halted`.

### 2. Revoke the rules

Find the rules the actor relied on. MCP `read_policy` lists active rules and their grantees. Revoke each:

- MCP: `revoke_policy` with `ruleId`, `expectedVersion` and `confirm: true`.
- HTTP: `POST /policy/rules/:id/revoke`.

To forbid something no matter what else allows it, add a **deny rule** (`POST /policy/rules` with `effect: deny`). A deny rule beats every allow, and it also stops a cited allow rule whose pattern is broader than the deny, for example a deny on `a.b` against an allow on `a.*`.

Check: `read_policy` no longer lists the rule. After resume, a runner polling for work authorized under it gets `withheld: authority: ...` and no lease.

### 3. Quarantine the runner

If a runner host may be compromised: `POST /runners/:id/quarantine` with a reason. Its credential is refused on every call (`runner_quarantined`), its running work is not handed to another runner (a quarantined runner's checkpoint is its own word), and a person decides what happens to that work. Release a lease with `POST /runners/leases/:id/release` and an unclaimed offer with `POST /runners/attempts/:id/release`.

### 4. Revoke the credential

Tower has no route that revokes a token or disables a principal, so that a leaked token cannot do either. On the host:

```sh
# one token
pnpm ops revoke-token       --actor <your principal id> --token-id <id> --reason "leaked in a log"
# a principal and every token it holds
pnpm ops disable-principal  --actor <your principal id> --principal <id>  --reason "host compromised"
```

Both act on the next request: the token check reads these rows every time. An open MCP session ends with its token. Each action is in the append-only `ops_revocations` table with who, why and when. Tower refuses to disable the last enabled person, so someone can always resume.

Find a token id: `GET /runners` shows a runner's principal. Token ids are in `api_tokens` (digest only, never the token). `pnpm tower token create` prints the id when it issues one.

### 5. Review

- `read_health`: the status and signals, and the recent halt history.
- `GET /runners/audit`: every fleet refusal, including fenced writes from the old holder.
- `GET /policy/receipts`: every denied or escalated act.
- `read_audit` with `source: tool_calls`: what each principal called.
- Each mission the actor touched: `read_mission`, the decisions it answered, and the packets it authorized.

Anything you cannot trust, reject or requeue: `POST /missions/:id/work-packets/:packetId/reject`, and re-authorize under a new rule.

### 6. Resume

```sh
pnpm ops resume --actor <your principal id> --reason "<what you changed>"
```

Dispatch runs again under the policy as it stands now. Revoked rules, disabled principals and quarantined runners stay that way. A rule that was never revoked still allows. Grant fresh authority deliberately, as a person, with a narrow pattern and an expiry.

## Which lever for which problem

| Problem                         | Lever                                                                                     |
| ------------------------------- | ----------------------------------------------------------------------------------------- |
| Anything unclear or fast-moving | Halt first                                                                                |
| A rule was too broad            | Revoke it, grant a narrower one                                                           |
| An action must never happen     | Deny rule                                                                                 |
| A chief of staff token leaked   | Disable the principal, revoke rules it relied on                                          |
| A runner host is compromised    | Quarantine, disable its principal, release leases                                         |
| A person's token leaked         | Disable the principal (needs a second person)                                             |
| A feature flag should be off    | `set_feature_flag` with `enabled: false`, or revoke its named rule. It reads off at once. |
| A provider credential leaked    | Revoke it at the provider. Tower stores none.                                             |

## Limits to know

- The halt and the revocation CLI work on the database file you point them at. Run them as the user that owns it, on the host that serves Tower.
- Revoking a feature flag's rule turns the flag off at read time, and only the rule the flag names counts: another rule that covers the same use does not keep it on.
- Reviewer independence for Auto-Office receipts is only as strong as the engine's own report (`docs/adapters/office.md`, Residual risks). For a high-risk mission, a person's review through a Tower principal is the check that does not depend on the engine.
