import { describe, expect, it } from 'vitest';
import { IssueForbiddenError } from '../../src/issues/errors.js';
import type { WebhookObservation } from '../../src/issues/index.js';
import {
  completeMission,
  configure,
  createIssueHarness,
  grantClose,
  ISSUE_URL,
  type IssueHarness,
  missionWithLinks,
} from './helpers.js';

const reopened: WebhookObservation = {
  kind: 'issue',
  action: 'reopened',
  repo: 'acme/web',
  number: 1,
  nodeId: 'node_acme/web_1',
  state: 'open',
  title: 'Fix the thing',
  identityLost: false,
};

const closedEvent: WebhookObservation = {
  ...reopened,
  action: 'closed',
  state: 'closed',
};

const deliver = (
  h: IssueHarness,
  observation: WebhookObservation,
  deliveryId: string,
  payloadHash?: string,
) =>
  h.issues.handleWebhook({
    workspaceId: 'ws_test',
    actor: h.provider,
    provider: 'github',
    deliveryId,
    event: 'issues',
    observation,
    payloadHash,
  });

async function completed() {
  const h = createIssueHarness();
  configure(h);
  grantClose(h);
  h.github.add(ISSUE_URL);
  const driver = missionWithLinks(h);
  await h.issues.closeRequired(h.ctx(h.cos), driver.id);
  completeMission(driver);
  return { h, driver };
}

describe('a signed body replayed under a new delivery id', () => {
  it('has no second effect: one discrepancy, one history entry, one delivery row', async () => {
    const { h, driver } = await completed();
    const page = { afterSeq: 0, limit: 100 };
    const first = deliver(h, reopened, 'del-1', 'hash-of-body');
    const afterFirst = h.issues.history('ws_test', driver.id, page).length;
    const replays = [
      deliver(h, reopened, 'del-2', 'hash-of-body'),
      deliver(h, reopened, 'del-3', 'hash-of-body'),
      deliver(h, reopened, 'del-1', 'hash-of-body'),
    ];
    expect(first.status).toBe('processed');
    expect(replays.map((r) => r.status)).toEqual([
      'duplicate',
      'duplicate',
      'duplicate',
    ]);
    expect(h.issues.discrepancies('ws_test', driver.id, 'all')).toHaveLength(1);
    expect(h.issues.history('ws_test', driver.id, page)).toHaveLength(
      afterFirst,
    );
    expect(h.db.all('SELECT delivery_id FROM webhook_deliveries')).toHaveLength(
      1,
    );
  });

  it('still processes a different body under a new delivery id', async () => {
    const { h, driver } = await completed();
    expect(deliver(h, reopened, 'del-1', 'hash-a').status).toBe('processed');
    expect(deliver(h, closedEvent, 'del-2', 'hash-b').status).toBe('processed');
    expect(h.db.all('SELECT delivery_id FROM webhook_deliveries')).toHaveLength(
      2,
    );
    expect(driver.refresh().state).toBe('needs-attention');
  });

  it('keys on the provider and workspace as well: the same hash from another provider is its own delivery', async () => {
    const { h } = await completed();
    deliver(h, reopened, 'del-1', 'shared-hash');
    const other = h.issues.handleWebhook({
      workspaceId: 'ws_test',
      actor: h.provider,
      provider: 'gitlab',
      deliveryId: 'del-9',
      event: 'issues',
      observation: reopened,
      payloadHash: 'shared-hash',
    });
    expect(other.status).not.toBe('duplicate');
    // It is its own delivery: recorded under its own provider with the same hash.
    expect(
      h.db.all<{ provider: string }>(
        'SELECT provider FROM webhook_deliveries ORDER BY provider',
      ),
    ).toEqual([{ provider: 'github' }, { provider: 'gitlab' }]);
  });

  it('records the hash beside the delivery id so it survives a restart', async () => {
    const { h } = await completed();
    deliver(h, reopened, 'del-1', 'persisted-hash');
    expect(
      h.db.get<{ payload_hash: string }>(
        'SELECT payload_hash FROM webhook_deliveries',
      ),
    ).toEqual({ payload_hash: 'persisted-hash' });
  });

  it('is refused by the database itself if two rows ever carry one hash', async () => {
    const { h } = await completed();
    deliver(h, reopened, 'del-1', 'dup-hash');
    expect(() =>
      h.db.run(
        `INSERT INTO webhook_deliveries (workspace_id, provider, delivery_id, event, outcome, received_at, payload_hash)
         VALUES ('ws_test', 'github', 'del-2', 'issues', 'processed', 'z', 'dup-hash')`,
      ),
    ).toThrow(/UNIQUE/);
  });
});

