# Deferred Work

Items here are real, planned, and intentionally not done. Each names its **adapter** (the port or module that will carry it), its **fake** (what tests and local runs use in its place, so nothing here needs a network or a paid service) and its **activation steps**. None is started without an explicit go-ahead.

## Cloudflare deploy and D1 provisioning

**Status:** Deferred. Issue #1 authorizes no deployment, DNS change, or paid resource on its own.

**Adapter:** a D1-backed `SqlDatabase` (`src/storage/database.ts` is the port). It does not exist yet, and the port is synchronous, which D1 is not (step 4).

**Fake:** `node:sqlite` through `openSqliteDatabase` (`src/storage/sqlite.ts`), on a file or `:memory:`. Every test and `pnpm smoke` use it. The Workers entry answers 503 until the adapter is wired.

**Why it matters:** Cloudflare Workers with D1 is the intended production host. Until D1 is provisioned, the Workers entry in `src/hosting/worker.ts` answers 503 and serves no data.

**Activation steps:**

1. **Get explicit approval.** Provisioning a D1 database and deploying a Worker are external, possibly billable actions. Confirm the account and the target before running anything.
2. **Create the database.** `pnpm dlx wrangler d1 create auto-tower`. This needs a Cloudflare login (`wrangler login`). Record the returned `database_id`.
3. **Bind it.** Add to `wrangler.toml`:

   ```toml
   [[d1_databases]]
   binding = "TOWER_DB"
   database_name = "auto-tower"
   database_id = "<database_id from step 2>"
   migrations_dir = "migrations"
   ```
4. **Add a D1 adapter.** The current `SqlDatabase` port is synchronous, which fits `node:sqlite` but not D1. Either make the port async or keep a sync port and add a separate async event-log path. Re-verify transaction semantics for the event log, since D1 has no `BEGIN IMMEDIATE`. Use `db.batch` or equivalent, and confirm the expected-version and idempotency guarantees still hold with a concurrency test.
5. **Wire the Worker.** Replace the 503 stub in `src/hosting/worker.ts` with `createApp` backed by the D1 adapter.
6. **Apply migrations.** `pnpm dlx wrangler d1 migrations apply auto-tower --remote`. Run the same command against a preview or staging database first. Confirm `schema_migrations` matches the local run.
7. **Bootstrap an owner token.** Issue it locally against a copy of the schema, or add a one-time bootstrap route. Store only the digest. Do not paste the raw token into logs or chat.
8. **Deploy.** `pnpm dlx wrangler deploy`, after explicit approval. Then check `GET /health` and one authenticated route.
9. **Supply the sweep.** The cron trigger is already declared in `wrangler.toml` (every minute) and `scheduled` in `src/hosting/worker.ts` runs `env.SWEEP`. Build the D1-backed app in the Worker, and pass `SWEEP: () => runSweep(db, fleet)` (`src/ops/sweep.ts`). Cron's finest grain is one minute, so lease recovery waits up to a minute on this host. Wrap the D1 database in `guardStorage` as the Node host does.
10. **Drill the restore.** `pnpm ops backup` and `restore` work on a SQLite file, not on D1. Test D1 Time Travel on a scratch database first: restore to a timestamp, then read a mission. Do the drill in `docs/backup-restore.md` against the restored copy.
11. **Roll back.** Use `wrangler rollback` for the Worker. For data, use D1 Time Travel to restore to a timestamp before the change, after the drill in step 10.

## Token administration beyond revocation

**Status:** Partly done. Revoking one token, and disabling a principal with every token it holds, work through `pnpm ops revoke-token` and `disable-principal` on the host, and are recorded in `ops_revocations` (`docs/policy-revocation.md`). Listing, rotation and an owner-only API route are not built.

**Adapter:** `src/auth/tokens.ts` (`revokeToken`, `issueToken`) behind a new owner-only route group in `src/api/routes/`.

**Fake:** none needed: the routes run over the same SQLite file as everything else.

**Activation steps:**

1. **Decide the surface.** A route that revokes tokens can be abused by a leaked owner token, which is why revocation is host-only today. Decide whether the convenience is worth that, and require `admin:tokens` and a human principal.
2. **List.** Add `GET /auth/tokens` returning ids, principal, scopes, created, expiry and revoked time, never a digest.
3. **Rotate.** Issue a replacement, show it once, and revoke the old one in the same transaction, recording both in `ops_revocations`.
4. **Test** that a runner or chief-of-staff token cannot reach any of it, and that revoking the caller's own last token is refused.

## Event log integrity

