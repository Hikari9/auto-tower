# Install and first run

How to get Tower running on one machine, with no cloud account, no paid service and no network access beyond the package install. The Cloudflare and D1 production host is not part of this page: see `DEFERRED.md`.

## Requirements

- Node 24 (`.nvmrc`). `node:sqlite` ships with it, so there is no native module to build.
- pnpm 10 (`packageManager` in `package.json`). Use pnpm, not npm or yarn, so the lockfile is honored.

## Install

```sh
pnpm install --frozen-lockfile
pnpm check        # typecheck, Biome and the full test suite
pnpm smoke        # the whole control plane end to end, in one process (below)
```

`pnpm smoke` is the quickest proof that an install works. It starts the server in-process, creates a mission over MCP, runs two fake runners, takes a decision through the inbox, reconciles a required issue on a fake GitHub, completes the mission, restores from a backup into a fresh database and reads everything back. It uses no network and no paid service, and it removes its temporary files.

## Local first run

1. **Start the server.** It binds to `127.0.0.1` only, so it is not reachable from other machines.

   ```sh
   pnpm dev                     # http://127.0.0.1:8787, database .tower/tower.sqlite
   ```

   `PORT` and `TOWER_DB_PATH` change the port and the file. The database directory is created owner-only (mode 0700) and the files 0600. Tower refuses a directory other users can write, such as `/tmp`.

2. **Create the first person.** In another shell, against the same database:

   ```sh
   pnpm tower token create --kind human --name you
   ```

   It prints a token once. Only a digest is stored, so a lost token is replaced, not recovered. Keep it out of shell history and chat. The command also prints the principal id: note it, because `pnpm ops` names a person by that id.

   Create a second person too (`--name backup`). Tower refuses to disable the last enabled person, and a second one means you are never locked out during an incident.

3. **Check it.**

   ```sh
   curl -s http://127.0.0.1:8787/health          # {"status":"ok"}, no auth needed
   curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/missions
   ```

   `/health` is liveness only, and deliberately says nothing about the workspace. Operational health is `read_health` over MCP and `pnpm ops status`, both authenticated or local (see `docs/operations.md`).

4. **Create a mission** over HTTP (`POST /missions`, see `docs/mission-lifecycle.md`) or over MCP at `POST /mcp` (see `docs/mcp.md`). A mission with authorized work and no runner stays `waiting-runner`. That is correct, not stuck.

5. **Add a runner** when you want work to run. A person issues an enrollment (`POST /runners/enrollments`), and the runner registers with it. `docs/runner-protocol.md` has the steps and `docs/adapters/office.md` the Auto-Office engine. No real engine has run yet: that activation is in `DEFERRED.md`.

6. **Open the dashboard** at `http://127.0.0.1:8787/dashboard` and paste the token. See `docs/dashboard.md`.

## What runs on its own

- **Migrations** run at start. A migration that changed after it was applied stops the start with an error: add a new migration, never edit an applied one.
- **A scheduled sweep** ticks every workspace on an interval (default 15 seconds, `TOWER_SWEEP_INTERVAL_MS`, `0` turns it off). It expires and recovers leases and dispatches ready work, so a mission never waits for a runner to poll. A failing sweep is a health signal, not a log line.

## Configuration

| Variable                  | Default               | Meaning                                    |
| ------------------------- | --------------------- | ------------------------------------------ |
| `PORT`                    | `8787`                | Loopback port.                             |
| `TOWER_DB_PATH`           | `.tower/tower.sqlite` | SQLite file.                               |
| `TOWER_WORKSPACE`         | `default`             | Workspace for `pnpm tower` and `pnpm ops`. |
| `TOWER_SWEEP_INTERVAL_MS` | `15000`               | Sweep interval. `0` disables it.           |

Secrets never go in the database or in these variables' defaults. A webhook secret, a GitHub credential and an identity-provider key live in host configuration, as `DEFERRED.md` describes.

## Next

- `docs/operations.md` for monitoring, the emergency halt and what each health signal means.
- `docs/backup-restore.md` before there is anything you cannot recreate.
- `docs/policy-revocation.md` to know the incident steps before you need them.
