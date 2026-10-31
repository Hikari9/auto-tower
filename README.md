# auto-tower

Durable mission control for AI chiefs of staff and distributed Auto-Office execution fleets.

Auto Tower holds the record of what should happen, who may decide it, and what was verified. Execution happens elsewhere, through Auto-Office or other engines. Missions survive chats, laptops, sessions, and models.

Tower holds missions, policy, decisions, issue links and a runner fleet over one SQLite file, with an HTTP API, an MCP endpoint and a dashboard. It needs no Cloudflare account, no paid service, and no network access to run. Production hosting on Cloudflare is deferred (`DEFERRED.md`).

## Requirements

- Node 24 (see `.nvmrc`)
- pnpm 10 (see `packageManager` in `package.json`)

## Quick start

```sh
pnpm install --frozen-lockfile
pnpm tower token create --kind human      # prints an owner token once
pnpm dev                                  # serves http://127.0.0.1:8787
```

Then check the server:

```sh
curl -s http://127.0.0.1:8787/health      # {"status":"ok"}, no auth needed
```

Any other route needs `Authorization: Bearer <token>` with the scopes that route declares.

Options for `pnpm tower token create`:

| Flag                | Default                                                              |
| ------------------- | -------------------------------------------------------------------- |
| `--kind`            | required: `human`, `chief_of_staff`, `runner`, or `provider_adapter` |
| `--workspace`       | `$TOWER_WORKSPACE` or `default`                                      |
| `--scopes`          | every scope the kind allows                                          |
| `--expires-in-days` | no expiry                                                            |
| `--db`              | `$TOWER_DB_PATH` or `.tower/tower.sqlite`                            |

The server also reads `PORT` (default 8787) and `TOWER_DB_PATH`.

## Checks

```sh
pnpm check       # typecheck, Biome, and Vitest
pnpm smoke       # end to end in one process: MCP, two fake runners, the inbox, a fake GitHub, a backup restore
```

## Operating it

```sh
pnpm ops backup --out .tower/backups/tower.json   # canonical tables to one portable file
pnpm ops restore --from .tower/backups/tower.json --db .tower/restored.sqlite
pnpm ops halt --actor <human principal id>  # emergency halt: stop dispatch and guarded effects
pnpm ops status                             # health, signals, halt state
```

## Layout

- `src/storage`: storage port, SQLite adapter, migrations
- `src/events`: append-only event log
- `src/auth`: principals, tokens, middleware, owner CLI
- `src/core`, `src/policy`, `src/decisions`: missions, authority and the Decision Inbox
- `src/fleet`, `src/runner`, `src/adapters`: runners, leases and the Auto-Office adapter
- `src/issues`: issue links and provider sync
- `src/mcp`: the MCP endpoint and its tools
- `src/ops`: backup and restore, emergency halt, quota guard, sweep and health
- `src/api`: Hono app, routes, errors
- `src/hosting`: Node and Workers entry points
- `migrations`: ordered SQL
- `scripts`: `pnpm smoke` and `pnpm ops`
- `test`: Vitest suites, with `test/e2e` for the end-to-end scenario

## Docs

- `docs/manifesto.md`: principles
- `docs/glossary.md`: terms
- `docs/source-of-truth.md`: which system owns which state
- `docs/threat-model.md`: assets, threats, mitigations
- `docs/adapters.md`: contract ids and versioning
- `docs/architecture.md`: module map and request path
- `docs/install.md`: install and local first run
- `docs/operations.md`: monitoring, health signals, emergency halt, the sweep
- `docs/backup-restore.md`: backup, restore, migration forward and rollback
- `docs/policy-revocation.md`: incident runbook for revoking authority and credentials
- `docs/release-review.md`: checklist before a release
- `docs/mission-lifecycle.md`, `docs/authority.md`, `docs/runner-protocol.md`, `docs/issue-providers.md`, `docs/mcp.md`, `docs/dashboard.md`: how each part works
- `docs/adapters/office.md`: the Auto-Office adapter, with its residual risks
- `DEFERRED.md`: everything not done yet, each with its adapter, fake and activation steps
