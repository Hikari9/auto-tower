#!/usr/bin/env node
// Auto Tower runner: connects outbound to Tower, claims authorized work, and runs it
// with a locally installed office engine under this machine's own subscription.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir, hostname, platform } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { AutoOfficeEngine, type Exec } from '../src/adapters/office/auto-office.ts';
import { FakeOfficeEngine } from '../src/adapters/office/fake.ts';
import { RunnerAgent, type LocalAttempt, type RunnerStateStore } from '../src/runner/agent.ts';
import { TowerClient } from '../src/runner/client.ts';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: process.env.TOWER_URL ?? 'http://127.0.0.1:8787' },
    name: { type: 'string', default: hostname() },
    engine: { type: 'string', default: 'auto-office' },
    repo: { type: 'string', multiple: true, default: [] },
    capability: { type: 'string', multiple: true, default: [] },
    scope: { type: 'string', multiple: true, default: [] },
    concurrency: { type: 'string', default: '1' },
    'poll-ms': { type: 'string', default: '15000' },
    once: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help) {
  console.log(`tower-runner --url URL [--name NAME] [--engine auto-office|fake] [--repo owner/name=/path/to/checkout ...]
             [--capability CAP ...] [--scope 'repo:owner/*' ...] [--concurrency 1] [--poll-ms 15000] [--once]
Token: TOWER_RUNNER_TOKEN env var (never pass tokens as arguments).`);
  process.exit(0);
}

const token = process.env.TOWER_RUNNER_TOKEN;
if (!token) {
  console.error('TOWER_RUNNER_TOKEN is not set');
  process.exit(2);
}

const stateDir = join(homedir(), '.auto-tower');
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const statePath = join(stateDir, `runner-${values.name!.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
const store: RunnerStateStore = {
  async load() {
    try {
      return JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, LocalAttempt>;
    } catch {
      return {};
    }
  },
  async save(s) {
    writeFileSync(statePath, JSON.stringify(s), { mode: 0o600 });
  },
};

const exec: Exec = (cmd, args, opts) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, detached: Boolean(opts.detached), stdio: opts.detached ? 'ignore' : ['ignore', 'pipe', 'pipe'] });
    if (opts.detached) {
      child.on('error', (e) => resolve({ code: 127, stdout: '', stderr: e.message }));
      child.on('spawn', () => {
        child.unref();
        resolve({ code: 0, stdout: '', stderr: '' });
      });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => (stdout += d));
    child.stderr?.on('data', (d) => (stderr += d));
    child.on('error', (e) => resolve({ code: 127, stdout, stderr: e.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

const repoRoots = Object.fromEntries((values.repo as string[]).map((r) => r.split('=') as [string, string]).map(([k, v]) => [k.toLowerCase(), v]));
const engine =
  values.engine === 'fake'
    ? new FakeOfficeEngine(() => ({ steps: 2 }))
    : new AutoOfficeEngine({ exec, readFile: (p) => readFile(p, 'utf8').catch(() => null), repoRoots });
if (engine instanceof AutoOfficeEngine) console.log(`Auto-Office ${await engine.version()}`);

const agent = new RunnerAgent({
  client: new TowerClient({ baseUrl: values.url!, token }),
  engine,
  store,
  registration: {
    name: values.name!,
    clientVersion: '0.1.0',
    platform: `${platform()}`,
    engines: ['auto-office'],
    capabilities: values.capability as string[],
    allowedScopes: values.scope as string[],
    maxConcurrency: Number(values.concurrency),
  },
  log: (m) => console.log(`[${new Date().toISOString()}] ${m}`),
});

let backoff = Number(values['poll-ms']);
for (;;) {
  try {
    await agent.tick();
    backoff = Number(values['poll-ms']);
  } catch (err) {
    // Network loss or Tower unavailable: keep local state and retry with capped backoff.
    console.error(`tick failed: ${err instanceof Error ? err.message : String(err)}`);
    backoff = Math.min(backoff * 2, 5 * 60_000);
  }
  if (values.once) break;
  await new Promise((r) => setTimeout(r, backoff));
}
