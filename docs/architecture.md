# Architecture

Auto Tower is a TypeScript service built on Hono. It runs on Node for local development and is designed to run on Cloudflare Workers with D1. Storage is behind a small port so the domain code does not depend on either.

## Module map

| Path              | Responsibility                                                                                                 | Depends on                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `src/storage/`    | `SqlDatabase` port, the SQLite adapter (`node:sqlite`), the migration runner, and migration file loading       | Nothing in Tower                  |
| `src/events/`     | Append-only event log with expected-version checks and idempotent replay                                       | `storage`                         |
| `src/auth/`       | Principals and scope ceilings, token issue and verification, Hono auth middleware, and the owner bootstrap CLI | `storage`, `shared`, `api/errors` |
| `src/api/`        | Hono app factory, route declarations with required access, and error mapping                                   | `auth`, `events`, `storage`       |
| `src/api/routes/` | One module per route group. Each exports `RouteSpec` values.                                                   | `api/app` (types only)            |
| `src/hosting/`    | Entry points: `node.ts` for `pnpm dev` and `worker.ts` for Workers                                             | `api`, `storage`                  |
| `src/shared/`     | Small helpers with no domain meaning, such as ID generation                                                    | Nothing                           |
| `migrations/`     | Ordered SQL files, plain enough to run on SQLite and D1                                                        | Nothing                           |

Rules this layout enforces:

- `storage` never imports from `auth`, `events`, or `api`.
- `events` never imports from `auth` or `api`. The actor is a principal id string.
- Hosting code wires dependencies. Domain modules never read environment variables.

## Request path

1. `createApp` registers each `RouteSpec` from `src/api/app.ts`.
2. A route with `access: { public: true }` runs its handler directly. Only `/health` does this.
3. Any other route runs `authenticate`, which resolves the bearer token to a principal and its scopes, then `requireScopes`, which checks every declared scope.
4. Handlers return JSON. Errors are mapped by `handleError` in `src/api/errors.ts`:
   - 401 for missing or unusable credentials
   - 403 for missing scopes
   - 409 for version conflicts and idempotency key reuse
   - 500 with a generic body for anything else

## Data model (v1 base)

Defined in `migrations/0001_initial.sql`.

- `workspaces`: tenant boundary
- `principals`: actors, each with one kind
- `api_tokens`: token digests, scopes, expiry, revocation
- `events`: append-only log keyed by `(workspace_id, stream_id, version)` with a global `seq`
- `idempotency_keys`: per-principal replay records pointing at an event `seq`
- `schema_migrations`: applied migrations with a checksum each

Every tenant-owned table has `workspace_id`. Append-only tables have triggers that reject UPDATE and DELETE.

## Concurrency

- Each write runs in `BEGIN IMMEDIATE`, so writers serialize on the database lock.
- An append reads the stream's current version inside its transaction and compares it with `expectedVersion`. A mismatch throws `VersionConflictError`.
- The `UNIQUE (workspace_id, stream_id, version)` constraint backs up that check.
- Idempotent replays happen inside the same transaction, so a retry cannot race a first attempt.

## Dev and test

- `pnpm dev` starts the Node host on `127.0.0.1:8787` with a SQLite file at `.tower/tower.sqlite` (override with `TOWER_DB_PATH`). Migrations run at start.
- `pnpm tower token create --kind human` bootstraps an owner token into the same database.
- Tests use in-memory databases or temporary files. Nothing touches the network.
- `pnpm check` runs typecheck, Biome, and Vitest.
