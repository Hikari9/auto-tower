import { describe, expect, it } from 'vitest';
import { OFFICE_REVIEW_GUARD } from '../../src/adapters/office/ledger.js';
import { createApp } from '../../src/api/app.js';
import { issueToken } from '../../src/auth/tokens.js';
import { createCore } from '../../src/core/index.js';
import {
  type IssueService,
  REQUIRED_ISSUES_GUARD,
} from '../../src/issues/index.js';
import { createHarness, MissionDriver, mission } from '../core/helpers.js';
import { openTestDatabase, seedPrincipal } from '../helpers/tower.js';
import {
  configure,
  createIssueApi,
  ISSUE_URL,
  missionWithLinks,
} from '../issues/helpers.js';
import { appRequester, key, McpClient } from './helpers.js';

const failures = (data: {
  error: { details?: { failures?: Array<{ guard: string }> } };
}) => (data.error.details?.failures ?? []).map((f) => f.guard);

describe('completion guards on every MCP path', () => {
  it('blocks completing a mission with an unclosed required link, then allows it once verified closed', async () => {
    const api = createIssueApi();
    const { h } = api;
    h.github.add(ISSUE_URL);
    configure(h);
    const driver = missionWithLinks(h);
    driver.verifyOutcome();
    const s = new McpClient((path, init) => api.raw(path, init), api.owner);
    await s.initialize();

    const close = (version: number) =>
      s.call('close_mission', {
        missionId: driver.id,
        expectedVersion: version,
        outcome: 'completed',
        idempotencyKey: key('close'),
        confirm: true,
      });

    const blocked = await close(driver.refresh().version);
    expect(blocked.isError).toBe(true);
    expect(blocked.data.error.code).toBe('completion_guard_failed');
    expect(failures(blocked.data)).toEqual([REQUIRED_ISSUES_GUARD]);
    expect(driver.refresh().state).toBe('verifying');

    // The issue is closed on the provider. Reconciliation reads it back, and only then may the mission complete.
    h.github.issue(ISSUE_URL).state = 'closed';
    const report = await s.ok('request_reconciliation', {
      missionId: driver.id,
      idempotencyKey: key('reconcile'),
    });
    expect(report.report.satisfied).toBe(true);
    const done = await close(driver.refresh().version);
    expect(done.isError).toBe(false);
    expect(done.data.mission.state).toBe('completed');
  });

  it('runs one reconciliation when a retry arrives while the first is still reading', async () => {
    const api = createIssueApi();
    const { h } = api;
    h.github.add(ISSUE_URL);
    configure(h);
    const driver = missionWithLinks(h);
    const s = new McpClient((path, init) => api.raw(path, init), api.owner);
    const args = {
      missionId: driver.id,
      idempotencyKey: key('concurrent'),
    };
    const reads = h.github.getCalls;
    const [a, b] = await Promise.all([
      s.call('request_reconciliation', args),
      s.call('request_reconciliation', args),
    ]);
    expect(a.isError).toBe(false);
    expect(b.isError).toBe(false);
    expect(h.github.getCalls - reads).toBe(1);
    expect(b.data).toEqual(a.data);
    expect(
      [a.meta, b.meta].filter((m) => m?.['tower/replayed'] === true),
    ).toHaveLength(1);
  });

  it('blocks a reopened issue as a discrepancy and never as completion', async () => {
    const api = createIssueApi();
    const { h } = api;
    h.github.add(ISSUE_URL, { state: 'open' });
    configure(h);
    const driver = missionWithLinks(h);
    driver.verifyOutcome();
    const s = new McpClient((path, init) => api.raw(path, init), api.owner);
    const report = await s.ok('request_reconciliation', {
      missionId: driver.id,
      idempotencyKey: key('reconcile'),
    });
    expect(report.report.satisfied).toBe(false);
    const links = (await s.ok('inspect_evidence', { missionId: driver.id }))
      .issueLinks;
    expect(links[0]).toMatchObject({
      countsAsRequired: true,
      verifiedClosed: false,
    });
  });
});

