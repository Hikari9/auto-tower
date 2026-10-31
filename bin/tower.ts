#!/usr/bin/env node
// Auto Tower operator CLI for local/self-hosted use. Usage: tower <command> [--flags]
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { GitHubProvider } from '../src/adapters/issues/github.ts';
import { IssueProviderRegistry } from '../src/adapters/issues/registry.ts';
import { startServer } from '../src/node/server.ts';
import { exportBackup, restoreBackup, type Backup } from '../src/service/admin.ts';
import { Tower } from '../src/service/tower.ts';
import { migrate } from '../src/store/sql.ts';
import { loadMigrations, NodeSqliteDriver } from '../src/store/sqlite-node.ts';

const HELP = `Auto Tower CLI

  tower init     --db tower.db [--workspace NAME] [--owner NAME]   Create the workspace and print the owner token once
  tower serve    --db tower.db [--port 8787] [--host 127.0.0.1] [--sweep-ms 30000]
  tower token    --db tower.db --kind runner|chief|human --name NAME   Issue a credential (printed once)
  tower sweep    --db tower.db                                     Run one scheduler sweep
  tower migrate  --db tower.db
  tower backup   --db tower.db --out backup.json
  tower restore  --db new.db --in backup.json                      Restore into a new, empty database
  tower health   --db tower.db
`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    db: { type: 'string', default: process.env.TOWER_DB ?? '.tower/tower.db' },
    workspace: { type: 'string', default: 'My Tower' },
    owner: { type: 'string', default: 'Owner' },
    port: { type: 'string', default: process.env.PORT ?? '8787' },
    host: { type: 'string', default: '127.0.0.1' },
    'sweep-ms': { type: 'string', default: '30000' },
    kind: { type: 'string' },
    name: { type: 'string' },
    out: { type: 'string' },
    in: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

async function open() {
  const path = resolve(values.db!);
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(path, '..'), { recursive: true });
  const db = new NodeSqliteDriver(path);
  await migrate(db, loadMigrations());
  const tower = new Tower({ db, providers: new IssueProviderRegistry([new GitHubProvider()], (n) => process.env[n]) });
  return { db, tower };
}

async function ownerActor(tower: Tower) {
  const row = await tower.db.first<{ id: string; workspace_id: string; name: string; scopes_json: string }>(
    "SELECT id, workspace_id, name, scopes_json FROM principals WHERE kind = 'human' AND status = 'active' ORDER BY created_at LIMIT 1",
  );
  if (!row) throw new Error('not initialized: run `tower init` first');
  return { principal: { id: row.id, workspaceId: row.workspace_id, kind: 'human' as const, name: row.name, scopes: JSON.parse(row.scopes_json), status: 'active' as const }, correlationId: 'cli' };
}

const cmd = positionals[0];
if (!cmd || values.help) {
  console.log(HELP);
  process.exit(0);
}

const { db, tower } = await open();
switch (cmd) {
  case 'migrate':
    console.log('schema is up to date');
    break;
  case 'init': {
    const r = await tower.admin.bootstrap({ workspaceName: values.workspace!, ownerName: values.owner! });
    console.log(JSON.stringify({ workspaceId: r.workspaceId, ownerId: r.ownerId }, null, 2));
    console.log(`\nOwner token (shown once, store it in your password manager):\n${r.ownerToken}`);
    break;
  }
  case 'token': {
    if (!values.kind || !values.name) throw new Error('--kind and --name are required');
    const r = await tower.admin.issueToken(await ownerActor(tower), { kind: values.kind as 'runner', name: values.name });
    console.log(JSON.stringify({ principalId: r.principalId, scopes: r.scopes }, null, 2));
    console.log(`\nToken (shown once):\n${r.token}`);
    break;
  }
  case 'serve': {
    const publicDir = resolve(import.meta.dirname, '..', 'public');
    startServer(tower, { port: Number(values.port), host: values.host!, publicDir, sweepMs: Number(values['sweep-ms']) });
    console.log(`Auto Tower listening on http://${values.host}:${values.port} (db ${resolve(values.db!)})`);
    break;
  }
  case 'sweep':
    console.log(JSON.stringify(await tower.scheduler.sweep(), null, 2));
    break;
  case 'health':
    console.log(JSON.stringify(await tower.admin.health(await ownerActor(tower)), null, 2));
    break;
  case 'backup': {
    if (!values.out) throw new Error('--out is required');
    writeFileSync(values.out, JSON.stringify(await exportBackup(db, tower.now())), { mode: 0o600 });
    console.log(`backup written to ${values.out} (contains token hashes; keep it private)`);
    break;
  }
  case 'restore': {
    if (!values.in) throw new Error('--in is required');
    const counts = await restoreBackup(db, JSON.parse(readFileSync(values.in, 'utf8')) as Backup);
    console.log(JSON.stringify(counts, null, 2));
    break;
  }
  default:
    console.log(HELP);
    process.exit(2);
}
