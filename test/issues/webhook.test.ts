import { describe, expect, it } from 'vitest';
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

const issueEvent = (
  action: string,
  over: Partial<Extract<WebhookObservation, { kind: 'issue' }>> = {},
): WebhookObservation => ({
  kind: 'issue',
  action,
  repo: 'acme/web',
  number: 1,
  nodeId: 'node_acme/web_1',
  state: action === 'closed' ? 'closed' : 'open',
  title: 'Fix the thing',
  identityLost: false,
  ...over,
});

let delivery = 0;
const deliver = (
  h: IssueHarness,
  observation: WebhookObservation | undefined,
  id?: string,
) =>
  h.issues.handleWebhook({
    workspaceId: 'ws_test',
    actor: h.provider,
    provider: 'github',
    deliveryId: id ?? `del_${++delivery}`,
    event: 'issues',
    observation,
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

describe('webhook processing', () => {
  it('ignores a replayed delivery id without touching state again', async () => {
    const { h, driver } = await completed();

    const first = deliver(h, issueEvent('reopened'), 'same-id');
    const page = { afterSeq: 0, limit: 100 };
    const before = h.issues.history('ws_test', driver.id, page).length;
    const second = deliver(h, issueEvent('reopened'), 'same-id');

    expect(first.status).toBe('processed');
    expect(second.status).toBe('duplicate');
    expect(h.issues.discrepancies('ws_test', driver.id, 'all')).toHaveLength(1);
    expect(h.issues.history('ws_test', driver.id, page)).toHaveLength(before);
    expect(
      h.db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM webhook_deliveries WHERE delivery_id = 'same-id'",
      )?.n,
    ).toBe(1);
  });

  it('records a reopen after completion, moves to needs-attention and never writes back', async () => {
    const { h, driver } = await completed();
    const calls = { get: h.github.getCalls, close: h.github.closeCalls };

    deliver(h, issueEvent('reopened'));

    expect(driver.refresh().state).toBe('needs-attention');
    expect(
      h.issues.discrepancies('ws_test', driver.id, 'open').map((d) => d.kind),
    ).toEqual(['reopened']);
    expect({ get: h.github.getCalls, close: h.github.closeCalls }).toEqual(
      calls,
    );
    const activity = h.core.missions.activity('ws_test', driver.id, {
      afterVersion: 0,
      limit: 100,
    });
    expect(
      activity.items.some(
        (i) => (i.payload as { to?: string }).to === 'completed',
      ),
    ).toBe(true);
  });

  it('recognises the echo of a Tower close by its origin marker and does not loop', async () => {
    const h = createIssueHarness();
    configure(h);
    grantClose(h);
    h.github.add(ISSUE_URL);
    const driver = missionWithLinks(h);
    // GitHub reports the close while Tower's own request is still in flight.
    let echoed: ReturnType<typeof deliver> | undefined;
    h.github.onClose = () => {
      echoed = deliver(h, issueEvent('closed'));
    };

    const report = await h.issues.closeRequired(h.ctx(h.cos), driver.id);

    expect(echoed?.echoes).toBe(1);
    expect(report.results[0]?.status).toBe('closed');
    expect(h.github.closeCalls).toBe(1);
    expect(h.issues.discrepancies('ws_test', driver.id, 'all')).toEqual([]);
    const op = h.db.get<{ echo_seen_at: string | null }>(
      'SELECT echo_seen_at FROM issue_outbound_ops',
    );
    expect(op?.echo_seen_at).not.toBeNull();
    const types = h.issues
      .history('ws_test', driver.id, { afterSeq: 0, limit: 100 })
      .map((i) => i.type);
    expect(types).toContain('echo');
    expect(types).not.toContain('discrepancy');
  });

  it('treats a close with no pending Tower write as an outside change, not an echo', async () => {
    const { h } = await completed();
    h.db.run('UPDATE issue_outbound_ops SET echo_seen_at = ?', [
      new Date().toISOString(),
    ]);

    const result = deliver(h, issueEvent('closed'));

    expect(result.echoes).toBe(0);
  });

  it('does not accept an echo after the window has passed', async () => {
    const h = createIssueHarness();
    configure(h);
    grantClose(h);
    h.github.add(ISSUE_URL);
    const driver = missionWithLinks(h);
    h.github.closeBehaviour = 'ignore';
    await h.issues.closeRequired(h.ctx(h.cos), driver.id);
    h.clock.advance(11 * 60_000);

    expect(deliver(h, issueEvent('closed')).echoes).toBe(0);
  });

  it('matches a comment carrying a known marker, and ignores an invented one', async () => {
    const h = createIssueHarness();
    configure(h);
    grantClose(h);
    h.github.add(ISSUE_URL);
    const driver = missionWithLinks(h);
    h.github.closeBehaviour = 'ignore';
    await h.issues.closeRequired(h.ctx(h.cos), driver.id);
    const marker =
      h.db.get<{ id: string }>('SELECT id FROM issue_outbound_ops')?.id ?? '';

    const forged = deliver(h, {
      kind: 'comment',
      repo: 'acme/web',
      number: 1,
      marker: 'iop_guess',
    });
    const real = deliver(h, {
      kind: 'comment',
      repo: 'acme/web',
      number: 1,
      marker,
    });

    expect(forged.echoes).toBe(0);
    expect(real.echoes).toBe(1);
  });

  it('never lets an open event after our close pass as an echo', async () => {
    const { h, driver } = await completed();

    const result = deliver(h, issueEvent('reopened'));

    expect(result.echoes).toBe(0);
    expect(driver.refresh().state).toBe('needs-attention');
  });

  it('flags a transfer or a different node as a lost identity', async () => {
    const { h, driver } = await completed();

    deliver(h, issueEvent('transferred', { identityLost: true, state: null }));

    expect(driver.refresh().state).toBe('needs-attention');
    expect(h.issues.discrepancies('ws_test', driver.id, 'open')[0]?.kind).toBe(
      'identity_mismatch',
    );

    const second = await completed();
    deliver(
      second.h,
      issueEvent('edited', { nodeId: 'node_someone_else', state: 'closed' }),
    );
    expect(second.driver.refresh().state).toBe('needs-attention');
  });

  it('answers pong, untracked and ignored events and still records the delivery', async () => {
    const h = createIssueHarness();

    expect(deliver(h, { kind: 'ping' }).status).toBe('pong');
    expect(deliver(h, issueEvent('closed')).status).toBe('untracked');
    expect(deliver(h, undefined, 'x1').status).toBe('ignored');
    expect(deliver(h, undefined, 'x1').status).toBe('duplicate');
  });

  it('leaves a cancelled mission alone', async () => {
    const h = createIssueHarness();
    configure(h);
    h.github.add(ISSUE_URL);
    const driver = missionWithLinks(h);
    h.issues.listLinks('ws_test', driver.id);
    h.core.missions.cancelMission(
      h.ctx(h.owner),
      driver.id,
      driver.refresh().version,
      null,
    );

    deliver(h, issueEvent('reopened'));

    expect(h.issues.discrepancies('ws_test', driver.id, 'all')).toEqual([]);
    expect(driver.refresh().state).toBe('cancelled');
  });

  it('does not touch optional links', async () => {
    const h = createIssueHarness();
    h.github.add(ISSUE_URL);
    const driver = missionWithLinks(h, [
      { url: ISSUE_URL, classification: 'optional' },
    ]);
    h.issues.listLinks('ws_test', driver.id);

    deliver(h, issueEvent('reopened'));
    deliver(h, issueEvent('transferred', { identityLost: true }));

    expect(driver.refresh().state).toBe('verifying');
    expect(
      h.issues
        .discrepancies('ws_test', driver.id, 'open')
        .every((d) => !d.requiresAttention),
    ).toBe(true);
  });

  it('keeps the delivery id out of the table when processing fails', async () => {
    const { h } = await completed();
    h.db.exec('DROP TRIGGER issue_link_history_no_update');
    h.db.exec(
      `CREATE TRIGGER boom BEFORE INSERT ON issue_link_history BEGIN SELECT RAISE(ABORT, 'boom'); END`,
    );

    expect(() => deliver(h, issueEvent('reopened'), 'retry-me')).toThrow(
      /boom/,
    );
    expect(
      h.db.get('SELECT 1 FROM webhook_deliveries WHERE delivery_id = ?', [
        'retry-me',
      ]),
    ).toBeUndefined();
  });
});