describe('createApp with an injected core', () => {
  it('registers the Auto-Office review guard and the required-issues guard on it', () => {
    const db = openTestDatabase();
    const core = createCore({ db });
    expect(core.guards.list().map((g) => g.name)).not.toContain(
      OFFICE_REVIEW_GUARD,
    );
    createApp({ db, core });
    const names = core.guards.list().map((g) => g.name);
    expect(names).toContain(OFFICE_REVIEW_GUARD);
    expect(names).toContain(REQUIRED_ISSUES_GUARD);
  });

  it('is idempotent by name: more apps over one core add no second copy and throw nothing', () => {
    const db = openTestDatabase();
    const core = createCore({ db });
    createApp({ db, core });
    createApp({ db, core });
    createApp({ db, core });
    const names = core.guards.list().map((g) => g.name);
    expect(names.filter((n) => n === OFFICE_REVIEW_GUARD)).toHaveLength(1);
    expect(names.filter((n) => n === REQUIRED_ISSUES_GUARD)).toHaveLength(1);
  });

  it('leaves a guard the host already registered alone', () => {
    const db = openTestDatabase();
    const core = createCore({ db });
    const own = {
      name: OFFICE_REVIEW_GUARD,
      check: () => ({ ok: true as const }),
    };
    core.guards.register(own);
    createApp({ db, core });
    expect(
      core.guards.list().filter((g) => g.name === OFFICE_REVIEW_GUARD),
    ).toEqual([own]);
  });

  it('makes a high-risk mission on an injected core refuse completion without independent review, over MCP', async () => {
    const h = createHarness();
    const app = createApp({ db: h.db, core: h.core, now: h.clock.now });
    const token = issueToken(h.db, { principalId: h.owner.id }).token;
    const driver = MissionDriver.create(h, mission({ risk: 'high' }));
    driver.toVerifying();
    driver.verifyOutcome();
    const s = new McpClient(appRequester(app), token);
    const reply = await s.call('close_mission', {
      missionId: driver.id,
      expectedVersion: driver.refresh().version,
      outcome: 'completed',
      idempotencyKey: key(),
      confirm: true,
    });
    expect(reply.data.error.code).toBe('completion_guard_failed');
    expect(failures(reply.data)).toContain(OFFICE_REVIEW_GUARD);
    expect(driver.refresh().state).toBe('verifying');
  });

  it('registers the required-issues guard even when the issue service came from elsewhere', () => {
    const db = openTestDatabase();
    const core = createCore({ db });
    createApp({ db, core, issues: {} as IssueService });
    expect(core.guards.list().map((g) => g.name)).toContain(
      REQUIRED_ISSUES_GUARD,
    );
  });

  it('does the same when the app builds its own core', async () => {
    const db = openTestDatabase();
    const owner = seedPrincipal(db, { kind: 'human' });
    const app = createApp({ db });
    const s = new McpClient(appRequester(app), owner.token);
    const created = await s.ok('create_mission', {
      title: 'Risky',
      intent: 'i',
      outcome: 'o',
      risk: 'high',
      idempotencyKey: key(),
    });
    // Reach `verifying` over MCP: transitions are not a tool, so go through the HTTP API.
    const http = (path: string, body: unknown) =>
      app.request(path, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${owner.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    const id = created.mission.id as string;
    await http(`/missions/${id}/transitions`, {
      expectedVersion: 1,
      to: 'ready',
    });
    await http(`/missions/${id}/transitions`, {
      expectedVersion: 2,
      to: 'verifying',
    });
    const verified = await http(`/missions/${id}/outcome-verification`, {
      expectedVersion: 3,
      evidenceRefs: ['ev:outcome'],
    });
    expect(verified.status).toBe(200);
    const reply = await s.call('close_mission', {
      missionId: id,
      expectedVersion: 4,
      outcome: 'completed',
      idempotencyKey: key(),
      confirm: true,
    });
    expect(reply.data.error.code).toBe('completion_guard_failed');
    expect(failures(reply.data)).toContain(OFFICE_REVIEW_GUARD);
  });
});
