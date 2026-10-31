#!/usr/bin/env node
// Minimal end-to-end smoke test of the real binaries:
// tower init -> tower token -> tower serve -> HTTP API + MCP -> tower-runner (fake engine)
// -> mission completes -> backup -> restore into a new database.
// Uses only localhost and a temp directory. No external services, no models.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dir = mkdtempSync(join(tmpdir(), 'tower-smoke-'));
const db = join(dir, 'tower.db');
const port = 18000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, TOWER_DB: db };
const run = (bin: string, args: string[], extra: Record<string, string> = {}) => execFileSync('node', [join(root, 'bin', bin), ...args], { env: { ...env, ...extra }, encoding: 'utf8' });
const lastLine = (s: string) => s.trim().split('\n').at(-1)!;
const results: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail = '') => results.push([name, ok, detail]);

const owner = lastLine(run('tower.ts', ['init', '--workspace', 'Smoke', '--owner', 'Owner']));
const runnerToken = lastLine(run('tower.ts', ['token', '--kind', 'runner', '--name', 'smoke-laptop']));
const server = spawn('node', [join(root, 'bin', 'tower.ts'), 'serve', '--port', String(port), '--sweep-ms', '2000'], { env, stdio: 'ignore' });

async function call(method: string, path: string, body?: unknown, token: string | null = owner) {
  const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

try {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  check('healthz', (await call('GET', '/healthz', undefined, null)).status === 200);
  check('unauthenticated API is denied', (await call('GET', '/api/v1/missions', undefined, null)).status === 401);
  const created = await call('POST', '/api/v1/missions', {
    title: 'Smoke mission',
    outcome: 'The fake engine completes it',
    risk: 'low',
    authority: { actions: ['repo.push'], resources: ['repo:acme/app'] },
    packets: [{ title: 'Do it', goal: 'Do it', scope: { repo: 'acme/app' } }],
    start: true,
  });
  const id = created.body.id as string;
  check('mission waits for a runner', created.body.activity === 'waiting_runner', created.body.activity);
  run('tower-runner.ts', ['--url', base, '--name', 'smoke-laptop', '--engine', 'fake', '--ticks', '5', '--poll-ms', '50'], { TOWER_RUNNER_TOKEN: runnerToken, HOME: dir });
  const detail = (await call('GET', `/api/v1/missions/${id}`)).body;
  check('runner completed the mission', detail.mission.state === 'completed', `${detail.mission.state}/${detail.mission.activity}`);
  check('evidence recorded', detail.evidence.length > 0, `${detail.evidence.length} items`);
  const tools = await call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  check('MCP lists tools', tools.body.result.tools.length > 10, `${tools.body.result.tools.length} tools`);
  const brief = await call('POST', '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tower_briefing', arguments: {} } });
  check('MCP briefing works', Array.isArray(brief.body.result.structuredContent.result.missions));
  const page = await fetch(`${base}/`);
  check('dashboard is served with CSP', page.ok && (page.headers.get('content-security-policy') ?? '').includes("script-src 'self'"));
  const backupPath = join(dir, 'backup.json');
  run('tower.ts', ['backup', '--out', backupPath]);
  const restored = JSON.parse(run('tower.ts', ['restore', '--in', backupPath], { TOWER_DB: join(dir, 'restored.db') }));
  check('backup restores into a new database', restored.missions === 1 && restored.events > 0, `missions=${restored.missions} events=${restored.events}`);
} finally {
  server.kill();
  rmSync(dir, { recursive: true, force: true });
}

for (const [name, ok, detail] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
const failed = results.filter((r) => !r[1]).length;
console.log(failed ? `${failed} smoke checks failed` : `all ${results.length} smoke checks passed`);
process.exit(failed ? 1 : 0);
