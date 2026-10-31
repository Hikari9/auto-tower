# Operations

## Install and local first run

Requires Node 24+ and pnpm.

```sh
pnpm install
pnpm check                      # typecheck + contract tests
pnpm smoke                      # real binaries end to end on localhost

node bin/tower.ts init --db .tower/tower.db --workspace "My Tower" --owner "Rico"
# prints the owner token once; store it in a password manager
node bin/tower.ts serve --db .tower/tower.db --port 8787
# open http://127.0.0.1:8787 and paste the owner token
```

## Add a computer to the fleet

On the Tower host (or via `POST /api/v1/admin/tokens` with the owner token):

```sh
node bin/tower.ts token --db .tower/tower.db --kind runner --name macbook-pro
```

On the machine:

```sh
export TOWER_RUNNER_TOKEN=...            # never pass tokens as arguments
node bin/tower-runner.ts --url https://tower.example \
  --name macbook-pro \
  --repo hikari9/auto-tower=$HOME/Git/auto-tower \
  --concurrency 1
```

The runner connects outbound only. It keeps local state in `~/.auto-tower/runner-<name>.json` so a restart or sleep reconciles its attempts. Existing missions need no migration when a machine joins or leaves. Use `--engine fake` for a dry run that touches no repository and no model.

## Connect a Chief of Staff (ChatGPT / Rico Mode)

Issue a chief token (`--kind chief`) and point the MCP client at `https://<tower>/mcp` with `Authorization: Bearer <token>`. The owner can also connect with an owner token to grant/revoke and answer decisions from chat. Start each chat with `tower_briefing`. OAuth for ChatGPT connectors is deferred (D3).

## Monitoring

- Dashboard **Health** view, `GET /api/v1/health`, or `node bin/tower.ts health`. Signals: halt, work waiting for runners, expired leases, provider errors, sweep staleness, storage errors.
- `GET /healthz` is the unauthenticated liveness probe.
- **Activity** view / `GET /api/v1/activity` is the audit trail (actor, policy version, correlation id).
- Every response carries `x-correlation-id`; pass your own to trace a request through events.

## Policy revocation and emergency halt

- Revoke one rule: dashboard **Permissions → Revoke**, `POST /api/v1/policy/rules/:id/revoke`, or MCP `policy_revoke`. The next guarded effect sees it.
- Halt everything: `POST /api/v1/admin/halt {"halted": true, "reason": "..."}`. Claims, guarded effects and Tower-performed closes stop; reads continue. Resume with `halted: false`.
- Quarantine a machine: **Fleet → Quarantine**. Its attempts are fenced and requeued from their last portable checkpoint.
- Rotate or revoke a credential: `POST /api/v1/admin/principals/:id/rotate` or `/revoke`.

## Backup, restore, migrations

```sh
node bin/tower.ts backup --db .tower/tower.db --out backup-$(date +%F).json   # mode 0600; contains token hashes
node bin/tower.ts restore --db .tower/restored.db --in backup-2026-11-01.json  # target must be new and empty
```

Restore drill: restore into a scratch DB, `serve` it on another port, sign in with the same owner token and compare missions and the policy version (automated in `test/resilience.test.ts`). The API exposes `GET /api/v1/admin/backup` for the Worker deployment.

Migrations live in `migrations/` and run at start-up on Node (`schema_migrations`), or via `wrangler d1 migrations apply` on Cloudflare. Rollback strategy: take a backup before migrating; to roll back, restore that backup into a fresh database on the previous release. Migrations are additive within a major version.

Retention: events and evidence are kept indefinitely in v1 (small text rows). Webhook delivery ids and idempotency keys can be pruned after 30 days.

## Cloudflare deployment (not performed; needs owner approval)

1. Create a D1 database and put its id in `wrangler.toml`.
2. `wrangler d1 migrations apply auto-tower --remote`
3. `wrangler secret put TOWER_SETUP_TOKEN` (and `GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET` only if GitHub sync is enabled).
4. `wrangler deploy`
5. `POST /api/v1/setup` with header `x-setup-token` to create the workspace; store the owner token; delete `TOWER_SETUP_TOKEN`.
6. Optional GitHub: configure the integration in the dashboard, then add a webhook to each repo pointing at `https://<tower>/webhooks/github/<workspaceId>` with the same secret, events `Issues`.

Free-tier notes: the sweep runs every 5 minutes; runners poll every 15 seconds by default (raise `--poll-ms` for a large fleet); provider polling is bounded per sweep. Storage errors fail closed with `503` and a `retry-after` header.
