# Deferred Work

Items here are real, planned, and intentionally not done in Phase 0. Each has an activation path. None is started without an explicit go-ahead.

## Cloudflare deploy and D1 provisioning

**Status:** Deferred. Issue #1 authorizes no deployment, DNS change, or paid resource on its own.

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
9. **Roll back.** Use `wrangler rollback` for the Worker. For data, use D1 Time Travel to restore to a timestamp before the change. Test the restore path first (Phase 5 recovery drill).

## Other Phase 0 deferrals

- **Token administration.** Listing, rotation, and revocation are not exposed yet. Revocation needs direct database access. Add a `tower token revoke` command and an owner-only API route.
- **Event log integrity.** Triggers stop UPDATE and DELETE through the SQL interface only. Hash-chaining events is deferred.
- **Webhook endpoints.** No webhook receiver exists. It arrives with the GitHub provider (T6), with signature verification and replay protection.
- **Domain tables.** Missions, decisions, policy grants, runners, and issue links arrive in T2 through T7.

## Real Auto-Office engine on a subscription-backed machine

**Status:** Deferred. The adapter (`src/adapters/office/`) and the runner (`src/runner/`) are tested against a fake engine and a stubbed process runner. Nothing has run a real Auto-Office engine.

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

**Why it matters:** Until these are done, `link-only` works and nothing reads or writes GitHub. `observe` and `bidirectional` need a credential, and webhooks need a public URL.

**Activation steps:**

1. **Get explicit approval.** Creating a GitHub App and exposing an endpoint are external actions. Confirm the account, the repositories and the host first.
2. **Create a GitHub App** owned by the organization. Give it the narrowest permissions: Issues read, and Issues write only if `bidirectional` is wanted. Subscribe it to Issues and Issue comment events. Set a webhook secret.
3. **Keep the credential on the host.** Mint installation tokens on the host and pass `token: () => ...` to `createGitHubProvider`. Tower stores no credential. Do not paste a key or token into logs or chat.
4. **Wire the host.** Build `createApp` with `issueProviders: { github: createGitHubProvider({ token }) }`. Create a `provider_adapter` principal for the workspace. Pass `webhooks: { resolve }` returning that principal's id and the webhook secret for each workspace.
5. **Choose the scope per repository.** A person sets `PUT /issues/sync-config` to `observe` first. Move a repository to `bidirectional` only with a matching `issue.close` grant (action `issue.close`, resource `github:<owner>/<repo>#*`, scope `repo:<owner>/<repo>`).
6. **Expose the endpoint** `POST /webhooks/github/<workspaceId>` behind HTTPS only after steps 2 to 5, and point the App's webhook URL at it. Check a `ping` answers `pong`.
7. **Schedule polling** (`POST /issues/poll` with the adapter's token) as the fallback for missed deliveries. Nothing in `src/hosting` runs it on a timer yet.
8. **Roll back** by setting the repository to `link-only` and removing the webhook from the App. Stored discrepancies and history remain.

## Identity provider, ChatGPT connector registration and MCP hosting (T7)

**Status:** Deferred. The MCP endpoint, the OAuth-compatible resource surface (`/.well-known/oauth-protected-resource`, `WWW-Authenticate` challenges, audience-bound provider tokens) and the `AuthProvider` port are built and tested against a fake provider. No identity provider exists, no client is registered anywhere, and nothing is publicly reachable. `src/hosting` does not yet read MCP settings from the environment, so a host built from `startHost` serves the endpoint with Tower tokens only.

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

**Activation steps:**

1. **Get explicit approval** for the provider, the spend ceiling and the data that may leave Tower. A flag turning on is the last step, not the first.
2. **Add the provider to `approvedAiProviders`** at deploy time, behind its own adapter and a fake for tests.
3. **Create the delegated rule** (`grant_policy`, action `cloud_ai.triage.run` or `hosted_execution.run`, resource `provider:<id>`, with `maxAmount` as the spend cap), then turn the flag on with `set_feature_flag`, naming the provider, a budget in cents and the rule.
4. **Make the capability check `isEnabled`** at the point of effect, so revoking the rule stops it immediately. Spend tracking against the budget is not built.
5. **Roll back** by turning the flag off or revoking the rule. Either stops the capability on the next check.