describe('a human-only override when the provider cannot say whether issues block a close', () => {
  function unknownBlockers() {
    const h = createIssueHarness();
    configure(h);
    grantClose(h);
    grantClose(h, { grantee: { kind: 'human', principalId: null } });
    h.github.add(ISSUE_URL, { blockers: null });
    const driver = missionWithLinks(h);
    driver.verifyOutcome();
    return { h, driver };
  }

  it('is blocked without it, as before', async () => {
    const { h, driver } = unknownBlockers();
    const report = await h.issues.closeRequired(h.ctx(h.owner), driver.id);
    expect(report.results[0]).toMatchObject({
      status: 'blocked',
      detail: 'blockers_unknown',
    });
    expect(h.github.closeCalls).toBe(0);
  });

  it('lets a person proceed, and records who overrode it on the link', async () => {
    const { h, driver } = unknownBlockers();
    const report = await h.issues.closeRequired(
      h.ctx(h.owner),
      driver.id,
      undefined,
      {
        overrideUnknownBlockers: true,
      },
    );
    expect(report.results[0]?.status).toBe('closed');
    expect(h.github.closeCalls).toBe(1);
    const history = h.issues.history('ws_test', driver.id, {
      afterSeq: 0,
      limit: 50,
    });
    const entry = history.find((e) => e.type === 'blockers_unknown_override');
    expect(entry).toBeDefined();
    expect(entry?.actorId).toBe(h.owner.id);
    expect(JSON.stringify(entry?.payload)).toContain(h.owner.id);
  });

  it('is refused to a chief of staff, who cannot take that decision, and nothing is written', async () => {
    const { h, driver } = unknownBlockers();
    await expect(
      h.issues.closeRequired(h.ctx(h.cos), driver.id, undefined, {
        overrideUnknownBlockers: true,
      }),
    ).rejects.toBeInstanceOf(IssueForbiddenError);
    expect(h.github.closeCalls).toBe(0);
    expect(
      h.issues
        .history('ws_test', driver.id, { afterSeq: 0, limit: 50 })
        .some((e) => e.type === 'blockers_unknown_override'),
    ).toBe(false);
  });

  it('does not override a blocker the provider did report', async () => {
    const { h, driver } = unknownBlockers();
    h.github.issue(ISSUE_URL).blockers = 2;
    const report = await h.issues.closeRequired(
      h.ctx(h.owner),
      driver.id,
      undefined,
      {
        overrideUnknownBlockers: true,
      },
    );
    expect(report.results[0]).toMatchObject({ status: 'blocked' });
    expect(h.github.closeCalls).toBe(0);
  });

  it('does not override authority: without a grant to close, the override closes nothing', async () => {
    const h = createIssueHarness();
    configure(h);
    h.github.add(ISSUE_URL, { blockers: null });
    const driver = missionWithLinks(h);
    driver.verifyOutcome();
    const report = await h.issues.closeRequired(
      h.ctx(h.owner),
      driver.id,
      undefined,
      {
        overrideUnknownBlockers: true,
      },
    );
    expect(report.results[0]?.status).toBe('policy_denied');
    expect(h.github.closeCalls).toBe(0);
  });
});
