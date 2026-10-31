# Release review checklist

Run this before a release, a deploy, or any change that widens what Tower can do. It is a checklist for a person. A box a tool can tick for you is marked with the command. A box that needs judgment is not.

## 1. The build is clean

- [ ] `pnpm install --frozen-lockfile` leaves the lockfile unchanged.
- [ ] `pnpm check` passes: typecheck, Biome and every test.
- [ ] `pnpm smoke` passes. It is the end-to-end run, and it must pass on a clean checkout with the network off.
- [ ] `pnpm build` or the host's build step passes where the host has one (`AGENTS.md`: lint and typecheck do not catch build-time failures).
- [ ] No test was skipped, loosened or deleted to get here. `git diff main -- test` shows only additions and deliberate changes.

## 2. Authority did not widen

A release that makes Tower able to do more must say so, and a person must have agreed.

- [ ] No new route is public. `/health` is still the only one, apart from signature-checked webhooks and the OAuth metadata (`docs/mcp.md`).
- [ ] Every new route and MCP tool names its scopes. A material tool needs `confirm: true` (`test/mcp/protocol.test.ts` lists them).
- [ ] No new way for a chief of staff, runner or provider to grant, revoke, halt, spend or verify its own work.
- [ ] Policy still defaults to deny. A new action has a category in `src/policy/actions.ts` if it is sensitive.
- [ ] Feature flags are still off by default and still fail closed.
- [ ] A new provider or engine ships behind its own adapter and a fake, with activation steps in `DEFERRED.md`.

## 3. The record is intact

- [ ] Events, receipts, discrepancies and every history table are still append-only (triggers in the migration).
- [ ] No applied migration was edited. A schema change is a new file in `migrations/`, and `test/ops/backup.test.ts` restores a backup from the previous schema and migrates it forward.
- [ ] A backup taken before the release verifies and restores (`pnpm ops backup`, `verify`, `restore`). The rollback in `docs/backup-restore.md` names that backup.
- [ ] The release notes say whether a migration runs and whether it is reversible by restore only.

## 4. Failure behavior holds

- [ ] `test/ops/resilience.test.ts` passes, and a new external dependency has a case in it: a retry storm, an outage and a duplicate each produce one effect and no false success.
- [ ] A new write path fails closed under quota exhaustion: it writes its intent before it acts.
- [ ] A new guarded effect calls `policy.guard`, so the emergency halt and revocation stop it.
- [ ] `pnpm ops halt` and `resume` were exercised on a copy of the release database, and `pnpm ops status` read `halted` and then `ok`.

## 5. Secrets and untrusted text

- [ ] No credential, token or private key in the diff, the logs the tests print, or the docs. `git diff main | grep -iE 'ghp_|secret|token='` finds nothing real.
- [ ] Text from outside (issue titles, runner progress, receipts, webhook bodies) is stored and shown as data, never executed, and is redacted before storage where it came from a runner.
- [ ] Logs name an error, never print its message or a request body.
- [ ] Rule ids are shown only to a person or a chief of staff, not to a runner or a provider.

## 6. Independent review is as strong as claimed

The engine names its own reviewer, so Tower's independent-review check is only as strong as that report (`docs/adapters/office.md`, Residual risks, with the path to a Tower-verifiable reviewer principal).

- [ ] For any high-risk mission completed in this release cycle, a person reviewed the result and recorded the verdict through a Tower principal. An Office receipt alone is not enough for a release.
- [ ] No release note claims reviewer independence that a Tower-verifiable principal would be needed to prove.

## 7. Docs say what the code does

- [ ] `README.md` links every doc, and each link resolves.
- [ ] `DEFERRED.md` names, for every deferred item, its adapter, its fake, and its activation steps, including the approval step and the rollback.
- [ ] A behavior this release changed is changed in the doc that describes it, not only in the code.
- [ ] Anything "planned" in `docs/threat-model.md` that this release delivered is updated, and anything still planned says so.

## 8. Deploy gate

Not part of the repository release. Before any deploy: explicit approval for the target (`DEFERRED.md`, Cloudflare and D1), a backup in hand, the previous build ready to restore, and someone watching `read_health` for the first hour.

## Sign-off

Record who ran this, on which commit, the date, and any box left unticked with the reason. An unticked box that guards authority (section 2) or the record (section 3) blocks the release.
