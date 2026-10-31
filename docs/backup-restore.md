# Backup, restore and schema migration

Tower's state is one SQLite file. The backup tool turns the canonical tables into one portable JSON file and restores it into a fresh database. A drill test proves missions, policy versions and audit history come back identical, after a restart and after a restore.

## What is in a backup

Every table that carries state a person or an auditor would want back:

- **Missions:** events (the source of truth), the projection, packets, dependencies, attempts.
- **Policy:** rules, preferences, proposals, receipts and the version counter. Every policy version is in the events and receipts.
- **Decisions:** the inbox, links to blocked branches, and every answer.
- **Issues:** sync configuration, links and their history, discrepancies, outbound operations, webhook deliveries.
- **Runners:** enrollments, runners, leases, progress, checkpoints, receipts, Office receipts, and the fleet audit.
- **Audit:** MCP audit, flag history, halt history, revocation history.
- **Principals and workspaces.**

## What is left out, and why

| Left out                                          | Why                                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------------------ |
| MCP sessions, replay results, claim backoff       | Short-lived by design. Clients open new sessions, and a retry runs again safely.     |
| `schema_migrations`                               | Recorded in the file's header, with each migration's checksum.                       |
| API token digests, unless `--include-token-digests` | A backup that holds digests is as sensitive as the database. The default cannot sign anyone in. |

After a restore without token digests, issue new tokens (`pnpm tower token create --db <restored>`) and enroll runners again. Runners re-register with a fresh enrollment, and their old leases recover or are released as `docs/runner-protocol.md` describes.

## Take a backup

```sh
pnpm ops backup --out backups/tower-$(date +%Y%m%dT%H%M%S).json
```

It reads the whole database in one transaction, so the file is one consistent moment, and writers wait only for the read. The file is mode 0600 and the command refuses to overwrite one. It works while the server runs. Copy the file off the machine: a backup on the disk that failed is not a backup. Store it as carefully as the database.

Check any backup, at any time, without touching a database:

```sh
pnpm ops verify --from backups/tower-20261031T120000.json
```

`verify` recomputes the digest over every table, so an edited or damaged file is refused.

## Restore

Restore into a database that does not exist yet. The tool refuses an existing path.

```sh
pnpm ops restore --from backups/tower-20261031T120000.json --db .tower/restored.sqlite
```

In order, it:

1. Checks the file's shape and digest.
2. Refuses the file if its migration history is not a prefix of this build's, with the same checksums (a backup from a newer build, or from a different schema history, is refused with the reason).
3. Replays exactly the backup's migrations into the new database.
4. Loads every row, then checks all foreign keys and recomputes the digest from the loaded rows. If the loaded rows differ from the file, the restore fails.
5. Migrates forward to this build's schema.

Then point the server at the restored file (`TOWER_DB_PATH=.tower/restored.sqlite pnpm dev`) once you have issued tokens. Keep the old file until you have checked the new one.

The append-only guarantees (events, receipts, history tables) are triggers in the schema, so they hold in the restored database as in the original.

### Proving it

`pnpm ops verify` proves the file is intact. To prove a restore matches its source, compare fingerprints: `test/ops/backup.test.ts` does it with `storeFingerprint`, a digest over every canonical table in a fixed order. `pnpm smoke` does the same on every run, then restarts the server on the restored file and reads the mission back.

## Schema migration

Migrations are ordered SQL files in `migrations/`. They run forward only, each in its own transaction, at server start and at restore.

- **Forward:** adding a migration is the only change to the schema. `test/ops/backup.test.ts` restores a backup made before the newest migration, migrates it forward, and checks the data and the new tables.
- **Never edit an applied migration.** The runner records each one's checksum and refuses to start if it changed. A fix is a new migration.
- **Before migrating a real database,** take a backup (`pnpm ops backup`). A migration is applied in a transaction and rolls back as a whole if it fails, but only a backup returns you to the state before a migration that succeeded and turned out wrong.

### Rollback procedure

SQLite migrations here do not carry down-scripts, so rollback is a restore, and it is always safe:

1. **Stop** the new build. Optionally `pnpm ops halt` first so nothing starts in between.
2. **Pick the backup** taken before the migration. `pnpm ops verify` it.
3. **Restore** it into a new path with the **previous build** checked out: `pnpm ops restore --from <file> --db <new path>`. The restore uses that build's own migrations, so the old schema comes back exactly.
4. **Point the old build** at the restored file and start it. Check `pnpm ops status` and read a mission.
5. **Re-apply what happened since.** Anything written between the backup and the stop is in the failed database, which you kept. It is not merged automatically: decide what to re-enter. Events are append-only and keyed by stream, so nothing is half applied in the restored file.
6. **Keep the failed database and the new migration** until the cause is understood.

For the D1 host, the rollback is the Worker rollback plus D1 Time Travel, and it has not been exercised: see `DEFERRED.md`.

## Drill

Run this on a schedule, not only after an incident:

1. `pnpm ops backup --out <file>`, then `pnpm ops verify --from <file>`.
2. `pnpm ops restore --from <file> --db <scratch path>`.
3. Start a second server on the scratch file (`PORT=8788 TOWER_DB_PATH=<scratch path> pnpm dev`) and read a mission through MCP or the dashboard.
4. Delete the scratch database and, once the file is copied off the machine, the backup.

`pnpm check` runs the same drill against a populated database on every change.
