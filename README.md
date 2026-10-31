# auto-tower

Durable mission control for AI chiefs of staff and distributed Auto-Office execution fleets.

Auto Tower holds the record of what should happen, who may decide it, and what was verified. Execution happens elsewhere, through Auto-Office or other engines. Missions survive chats, laptops, sessions, and models.

This repo is Phase 0: the control-plane skeleton, the append-only event log, and token authentication. It needs no Cloudflare account, no paid service, and no network access to run.

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
```

## Layout

- `src/storage`: storage port, SQLite adapter, migrations
- `src/events`: append-only event log
- `src/auth`: principals, tokens, middleware, owner CLI
- `src/api`: Hono app, routes, errors
- `src/hosting`: Node and Workers entry points
- `migrations`: ordered SQL
- `test`: Vitest suites

## Docs

- `docs/manifesto.md`: principles
- `docs/glossary.md`: terms
- `docs/source-of-truth.md`: which system owns which state
- `docs/threat-model.md`: assets, threats, mitigations
- `docs/adapters.md`: contract ids and versioning
- `docs/architecture.md`: module map and request path
- `DEFERRED.md`: deploy and D1 provisioning, with activation steps
