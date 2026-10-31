// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PERSONA,
  mountDashboard,
  TOKEN_KEY,
} from '../../public/js/app.js';
import {
  addPacket,
  createMission,
  createRule,
  enrollRunner,
  seededTower,
  type Tower,
} from './fixture.js';

// The project tsconfig has no DOM lib, and adding one would retype the whole program. happy-dom
// supplies these globals at runtime; `El` is the loose type for the elements the tests query.
// biome-ignore lint/suspicious/noExplicitAny: DOM types are not part of this tsconfig
type El = any;
// biome-ignore lint/suspicious/noExplicitAny: provided by the happy-dom environment
declare const document: any;

const PERSONA = {
  name: 'Pilot Desk',
  tagline: 'Steady hands on every mission.',
};

function memoryStorage(token: string | null) {
  const values = new Map<string, string>();
  if (token !== null) {
    values.set(TOKEN_KEY, token);
  }
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

/** Mounts the dashboard against an in-process Tower. Browser requests carry the token the storage holds. */
function mountFor(
  tower: Tower,
  options: {
    storage?: ReturnType<typeof memoryStorage>;
    fetchImpl?: (path: string, init: RequestInit) => Promise<Response>;
  } = {},
) {
  const root = document.createElement('div');
  document.body.append(root);
  const storage = options.storage ?? memoryStorage(tower.token);
  const dashboard = mountDashboard({
    root,
    storage,
    persona: PERSONA,
    fetchImpl: options.fetchImpl ?? tower.fetchFor(null),
  });
  return { root, dashboard, storage };
}

function text(root: El) {
  return root.textContent ?? '';
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('sign-in', () => {
  it('asks for a token and makes no data calls when none is stored', async () => {
    const tower = seededTower();
    const calls: string[] = [];
    const { root, dashboard } = mountFor(tower, {
      storage: memoryStorage(null),
      fetchImpl: async (path, init) => {
        calls.push(`${init.method} ${path}`);
        return tower.fetchFor(null)(path, init);
      },
    });

    await dashboard.show('#/missions');

    const input = root.querySelector('input[type="password"]') as El;
    expect(input).not.toBeNull();
    expect(input.getAttribute('autocomplete')).toBe('off');
    expect(root.querySelector(`label[for="${input.id}"]`)?.textContent).toBe(
      'Access token',
    );
    expect(calls).toEqual([]);
  });

  it('clears a rejected token and explains why sign-in is needed again', async () => {
    const tower = seededTower();
    const { root, dashboard, storage } = mountFor(tower, {
      storage: memoryStorage('twr_not_a_real_token'),
    });
    // The stored value is not a real token, so the API answers 401 for it.

    await dashboard.show('#/missions');

    expect(storage.getItem(TOKEN_KEY)).toBeNull();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain(
      'Your session token was rejected',
    );
    expect(root.querySelector('input[type="password"]')).not.toBeNull();
  });
});

describe('Mission Overview', () => {
  it('lists missions with a state label and a link to the detail view', async () => {
    const tower = seededTower();
    const missionId = await createMission(tower, { title: 'Pilot intake' });
    const { root, dashboard } = mountFor(tower);

    await dashboard.show('#/missions');

    expect(root.querySelector('h1')?.textContent).toBe('Mission overview');
    const link = [...root.querySelectorAll('a')].find(
      (a) => a.textContent === 'Pilot intake',
    );
    expect(link?.getAttribute('href')).toBe(`#/missions/${missionId}`);
    expect(text(root)).toContain('Draft');
    const table = root.querySelector('table');
    expect(table?.querySelector('caption')?.textContent).toBe('Missions');
    expect(
      [...(table?.querySelectorAll('th') ?? [])].every(
        (th) => th.getAttribute('scope') === 'col',
      ),
    ).toBe(true);
    expect(
      root
        .querySelector('[role="region"][aria-label="Missions"]')
        ?.getAttribute('tabindex'),
    ).toBe('0');
  });

  it('says so when there are no missions', async () => {
    const tower = seededTower();
    const { root, dashboard } = mountFor(tower);

    await dashboard.show('#/missions');

    expect(text(root)).toContain('No missions yet.');
  });

  it('renders untrusted titles as text, never as markup', async () => {
    const tower = seededTower();
    await createMission(tower, {
      title: '<img src=x onerror="window.__pwned=1"><b>bold</b>',
    });
    const { root, dashboard } = mountFor(tower);

    await dashboard.show('#/missions');

    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('b')).toBeNull();
    expect(text(root)).toContain(
      '<img src=x onerror="window.__pwned=1"><b>bold</b>',
    );
  });
});

describe('Mission Detail', () => {
  it('shows outcome, definition of done, constraints and the timeline', async () => {
    const tower = seededTower();
    const missionId = await createMission(tower);
    const { root, dashboard } = mountFor(tower);

    await dashboard.show(`#/missions/${missionId}`);

    expect(text(root)).toContain('Intake is live for one campus.');
    expect(text(root)).toContain('Smoke test passes');
    expect(text(root)).toContain('No schema changes');
    expect(root.querySelector('ol.timeline')?.getAttribute('aria-label')).toBe(
      'Mission timeline',
    );
    expect(text(root)).toContain('mission.created');
  });

  it('explains why a dependent task is blocked and names what it waits on', async () => {
    const tower = seededTower();
    const missionId = await createMission(tower);
    const spec = await addPacket(tower, missionId, 'Draft spec');
    await addPacket(tower, missionId, 'Build it', [spec]);
    const { root, dashboard } = mountFor(tower);

    await dashboard.show(`#/missions/${missionId}`);

    const blocked = root.querySelector('section.blocked');
    expect(blocked?.getAttribute('aria-labelledby')).toBe('blocked-title');
    expect(blocked?.textContent).toContain('Build it is blocked by Draft spec');
    const row = [...root.querySelectorAll('tbody tr')].find((tr) =>
      tr.textContent?.includes('Build it'),
    );
    expect(row?.textContent).toContain('Waiting on Draft spec');
  });

  it('marks packets with no evidence as such and never as verified', async () => {
    const tower = seededTower();
    const missionId = await createMission(tower);
    await addPacket(tower, missionId, 'Draft spec');
    const { root, dashboard } = mountFor(tower);

    await dashboard.show(`#/missions/${missionId}`);

    expect(root.querySelector('[data-evidence="none"]')?.textContent).toBe(
      'No evidence yet',
    );
    expect(root.querySelector('[data-evidence="verified"]')).toBeNull();
    expect(
      root.querySelector('[data-evidence="outcome-unverified"]')?.textContent,
    ).toBe('Outcome not verified by Tower');
  });

  it('shows a check box state as text, not color alone', async () => {
    const tower = seededTower();
    const missionId = await createMission(tower);
    const { root, dashboard } = mountFor(tower);

    await dashboard.show(`#/missions/${missionId}`);

    const item = root.querySelector('ul.checklist li');
    expect(item?.querySelector('.check')?.textContent).toBe('[ ]');
    expect(item?.querySelector('.check')?.getAttribute('aria-label')).toBe(
      'not done',
    );
  });
});

describe('Runner Fleet', () => {
  it('shows enrolled runners with an active status label', async () => {
    const tower = seededTower();
    await enrollRunner(tower, 'pilot-runner');
    const { root, dashboard } = mountFor(tower);

    await dashboard.show('#/runners');

    expect(root.querySelector('h1')?.textContent).toBe('Runner fleet');
    const cell = [...root.querySelectorAll('td')].find(
      (td) => td.textContent === 'pilot-runner',
    );
    expect(cell).toBeDefined();
    expect(text(root)).toContain('Active');
  });
});

describe('Decision Inbox', () => {
  it('answers only after an explicit confirmation, then removes the decision', async () => {
    const tower = seededTower();
    const missionId = await createMission(tower);
    const packetId = await addPacket(tower, missionId, 'Draft spec');
    const created = await tower.call('POST', '/decisions', {
      dedupeKey: 'billing-touch',
      category: 'scope_expansion',
      urgency: 'high',
      question: 'May the follow-up touch billing?',
      recommendation: { alternativeId: 'approve', rationale: 'Low risk.' },
      consequences: 'Billing files may change.',
      evidence: [],
      affectedScope: [],
      advisory: { confidencePercent: 80 },
      branches: [{ missionId, packetId }],
    });
    expect(created.status).toBe(201);

    const posted: string[] = [];
    const { root, dashboard } = mountFor(tower, {
      fetchImpl: async (path, init) => {
        if (init.method === 'POST') {
          posted.push(path);
        }
        return tower.fetchFor(null)(path, init);
      },
    });

    await dashboard.show('#/decisions');
    expect(root.querySelector('h1')?.textContent).toBe('Decision inbox');
    const answer = [...root.querySelectorAll('button')].find(
      (b) => b.textContent === 'Answer…',
    ) as El;
    answer.click();

    const group = root.querySelector('[role="group"]');
    expect(group?.getAttribute('aria-label')).toBe('Confirm answer: Approve');
    expect(posted).toEqual([]);
    expect(group?.textContent).toContain('Resumes the blocked branches only');

    const confirm = [...root.querySelectorAll('button')].find(
      (b) => b.textContent === 'Confirm answer',
    ) as El;
    confirm.click();

    await vi.waitFor(() => expect(text(root)).toContain('No open decisions.'));
    expect(posted.some((path) => path.endsWith('/answers'))).toBe(true);
  });

  it('cancelling the confirmation sends nothing', async () => {
    const tower = seededTower();
    const missionId = await createMission(tower);
    const packetId = await addPacket(tower, missionId, 'Draft spec');
    const created = await tower.call('POST', '/decisions', {
      dedupeKey: 'cancel-me',
      category: 'scope_expansion',
      urgency: 'normal',
      question: 'Spend on a domain?',
      recommendation: { alternativeId: 'approve', rationale: 'Low risk.' },
      consequences: 'Billing files may change.',
      evidence: [],
      affectedScope: [],
      advisory: { confidencePercent: 80 },
      branches: [{ missionId, packetId }],
    });
    expect(created.status).toBe(201);
    const posted: string[] = [];
    const { root, dashboard } = mountFor(tower, {
      fetchImpl: async (path, init) => {
        if (init.method === 'POST') {
          posted.push(path);
        }
        return tower.fetchFor(null)(path, init);
      },
    });

    await dashboard.show('#/decisions');
    (
      [...root.querySelectorAll('button')].find(
        (b) => b.textContent === 'Answer…',
      ) as El
    ).click();
    (
      [...root.querySelectorAll('button')].find(
        (b) => b.textContent === 'Cancel',
      ) as El
    ).click();

    expect(root.querySelector('[role="group"]')).toBeNull();
    expect(posted).toEqual([]);
  });

  it('shows a version conflict as an alert instead of applying the answer', async () => {
    const tower = seededTower();
    const missionId = await createMission(tower);
    const packetId = await addPacket(tower, missionId, 'Draft spec');
    const created = await tower.call('POST', '/decisions', {
      dedupeKey: 'stale',
      category: 'scope_expansion',
      urgency: 'normal',
      question: 'Stale answer?',
      recommendation: { alternativeId: 'approve', rationale: 'Low risk.' },
      consequences: 'Billing files may change.',
      evidence: [],
      affectedScope: [],
      advisory: { confidencePercent: 80 },
      branches: [{ missionId, packetId }],
    });
    expect(created.status).toBe(201);
    const { root, dashboard } = mountFor(tower, {
      fetchImpl: async (path, init) => {
        if (init.method === 'POST' && path.endsWith('/answers')) {
          return new Response(
            JSON.stringify({
              error: { code: 'version_conflict', message: 'Decision changed' },
            }),
            { status: 409, headers: { 'content-type': 'application/json' } },
          );
        }
        return tower.fetchFor(null)(path, init);
      },
    });

    await dashboard.show('#/decisions');
    (
      [...root.querySelectorAll('button')].find(
        (b) => b.textContent === 'Answer…',
      ) as El
    ).click();
    (
      [...root.querySelectorAll('button')].find(
        (b) => b.textContent === 'Confirm answer',
      ) as El
    ).click();

    await vi.waitFor(() =>
      expect(
        root.querySelector('[role="group"] [role="alert"]')?.textContent,
      ).toContain('changed since it was loaded'),
    );
    expect(text(root)).toContain('Stale answer?');
  });
});

describe('Permissions & Preferences', () => {
  it('shows the policy version and active rules, and revokes only after confirmation', async () => {
    const tower = seededTower();
    const rule = await createRule(tower);
    const posted: { path: string; body: unknown }[] = [];
    const { root, dashboard } = mountFor(tower, {
      fetchImpl: async (path, init) => {
        if (init.method === 'POST') {
          posted.push({ path, body: JSON.parse(String(init.body)) });
        }
        return tower.fetchFor(null)(path, init);
      },
    });

    await dashboard.show('#/policy');
    expect(text(root)).toContain('Policy version 1');
    (
      [...root.querySelectorAll('button')].find(
        (b) => b.textContent === 'Revoke repo.write',
      ) as El
    ).click();
    expect(posted).toEqual([]);
    (
      [...root.querySelectorAll('button')].find(
        (b) => b.textContent === 'Revoke rule',
      ) as El
    ).click();

    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      path: `/policy/rules/${rule.id}/revoke`,
      body: { expectedVersion: rule.version, reason: null },
    });
    await vi.waitFor(() =>
      expect(text(root)).toContain('No active rules yet.'),
    );
  });

  it('accepts a pending proposal only after confirmation and shows that it authorizes nothing before', async () => {
    const tower = seededTower();
    const proposal = {
      id: 'prp_test_1',
      status: 'pending',
      action: 'repo.read',
      resource: 'repo:app',
      scope: 'repo:app',
      maxRisk: 'low',
      granteeKind: 'chief_of_staff',
      limits: { maxAmount: null, missionIds: null },
      evidence: [],
      approvals: 3,
      createdAt: '2026-10-31T00:00:00.000Z',
      resolvedAt: null,
      resolvedBy: null,
      resolutionNote: null,
      resultingRuleId: null,
    };
    const posted: string[] = [];
    const { root, dashboard } = mountFor(tower, {
      fetchImpl: async (path, init) => {
        if (path === '/policy' && init.method === 'GET') {
          const real = (await (
            await tower.fetchFor(null)(path, init)
          ).json()) as Record<string, unknown>;
          return new Response(
            JSON.stringify({ ...real, proposals: [proposal] }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (init.method === 'POST') {
          posted.push(path);
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return tower.fetchFor(null)(path, init);
      },
    });

    await dashboard.show('#/policy');
    expect(text(root)).toContain(
      'authorizes nothing until a person accepts it',
    );
    expect(text(root)).toContain('suggested after 3 approvals');
    (
      [...root.querySelectorAll('button')].find(
        (b) => b.textContent === 'Accept…',
      ) as El
    ).click();
    expect(posted).toEqual([]);
    (
      [...root.querySelectorAll('button')].find(
        (b) => b.textContent === 'Accept proposal',
      ) as El
    ).click();

    await vi.waitFor(() =>
      expect(posted).toEqual(['/policy/proposals/prp_test_1/accept']),
    );
  });
});

describe('Integrations, Activity and Health', () => {
  it('describes link-only mode when no provider is configured', async () => {
    const tower = seededTower();
    const { root, dashboard } = mountFor(tower);

    await dashboard.show('#/integrations');

    expect(text(root)).toContain('link-only');
  });

  it('lists fleet audit records', async () => {
    const tower = seededTower();
    await enrollRunner(tower, 'audited-runner');
    const { root, dashboard } = mountFor(tower);

    await dashboard.show('#/activity');

    expect(
      root.querySelector(
        'table[aria-label="Fleet audit records"], [aria-label="Fleet audit records"] table',
      ),
    ).not.toBeNull();
    expect(
      root.querySelectorAll('[aria-label="Fleet audit records"] tbody tr')
        .length,
    ).toBeGreaterThan(0);
  });

  it('reports liveness and counts without workspace or storage detail', async () => {
    const tower = seededTower();
    await createMission(tower);
    const { root, dashboard } = mountFor(tower);

    await dashboard.show('#/health');

    expect(text(root)).toContain('ok');
    expect(text(root)).toContain('Missions1');
    expect(text(root)).not.toContain('ws_test');
  });
});

describe('navigation and accessibility', () => {
  it('marks the current section in the menu and moves focus to its heading', async () => {
    const tower = seededTower();
    const { root, dashboard } = mountFor(tower);

    await dashboard.show('#/runners');

    const current = root.querySelectorAll('a[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect((current[0] as El).dataset.view).toBe('runners');
    expect(root.querySelector('nav')?.getAttribute('aria-label')).toBe(
      'Sections',
    );
    expect(root.querySelector('.skip')?.getAttribute('href')).toBe('#main');
    expect(document.activeElement?.tagName).toBe('H1');
  });

  it('keeps a mission detail under the Mission Overview menu entry', async () => {
    const tower = seededTower();
    const missionId = await createMission(tower);
    const { root, dashboard } = mountFor(tower);

    await dashboard.show(`#/missions/${missionId}`);

    expect(
      (root.querySelector('a[aria-current="page"]') as El).dataset.view,
    ).toBe('missions');
  });

  it('shows a plain not-found page for unknown sections', async () => {
    const tower = seededTower();
    const { root, dashboard } = mountFor(tower);

    await dashboard.show('#/nope');

    expect(root.querySelector('h1')?.textContent).toBe('Page not found');
  });

  it('uses the persona from configuration in the header, with no hard-coded name', async () => {
    const tower = seededTower();
    const { root, dashboard } = mountFor(tower);
    await dashboard.show('#/missions');
    expect(root.querySelector('.brand-name')?.textContent).toBe('Pilot Desk');

    const other = mountFor(tower);
    await other.dashboard.show('#/missions');
    expect(DEFAULT_PERSONA.name).not.toMatch(/rico/i);
  });
});

/**
 * Serves the real API response, then replaces the JSON body for one exact GET path.
 * Used where the seeded data cannot reach a state, such as a runner-reported attempt.
 */
function overrideGet(
  tower: Tower,
  path: string,
  // biome-ignore lint/suspicious/noExplicitAny: the API JSON is reshaped per test
  transform: (body: Record<string, any>) => unknown,
) {
  const base = tower.fetchFor(null);
  return async (requested: string, init: RequestInit) => {
    const res = await base(requested, init);
    if (init.method !== 'GET' || requested.split('?')[0] !== path) {
      return res;
    }
    const body = transform((await res.json()) as Record<string, unknown>);
    return new Response(JSON.stringify(body), {
      status: res.status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

describe('evidence and state labels', () => {
  it('tells runner self-reports apart from Tower-verified packets', async () => {
    const tower = seededTower();
    const missionId = await createMission(tower);
    const reported = await addPacket(tower, missionId, 'Reported task');
    const verified = await addPacket(tower, missionId, 'Verified task');
    const { root, dashboard } = mountFor(tower, {
      fetchImpl: overrideGet(tower, `/missions/${missionId}`, (body) => {
        const packets = body.mission.packets.map(
          (p: Record<string, unknown>) => {
            if (p.id === reported) {
              return { ...p, status: 'reported' };
            }
            return {
              ...p,
              status: 'verified',
              verification: {
                at: '2026-10-31T08:00:00.000Z',
                by: 'prn_tower',
                evidenceRefs: [],
              },
            };
          },
        );
        const attempts = [
          {
            id: 'att_1',
            missionId,
            packetId: reported,
            number: 1,
            runnerId: 'prn_runner',
            status: 'self-reported-succeeded',
            dispatchedAt: '2026-10-31T07:00:00.000Z',
            startedAt: null,
            reportedAt: '2026-10-31T07:30:00.000Z',
            report: {
              outcome: 'succeeded',
              summary: 'Looks done',
              by: 'prn_runner',
            },
          },
        ];
        return { mission: { ...body.mission, packets, attempts } };
      }),
    });

    await dashboard.show(`#/missions/${missionId}`);

    expect(
      root.querySelector('[data-evidence="self-reported"]')?.textContent,
    ).toBe('Self-reported by runner (not verified)');
    expect(root.querySelector('[data-evidence="verified"]')?.textContent).toBe(
      'Verified by Tower',
    );
    expect(verified).not.toBe(reported);
    expect(text(root)).toContain('Looks done');
  });

  it('shows paused and quarantined runners with their own labels', async () => {
    const tower = seededTower();
    await enrollRunner(tower, 'napping-runner');
    const { root, dashboard } = mountFor(tower, {
      fetchImpl: overrideGet(tower, '/runners', (body) => ({
        runners: body.runners.map((r: Record<string, unknown>) => ({
          ...r,
          status: 'quarantined',
          quarantineReason: 'test',
        })),
      })),
    });

    await dashboard.show('#/runners');

    expect(root.querySelector('[data-state="quarantined"]')?.textContent).toBe(
      'Quarantined',
    );
    expect(text(root)).not.toContain('Active');
  });

  it('explains a mission that waits for a runner without claiming execution', async () => {
    const tower = seededTower();
    const missionId = await createMission(tower);
    const { root, dashboard } = mountFor(tower, {
      fetchImpl: overrideGet(tower, `/missions/${missionId}`, (body) => ({
        mission: { ...body.mission, state: 'waiting-runner' },
      })),
    });

    await dashboard.show(`#/missions/${missionId}`);

    expect(root.querySelector('section.blocked')?.textContent).toContain(
      'No runner has claimed this mission',
    );
    expect(
      root.querySelector('[data-state="waiting-runner"]')?.textContent,
    ).toBe('Waiting for runner');
  });

  it('links only web addresses and shows any other issue URL as plain text', async () => {
    const tower = seededTower();
    const missionId = await createMission(tower);
    const { root, dashboard } = mountFor(tower, {
      fetchImpl: overrideGet(
        tower,
        `/missions/${missionId}/issue-links`,
        () => ({
          links: [
            {
              id: 'lnk_1',
              url: 'https://github.com/favor/app/issues/1',
              observedState: 'open',
              observedSource: 'poll',
              polledAt: null,
            },
            {
              id: 'lnk_2',
              url: 'javascript:alert(1)',
              observedState: 'unknown',
              observedSource: null,
              polledAt: null,
            },
          ],
          discrepancies: [],
        }),
      ),
    });

    await dashboard.show(`#/missions/${missionId}`);

    const anchors = [...root.querySelectorAll('a')].map((a) =>
      a.getAttribute('href'),
    );
    expect(anchors).toContain('https://github.com/favor/app/issues/1');
    expect(anchors.some((href) => href?.startsWith('javascript:'))).toBe(false);
    expect(text(root)).toContain('javascript:alert(1)');
    const safe = root.querySelector(
      'a[href="https://github.com/favor/app/issues/1"]',
    );
    expect(safe?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(safe?.getAttribute('target')).toBe('_blank');
  });
});