**Status:** Deferred. Triggers stop UPDATE and DELETE through the SQL interface only. A person with file access can still rewrite a row, and `pnpm ops backup` would then faithfully back up the rewrite. The digest in a backup proves the file was not edited after it was taken, not that the store was never edited.

**Adapter:** `src/events/event-log.ts`, with a `prev_hash` column added by a new migration.

**Fake:** the same SQLite file. Verification is a pure function over the rows, so no external service is involved.

**Activation steps:**

1. **Add the column** `events.prev_hash` and `events.hash`, where `hash = sha256(prev_hash, stream, version, type, payload, actor, recorded_at)`, in a new migration that backfills existing rows in `seq` order.
2. **Write it** in `append`, inside the same transaction.
3. **Verify it** in a `pnpm ops verify-store` command that walks the log and names the first broken link, and in `restore`, which already recomputes a digest.
4. **Anchor the head hash** somewhere an attacker with file access cannot edit (a person's notes, a signed commit), or the chain only shows tampering that did not also rewrite the chain.

## Superseded Phase 0 notes

- **Webhook endpoints.** Built in T6: see the GitHub entry below.
- **Domain tables.** Missions, decisions, policy grants, runners and issue links exist (migrations 0002 to 0009).

## Rate limits and backpressure

**Status:** Deferred. Tower fails closed on storage quota (`docs/operations.md`) and bounds every request body and list, but there is no per-credential rate limit. One runner credential can grow the progress and audit tables, as `docs/runner-protocol.md` says. `docs/threat-model.md` T-14 names this.

**Adapter:** a rate-limit middleware in `src/api/` keyed by principal id, with its counters in a small table or, on Workers, a Durable Object.

**Fake:** an in-memory counter with an injected clock, so tests need no timer and no network.

**Activation steps:**

1. **Choose the limits** per principal kind (runner polls, MCP calls, webhook deliveries) from observed use, not guesses.
2. **Add the middleware** after authentication, answering 429 with `Retry-After`. Runners already honor `retryAfterMs`.
3. **Signal it.** Raise a health signal when a principal is throttled repeatedly, with the principal id and the action: a throttled runner is usually a bug or a leak.
4. **Test** that a throttled principal cannot starve another, and that `/health` and webhooks with a valid signature are not throttled by an unauthenticated flood.

## Real Auto-Office engine on a subscription-backed machine

**Status:** Deferred. The adapter (`src/adapters/office/`) and the runner (`src/runner/`) are tested against a fake engine and a stubbed process runner. Nothing has run a real Auto-Office engine.

**Adapter:** `src/adapters/office/cli-engine.ts` (the real engine, over `office start`) behind `officeRunnerEngine` in `src/adapters/office/engine.ts`, run by `bin/tower-runner.ts`.

**Fake:** `FakeOfficeEngine` and `FakeWorld` in `test/adapters/office/fake-engine.ts`, which `pnpm smoke` uses, and a stubbed process runner for the CLI engine.

**Why it matters:** The contract is only proven when a real run returns a receipt that Tower can read. Three things are unverified: the `office start` argv, the receipt JSON, and the run's behaviour under a subscription account.

**Activation steps:**

1. **Get explicit approval.** A real run uses a subscription account and talks to a deployed Tower. Name the machine, the account, and the Tower origin before running anything.
2. **Close the receipt gap.** `office start --json` prints a run record today, not the `tower.office.v1` receipt that `parseOfficeReceipt` expects. Add an Office-side emitter, or a shim that reads the run and writes the receipt, then test it against a throwaway repository.
3. **Verify the argv.** Run `buildOfficeArgv` output by hand against that build. Confirm `--no-prs`, `--end-state ask` and `--blast-radius repo` do what they claim, and that the goal argument is taken as text.
4. **Install the runner.** On the machine, register with `tower-runner register` using a fresh enrollment token from a human. Pin the version and digest the enrollment expects. Keep the state file owner-only.
5. **Run one packet end to end.** Start `tower-runner run` against a preview Tower. Confirm the lease, progress, receipt, and ingestion. Check that a high-risk mission is not completed on the engine's self-report.
6. **Roll back.** Stop the runner, quarantine it from Tower, and release its leases with `POST /runners/leases/:id/release`.

## GitHub App and token provisioning, and public webhook delivery (T6)

**Status:** Deferred. The provider, the sync configuration, the guard and the webhook receiver are built and tested against a fake. Nothing has been registered with GitHub, no credential exists, and no public endpoint is exposed. This supersedes the earlier "Webhook endpoints" line above: the receiver now exists, and it stays off until a host opts in.

**Adapter:** `createGitHubProvider` in `src/issues/github.ts`, implementing `IssueProvider` (`src/issues/provider.ts`) with the `githubWebhookCodec` receiver.

**Fake:** `FakeProvider` in `test/issues/helpers.ts`, which `pnpm smoke` uses for a required issue's read-back and close.

**Why it matters:** Until these are done, `link-only` works and nothing reads or writes GitHub. `observe` and `bidirectional` need a credential, and webhooks need a public URL.

**Activation steps:**

1. **Get explicit approval.** Creating a GitHub App and exposing an endpoint are external actions. Confirm the account, the repositories and the host first.
2. **Create a GitHub App** owned by the organization. Give it the narrowest permissions: Issues read, and Issues write only if `bidirectional` is wanted. Subscribe it to Issues and Issue comment events. Set a webhook secret.
3. **Keep the credential on the host.** Mint installation tokens on the host and pass `token: () => ...` to `createGitHubProvider`. Tower stores no credential. Do not paste a key or token into logs or chat.
4. **Wire the host.** Build `createApp` with `issueProviders: { github: createGitHubProvider({ token }) }`. Create a `provider_adapter` principal for the workspace. Pass `webhooks: { resolve }` returning that principal's id and the webhook secret for each workspace.
5. **Choose the scope per repository.** A person sets `PUT /issues/sync-config` to `observe` first. Move a repository to `bidirectional` only with a matching `issue.close` grant (action `issue.close`, resource `github:<owner>/<repo>#*`, scope `repo:<owner>/<repo>`).
6. **Expose the endpoint** `POST /webhooks/github/<workspaceId>` behind HTTPS only after steps 2 to 5, and point the App's webhook URL at it. Check a `ping` answers `pong`.
7. **Schedule polling** (`POST /issues/poll` with the adapter's token) as the fallback for missed deliveries. The sweep in `src/ops/sweep.ts` ticks the scheduler and lease recovery, not this poll, and nothing in `src/hosting` runs it on a timer yet.
8. **Roll back** by setting the repository to `link-only` and removing the webhook from the App. Stored discrepancies and history remain.

## Identity provider, ChatGPT connector registration and MCP hosting (T7)

**Status:** Deferred. The MCP endpoint, the OAuth-compatible resource surface (`/.well-known/oauth-protected-resource`, `WWW-Authenticate` challenges, audience-bound provider tokens) and the `AuthProvider` port are built and tested against a fake provider. No identity provider exists, no client is registered anywhere, and nothing is publicly reachable. `src/hosting` does not yet read MCP settings from the environment, so a host built from `startHost` serves the endpoint with Tower tokens only.

**Adapter:** an `AuthProvider` implementation (`src/auth/oauth/provider.ts`) for the chosen identity provider, mounted through `createApp`'s `mcp` settings.

**Fake:** the fake provider in `test/auth/oauth/` and `createMcpEnv` in `test/mcp/setup.ts`, which issue audience-bound tokens with no tenant.

**Why it matters:** Tower is only the resource server. ChatGPT and other connector clients discover the authorization server from the metadata, so until a real provider sits behind `AuthProvider` they can only present Tower tokens, which a connector cannot obtain on its own.

**Activation steps:**

1. **Get explicit approval.** Creating an identity-provider tenant, registering a connector and exposing a public URL are external, possibly billable actions. Confirm the provider, the account and the public origin first.
2. **Choose and configure the provider.** It must issue access tokens whose audience is `<publicBaseUrl>/mcp` (RFC 8707), support PKCE and dynamic client registration or a pre-registered client, and publish its own authorization-server metadata. Record its issuer URL.
3. **Write the adapter.** Implement `AuthProvider` (`src/auth/oauth/provider.ts`): `authorizationServers` is the issuer list and `verifyAccessToken` checks signature, expiry and issuer against the provider's keys, then returns `{ issuer, subject, scopes, audience, expiresAt }`. Keep keys and client secrets on the host. Tower stores none. Test it against recorded tokens, not a live tenant.
4. **Wire the host.** Pass `mcp: { publicBaseUrl, authProvider, allowedOrigins, approvedAiProviders }` to `createApp`, and read `publicBaseUrl` from the environment in `src/hosting/host.ts`. The URL must be an https origin with no path.
5. **Link identities.** For each person or agent, a human runs `linkIdentity` for the provider's `(issuer, subject)`, naming the Tower principal and the scope ceiling. A valid provider token with no link authenticates nobody. There is no admin route for this yet.
6. **Register the ChatGPT connector.** Add `<publicBaseUrl>/mcp` as a custom MCP connector, let it discover the metadata and complete the provider's consent. Check `tools/list` shows only what the linked principal's scopes allow, then call `briefing`.
7. **Roll back.** Revoke the identity links (`revokeIdentity`), remove the connector, and unset `authProvider`. Tower tokens keep working. Sessions end with the token, and `mcp_audit` keeps the record of what was called.

## Cloud AI triage and hosted execution (T7)

**Status:** Deferred. The flags `cloud_ai.triage` and `hosted_execution` exist, default off, and fail closed. Nothing consumes them: no cloud AI call and no hosted runner exists.

**Adapter:** one adapter per provider listed in `approvedAiProviders`, called only after `isEnabled` (`src/mcp/flags.ts`) says yes at the point of effect. None exists.

**Fake:** a recording provider in the test that adds the adapter. The flag tests (`test/mcp/flags.test.ts`, `test/mcp/hardening.test.ts`) need none.

**Activation steps:**

1. **Get explicit approval** for the provider, the spend ceiling and the data that may leave Tower. A flag turning on is the last step, not the first.
2. **Add the provider to `approvedAiProviders`** at deploy time, behind its own adapter and a fake for tests.
3. **Create the delegated rule** (`grant_policy`, action `cloud_ai.triage.run` or `hosted_execution.run`, resource `provider:<id>`, with `maxAmount` as the spend cap), then turn the flag on with `set_feature_flag`, naming the provider, a budget in cents and the rule.
4. **Make the capability check `isEnabled`** at the point of effect, so revoking the rule stops it immediately. The flag counts only the rule it names, every change is in the append-only `feature_flag_history` (readable with `read_audit`), and an emergency halt blocks it. Spend tracking against the budget is not built: add it before a flag is turned on for real.
5. **Roll back** by turning the flag off or revoking the rule. Either stops the capability on the next check.

## A Tower-verifiable reviewer principal (T9)

**Status:** Deferred. The independent-review check compares the reviewer name the engine reports in its own receipt with the producers. Tower cannot confirm the reviewer is a separate session. Every runner that held the attempt counts as a producer, including ones it was reassigned from, but independence is still only as strong as the engine's report (`docs/adapters/office.md`, Residual risks).

**Adapter:** a `reviewer` principal kind, or a `provider_adapter` principal named for the review engine, posting its own signed verdict through a new route, ingested by `src/adapters/office/ledger.ts`.

**Fake:** a second `FakeOfficeEngine` (`test/adapters/office/fake-engine.ts`) enrolled as its own principal.

**Activation steps:**

1. **Get explicit approval.** This changes who may satisfy a completion guard.
2. **Define the principal** and its scope ceiling in `src/auth/principals.ts`. It must be unable to write missions or policy.
3. **Add the route** that takes a verdict bound to an attempt id, from that principal only, and stores it in `office_receipts` as the reviewer.
4. **Compare principal ids**, not names, and refuse a review whose principal held the attempt.
5. **Treat an engine-named reviewer as `missing`** for a high-risk mission once the route exists. Keep the old path off by default.
6. **Roll back** by disabling the reviewer principal (`pnpm ops disable-principal`). High-risk missions then wait for a person's review.

## HTTP routes for flag history and operational health (T9)

**Status:** Deferred, optional. Both are available over MCP (`read_audit` with `source: feature_flags`, and `read_health`) and on the host (`pnpm ops status`). There is no plain HTTP route for either, so a client that does not speak MCP cannot read them. `/health` stays liveness only on purpose.

**Adapter:** two routes in `src/api/routes/` (for example `GET /policy/flag-history` with `policy:read`, and `GET /ops/health` with `mission:read`), calling `createFlagServiceFor(...).history` and `healthReport` from `src/ops/`.

**Fake:** `createIssueApi`-style harnesses in `test/api/` and `createMcpEnv`, which already exercise both services.

**Activation steps:**

1. **Decide the audience.** Health names signals and halt reasons, so it needs a token and a read scope. It must never move onto the public `/health`.
2. **Add the routes** as read-only `RouteSpec`s with declared scopes, so `test/api/*` access tables list them.
3. **Test** that a token without the scope is refused, that a runner sees no rule ids, and that the output matches the MCP tools.
4. **Document** them in `docs/operations.md`, in the table of where to look.

## Auto-Office D1 sweep supply (T9)

**Status:** Deferred with the D1 adapter. The cron trigger is declared in `wrangler.toml` and `scheduled` in `src/hosting/worker.ts` runs `env.SWEEP`. Nothing supplies `SWEEP` yet, because there is no D1-backed store to sweep. See step 9 of the Cloudflare entry above.
