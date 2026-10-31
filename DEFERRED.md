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
