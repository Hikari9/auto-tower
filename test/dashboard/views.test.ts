// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PERSONA,
  mountDashboard,
  TOKEN_KEY,
} from '../../public/js/app.js';
import { loadPersona } from '../../public/js/boot.js';
import { LEASE_STATES } from '../../public/js/status.js';
import {
  addPacket,
  createMission,
  createRule,
  enrollRunner,
  json,
  seedAuthorityHold,
  seededTower,
  type Tower,
} from './fixture.js';

// The project tsconfig has no DOM lib, and adding one would retype the whole program. happy-dom
// supplies these globals at runtime; `El` is the loose type for the elements the tests query.
// biome-ignore lint/suspicious/noExplicitAny: DOM types are not part of this tsconfig
type El = any;
// biome-ignore lint/suspicious/noExplicitAny: provided by the happy-dom environment
declare const document: any;
// biome-ignore lint/suspicious/noExplicitAny: provided by the happy-dom environment
declare const window: any;

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
    const headers = [...(table?.querySelectorAll('th') ?? [])];
    expect(headers.length).toBeGreaterThan(0);
    expect(headers.every((th) => th.getAttribute('scope') === 'col')).toBe(
      true,
    );
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
    expect(root.querySelector('#blocked-title')?.textContent).toBe(
      'Why this is blocked',
    );
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
      expect(root.querySelector('[role="alert"]')?.textContent).toContain(
        'changed since it was loaded',
      ),
    );
    expect(root.querySelector('[role="group"]')).toBeNull();
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

  it('lists fleet audit records and policy history', async () => {
    const tower = seededTower();
    await enrollRunner(tower, 'audited-runner');
    await createRule(tower);
    const { root, dashboard } = mountFor(tower);

    await dashboard.show('#/activity');

    const history = [
      ...root.querySelectorAll('[aria-label="Policy history"] tbody tr'),
    ] as El[];
    expect(history.length).toBeGreaterThan(0);
    expect(history[0].querySelectorAll('td')[0].textContent).toMatch(/^\d+$/);
    expect(history[0].querySelectorAll('td')[3].textContent).not.toBe('');

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

    expect(factValue(root, 'API')).toBe('ok');
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
    expect(root.querySelector('#main')?.tagName).toBe('MAIN');
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

    // The rendered pages carry the configured persona and no name from the build.
    for (const hash of [
      '#/missions',
      '#/runners',
      '#/decisions',
      '#/policy',
      '#/integrations',
      '#/activity',
      '#/health',
    ]) {
      const page = mountFor(tower);
      await page.dashboard.show(hash);
      expect(text(page.root), hash).not.toMatch(/rico/i);
    }
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
    await addPacket(tower, missionId, 'Verified task');
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
    expect(text(root)).toContain('Looks done');
    expect(text(root)).toContain('succeeded (self-reported): Looks done');
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
    expect(root.querySelector('section.blocked')?.textContent).not.toMatch(
      /in progress|currently running|work is/i,
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

// --- Hardening: one test per self-review finding ----------------------------

/** The value next to a `<dt>` in a facts list. */
function factValue(root: El, term: string): string | undefined {
  const dt = ([...root.querySelectorAll('dt')] as El[]).find(
    (el) => el.textContent === term,
  );
  return dt?.nextElementSibling?.textContent ?? undefined;
}

function buttonNamed(root: El, label: string): El {
  const found = ([...root.querySelectorAll('button')] as El[]).find(
    (b) => b.textContent === label,
  );
  if (found === undefined) {
    throw new Error(`no button "${label}"`);
  }
  return found;
}

/** Records every request, so a test can check what was sent and not only what was shown. */
function recorder(
  tower: Tower,
  respond?: (
    path: string,
    init: RequestInit,
  ) => Response | Promise<Response> | undefined,
) {
  const requests: { path: string; init: RequestInit }[] = [];
  const base = tower.fetchFor(null);
  return {
    requests,
    fetchImpl: async (path: string, init: RequestInit) => {
      requests.push({ path, init });
      const custom = await respond?.(path, init);
      return custom ?? base(path, init);
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('proposal acceptance shows what it grants', () => {
  it('names scope, grantee and limits on the card and in the confirmation', async () => {
    const tower = seededTower();
    const proposal = {
      id: 'prp_show',
      status: 'pending',
      action: 'repo.read',
      resource: 'repo:app',
      scope: 'repo:app',
      maxRisk: 'low',
      granteeKind: 'chief_of_staff',
      limits: { maxAmount: 50, missionIds: ['msn_1'] },
      evidence: [],
      approvals: 3,
      createdAt: '2026-10-31T00:00:00.000Z',
      resolvedAt: null,
      resolvedBy: null,
      resolutionNote: null,
      resultingRuleId: null,
    };
    const { root, dashboard } = mountFor(tower, {
      fetchImpl: overrideGet(tower, '/policy', (body) => ({
        ...body,
        proposals: [proposal],
      })),
    });

    await dashboard.show('#/policy');
    expect(text(root)).toContain(
      'Scope repo:app, grantee chief_of_staff, max risk low. Limits: up to 50; missions msn_1.',
    );
    buttonNamed(root, 'Accept…').click();

    const group = root.querySelector('[role="group"]');
    expect(group?.textContent).toContain('scope repo:app');
    expect(group?.textContent).toContain('grantee chief_of_staff');
    expect(group?.textContent).toContain('missions msn_1');
  });

  it('declines a proposal only after confirmation', async () => {
    const tower = seededTower();
    const proposal = {
      id: 'prp_decline',
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
    const rec = recorder(tower, (_path, init) =>
      init.method === 'POST' ? jsonResponse({ ok: true }) : undefined,
    );
    const { root, dashboard } = mountFor(tower, {
      fetchImpl: async (path, init) => {
        if (path === '/policy' && init.method === 'GET') {
          const real = (await (
            await tower.fetchFor(null)(path, init)
          ).json()) as Record<string, unknown>;
          return jsonResponse({ ...real, proposals: [proposal] });
        }
        return rec.fetchImpl(path, init);
      },
    });

    await dashboard.show('#/policy');
    buttonNamed(root, 'Decline…').click();
    expect(rec.requests.filter((r) => r.init.method === 'POST')).toHaveLength(
      0,
    );
    buttonNamed(root, 'Decline proposal').click();

    await vi.waitFor(() =>
      expect(
        rec.requests.filter((r) => r.init.method === 'POST').map((r) => r.path),
      ).toEqual(['/policy/proposals/prp_decline/decline']),
    );
  });
});

describe('health reports real counts', () => {
  it('counts every open decision, not just the first one returned', async () => {
    const tower = seededTower();
    const missionId = await createMission(tower);
    const packetId = await addPacket(tower, missionId, 'Draft spec');
    for (const key of ['one', 'two', 'three']) {
      await tower.call('POST', '/decisions', {
        dedupeKey: key,
        category: 'scope_expansion',
        urgency: 'normal',
        question: `Question ${key}?`,
        recommendation: { alternativeId: 'approve', rationale: 'Low risk.' },
        consequences: 'x',
        evidence: [],
        affectedScope: [],
        advisory: { confidencePercent: 80 },
        branches: [{ missionId, packetId }],
      });
    }
    const { root, dashboard } = mountFor(tower);

    await dashboard.show('#/health');

    expect(factValue(root, 'Open decisions')).toBe('3');
    expect(factValue(root, 'Missions')).toBe('1');
  });

  it('shows only the health status, not extra fields the API might return', async () => {
    const tower = seededTower();
    const { root, dashboard } = mountFor(tower, {
      fetchImpl: overrideGet(tower, '/health', () => ({
        status: 'ok',
        workspace: 'ws_leak',
        storage: '/secret/path',
      })),
    });

    await dashboard.show('#/health');

    expect(factValue(root, 'API')).toBe('ok');
    expect(text(root)).not.toContain('ws_leak');
    expect(text(root)).not.toContain('/secret/path');
  });
});

describe('malformed input and partial responses', () => {
  it('treats a malformed percent-encoded mission id as not found, without rejecting', async () => {
    const tower = seededTower();
    const { root, dashboard } = mountFor(tower);

    await expect(dashboard.show('#/missions/100%')).resolves.toBeUndefined();
    expect(root.querySelector('h1')?.textContent).toBe('Page not found');
  });

  it('renders a mission whose optional arrays are absent instead of failing the page', async () => {
    const tower = seededTower();
    const missionId = await createMission(tower);
    const spec = await addPacket(tower, missionId, 'Draft spec');
    await addPacket(tower, missionId, 'Build it', [spec]);
    const { root, dashboard } = mountFor(tower, {
      fetchImpl: overrideGet(tower, `/missions/${missionId}`, (body) => {
        const { constraints, definitionOfDone, evidenceRefs, ...rest } =
          body.mission;
        const packets = rest.packets.map((p: Record<string, unknown>) => {
          const { dependsOn, ...packet } = p;
          return packet;
        });
        return { mission: { ...rest, packets } };
      }),
    });

    await dashboard.show(`#/missions/${missionId}`);

    expect(root.querySelector('[role="alert"]')).toBeNull();
    expect(root.querySelector('h1')?.textContent).toBe('Ship the pilot');
  });

  it('keeps the token out of URLs and sends it only as a bearer header', async () => {
    const tower = seededTower();
    await createMission(tower);
    const rec = recorder(tower);
    const { dashboard } = mountFor(tower, { fetchImpl: rec.fetchImpl });

    await dashboard.show('#/missions');
    await dashboard.show(`#/missions`);

    expect(rec.requests.length).toBeGreaterThan(0);
    for (const { path, init } of rec.requests) {
      expect(path).not.toContain(tower.token);
      expect((init.headers as Record<string, string>).authorization).toBe(
        `Bearer ${tower.token}`,
      );
    }
  });
});

describe('failed writes return the user to a usable screen', () => {
  it('shows sign-in with a message when a write is rejected as unauthorized', async () => {
    const tower = seededTower();
    const missionId = await createMission(tower);
    const packetId = await addPacket(tower, missionId, 'Draft spec');
    await tower.call('POST', '/decisions', {
      dedupeKey: 'expired',
      category: 'scope_expansion',
      urgency: 'normal',
      question: 'Expired session?',
      recommendation: { alternativeId: 'approve', rationale: 'Low risk.' },
      consequences: 'x',
      evidence: [],
      affectedScope: [],
      advisory: { confidencePercent: 80 },
      branches: [{ missionId, packetId }],
    });
    const { root, dashboard, storage } = mountFor(tower, {
      fetchImpl: async (path, init) => {
        if (init.method === 'POST') {
          return jsonResponse(
            {
              error: {
                code: 'unauthenticated',
                message: 'A valid bearer token is required',
              },
            },
            401,
          );
        }
        return tower.fetchFor(null)(path, init);
      },
    });

    await dashboard.show('#/decisions');
    buttonNamed(root, 'Answer…').click();
    buttonNamed(root, 'Confirm answer').click();

    await vi.waitFor(() =>
      expect(root.querySelector('input[type="password"]')).not.toBeNull(),
    );
    expect(storage.getItem(TOKEN_KEY)).toBeNull();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain(
      'Your session token was rejected',
    );
  });

  it('disables Cancel while an answer is in flight', async () => {
    const tower = seededTower();
    const missionId = await createMission(tower);
    const packetId = await addPacket(tower, missionId, 'Draft spec');
    await tower.call('POST', '/decisions', {
      dedupeKey: 'inflight',
      category: 'scope_expansion',
      urgency: 'normal',
      question: 'Slow answer?',
      recommendation: { alternativeId: 'approve', rationale: 'Low risk.' },
      consequences: 'x',
      evidence: [],
      affectedScope: [],
      advisory: { confidencePercent: 80 },
      branches: [{ missionId, packetId }],
    });
    const { root, dashboard } = mountFor(tower, {
      fetchImpl: async (path, init) => {
        if (init.method === 'POST') {
          return new Promise<Response>(() => {});
        }
        return tower.fetchFor(null)(path, init);
      },
    });

    await dashboard.show('#/decisions');
    buttonNamed(root, 'Answer…').click();
    buttonNamed(root, 'Confirm answer').click();

    expect(buttonNamed(root, 'Cancel').disabled).toBe(true);
    expect(buttonNamed(root, 'Confirm answer').disabled).toBe(true);
  });

  it('sends the chosen alternative, the version and the trimmed note', async () => {
    const tower = seededTower();
    const missionId = await createMission(tower);
    const packetId = await addPacket(tower, missionId, 'Draft spec');
    await tower.call('POST', '/decisions', {
      dedupeKey: 'choose',
      category: 'scope_expansion',
      urgency: 'normal',
      question: 'Which way?',
      recommendation: { alternativeId: 'approve', rationale: 'Low risk.' },
      consequences: 'x',
      evidence: [],
      affectedScope: [],
      advisory: { confidencePercent: 80 },
      branches: [{ missionId, packetId }],
    });
    const rec = recorder(tower);
    const { root, dashboard } = mountFor(tower, { fetchImpl: rec.fetchImpl });

    await dashboard.show('#/decisions');
    const decline = root.querySelector('input[value="decline"]') as El;
    decline.checked = true;
    (root.querySelector('textarea') as El).value = '  ship it  ';
    buttonNamed(root, 'Answer…').click();
    buttonNamed(root, 'Confirm answer').click();

    await vi.waitFor(() =>
      expect(rec.requests.some((r) => r.init.method === 'POST')).toBe(true),
    );
    const post = rec.requests.find((r) => r.init.method === 'POST') as {
      path: string;
      init: RequestInit;
    };
    expect(post.path).toMatch(/\/decisions\/dec_[0-9a-f]+\/answers$/);
    expect(JSON.parse(String(post.init.body))).toEqual({
      version: 1,
      choice: 'decline',
      note: 'ship it',
    });
  });

  it('signs out, clears the token and moves the URL back to the overview', async () => {
    const tower = seededTower();
    const { root, dashboard, storage } = mountFor(tower);

    await dashboard.show('#/decisions');
    buttonNamed(root, 'Sign out').click();

    await vi.waitFor(() =>
      expect(root.querySelector('input[type="password"]')).not.toBeNull(),
    );
    expect(storage.getItem(TOKEN_KEY)).toBeNull();
    expect((root.querySelector('.site-header button') as El).hidden).toBe(true);
    expect(window.location.hash).toBe('#/missions');
  });
});

describe('sign-in form', () => {
  it('stores the trimmed token and shows the overview when it is valid', async () => {
    const tower = seededTower();
    const { root, dashboard, storage } = mountFor(tower, {
      storage: memoryStorage(null),
    });

    await dashboard.show('#/missions');
    const input = root.querySelector('input[type="password"]') as El;
    input.value = `  ${tower.token}  `;
    (root.querySelector('form') as El).dispatchEvent(
      new Event('submit', { cancelable: true }),
    );

    await vi.waitFor(() =>
      expect(root.querySelector('h1')?.textContent).toBe('Mission overview'),
    );
    expect(storage.getItem(TOKEN_KEY)).toBe(tower.token);
  });

  it('ignores a blank token', async () => {
    const tower = seededTower();
    const { root, dashboard, storage } = mountFor(tower, {
      storage: memoryStorage(null),
    });

    await dashboard.show('#/missions');
    (root.querySelector('input[type="password"]') as El).value = '   ';
    (root.querySelector('form') as El).dispatchEvent(
      new Event('submit', { cancelable: true }),
    );

    expect(storage.getItem(TOKEN_KEY)).toBeNull();
    expect(root.querySelector('input[type="password"]')).not.toBeNull();
  });
});

describe('storage and error paths', () => {
  it('reads the session token from sessionStorage when no storage is passed', async () => {
    const tower = seededTower();
    window.sessionStorage.setItem(TOKEN_KEY, tower.token);
    try {
      const root = document.createElement('div');
      document.body.append(root);
      const dashboard = mountDashboard({
        root,
        fetchImpl: tower.fetchFor(null),
      });

      await dashboard.show('#/missions');

      expect(root.querySelector('h1')?.textContent).toBe('Mission overview');
    } finally {
      window.sessionStorage.removeItem(TOKEN_KEY);
    }
  });

  it('shows the scope message for a 403 instead of a blank page', async () => {
    const tower = seededTower();
    const { root, dashboard } = mountFor(tower, {
      fetchImpl: async (path, init) =>
        path.startsWith('/missions') && init.method === 'GET'
          ? jsonResponse({ error: { code: 'forbidden', message: 'x' } }, 403)
          : tower.fetchFor(null)(path, init),
    });

    await dashboard.show('#/missions');

    expect(root.querySelector('h1')?.textContent).toBe('Mission overview');
    expect(root.querySelector('[role="alert"]')?.textContent).toContain(
      'lacks the scope',
    );
  });

  it('shows an alert with the heading for a server error', async () => {
    const tower = seededTower();
    const { root, dashboard } = mountFor(tower, {
      fetchImpl: async (path, init) =>
        path.startsWith('/missions') && init.method === 'GET'
          ? jsonResponse(
              {
                error: {
                  code: 'internal_error',
                  message: 'Internal server error',
                },
              },
              500,
            )
          : tower.fetchFor(null)(path, init),
    });

    await dashboard.show('#/missions');

    expect(root.querySelector('h1')?.textContent).toBe('Mission overview');
    expect(root.querySelector('[role="alert"]')?.textContent).toContain(
      'Internal server error',
    );
  });

  it('explains a network failure as a connection problem', async () => {
    const tower = seededTower();
    const { root, dashboard } = mountFor(tower, {
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });

    await dashboard.show('#/missions');

    expect(root.querySelector('[role="alert"]')?.textContent).toContain(
      'Check the connection',
    );
  });
});

describe('links, markup and persona', () => {
  it('renders only http and https issue links, whatever the scheme spelling', async () => {
    const tower = seededTower();
    const missionId = await createMission(tower);
    const hostile = [
      'javascript:alert(1)',
      'data:text/html,<script>1</script>',
      'vbscript:msgbox(1)',
      ' JaVaScRiPt:alert(1)',
    ];
    const { root, dashboard } = mountFor(tower, {
      fetchImpl: overrideGet(
        tower,
        `/missions/${missionId}/issue-links`,
        () => ({
          links: [
            ...hostile.map((url, i) => ({
              id: `lnk_${i}`,
              url,
              observedState: 'unknown',
              observedSource: null,
              polledAt: null,
            })),
            {
              id: 'lnk_ok',
              url: 'https://example.org/issues/2',
              observedState: 'open',
              observedSource: 'poll',
              polledAt: null,
            },
          ],
          discrepancies: [],
        }),
      ),
    });

    await dashboard.show(`#/missions/${missionId}`);

    const hrefs = [...root.querySelectorAll('a')].map(
      (a) => (a as El).getAttribute('href') ?? '',
    );
    expect(
      hrefs.some((href) => /^\s*(javascript|data|vbscript):/i.test(href)),
    ).toBe(false);
    expect(hrefs).toContain('https://example.org/issues/2');
    expect(text(root)).toContain('data:text/html,<script>1</script>');
  });

  it('renders markup in every free-text field as text, in every view', async () => {
    const tower = seededTower();
    const payload = '<img src=x onerror="window.__pwned=1"><b>bold</b>';
    const missionId = await createMission(tower, {
      title: payload,
      outcome: payload,
      constraints: [payload],
      definitionOfDone: [{ text: payload, done: false }],
    });
    await addPacket(tower, missionId, payload);
    await enrollRunner(tower, payload);
    await tower.call('POST', '/decisions', {
      dedupeKey: 'xss',
      category: 'scope_expansion',
      urgency: 'normal',
      question: payload,
      recommendation: { alternativeId: 'approve', rationale: payload },
      consequences: payload,
      evidence: [],
      affectedScope: [],
      advisory: { confidencePercent: 80 },
      branches: [{ missionId, packetId: null }],
    });
    const { root, dashboard } = mountFor(tower);

    for (const hash of [
      `#/missions/${missionId}`,
      '#/runners',
      '#/decisions',
      '#/missions',
    ]) {
      await dashboard.show(hash);
      expect(root.querySelector('img'), hash).toBeNull();
      expect(root.querySelector('b'), hash).toBeNull();
    }
    expect(
      (window as unknown as { __pwned?: unknown }).__pwned,
    ).toBeUndefined();
  });

  it('shows the persona tagline from configuration', async () => {
    const tower = seededTower();
    const { root, dashboard } = mountFor(tower);

    await dashboard.show('#/missions');

    expect(root.querySelector('.brand-tagline')?.textContent).toBe(
      PERSONA.tagline,
    );
  });

  it('loads persona text from the file and falls back for empty or non-text values', async () => {
    const original = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        jsonResponse({ name: '   ', tagline: 5 })) as unknown as typeof fetch;
      expect(await loadPersona()).toEqual(DEFAULT_PERSONA);

      globalThis.fetch = (async () =>
        jsonResponse({
          name: '  Pilot Desk  ',
          tagline: 'Hello',
        })) as unknown as typeof fetch;
      expect(await loadPersona()).toEqual({
        name: 'Pilot Desk',
        tagline: 'Hello',
      });

      globalThis.fetch = (async () =>
        jsonResponse({
          name: 'x'.repeat(200),
          tagline: 'y',
        })) as unknown as typeof fetch;
      expect((await loadPersona()).name).toHaveLength(80);

      globalThis.fetch = (async () => {
        throw new TypeError('down');
      }) as unknown as typeof fetch;
      expect(await loadPersona()).toEqual(DEFAULT_PERSONA);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('blocked reasons and views the earlier tests did not reach', () => {
  it('names an open decision that blocks a mission waiting on it', async () => {
    const tower = seededTower();
    const missionId = await createMission(tower);
    const packetId = await addPacket(tower, missionId, 'Draft spec');
    await tower.call('POST', '/decisions', {
      dedupeKey: 'blocks',
      category: 'scope_expansion',
      urgency: 'normal',
      question: 'May it touch billing?',
      recommendation: { alternativeId: 'approve', rationale: 'Low risk.' },
      consequences: 'x',
      evidence: [],
      affectedScope: [],
      advisory: { confidencePercent: 80 },
      branches: [{ missionId, packetId }],
    });
    const { root, dashboard } = mountFor(tower, {
      fetchImpl: overrideGet(tower, `/missions/${missionId}`, (body) => ({
        mission: { ...body.mission, state: 'waiting-decision' },
      })),
    });

    await dashboard.show(`#/missions/${missionId}`);

    expect(root.querySelector('section.blocked')?.textContent).toContain(
      'Waiting for decision: May it touch billing?',
    );
  });

  it('says why a verifying mission is waiting', async () => {
    const tower = seededTower();
    const missionId = await createMission(tower);
    const { root, dashboard } = mountFor(tower, {
      fetchImpl: overrideGet(tower, `/missions/${missionId}`, (body) => ({
        mission: { ...body.mission, state: 'verifying' },
      })),
    });

    await dashboard.show(`#/missions/${missionId}`);

    expect(root.querySelector('section.blocked')?.textContent).toContain(
      'Tower has not verified them yet',
    );
  });

  it('lists a discrepancy that needs attention', async () => {
    const tower = seededTower();
    const missionId = await createMission(tower);
    const { root, dashboard } = mountFor(tower, {
      fetchImpl: overrideGet(
        tower,
        `/missions/${missionId}/issue-links`,
        () => ({
          links: [],
          discrepancies: [
            {
              id: 'dsc_1',
              kind: 'reopened',
              detail: 'Issue reopened',
              requiresAttention: true,
              resolvedAt: null,
              resolution: null,
            },
          ],
        }),
      ),
    });

    await dashboard.show(`#/missions/${missionId}`);

    expect(root.querySelector('section.blocked')?.textContent).toContain(
      'Issue discrepancy (reopened): Issue reopened',
    );
  });

  it('shows a verified dependency as no longer blocking', async () => {
    const tower = seededTower();
    const missionId = await createMission(tower);
    const spec = await addPacket(tower, missionId, 'Draft spec');
    await addPacket(tower, missionId, 'Build it', [spec]);
    const { root, dashboard } = mountFor(tower, {
      fetchImpl: overrideGet(tower, `/missions/${missionId}`, (body) => ({
        mission: {
          ...body.mission,
          packets: body.mission.packets.map((p: Record<string, unknown>) =>
            p.id === spec
              ? {
                  ...p,
                  status: 'verified',
                  verification: {
                    at: '2026-10-31T08:00:00.000Z',
                    by: 'prn_tower',
                    evidenceRefs: [],
                  },
                }
              : p,
          ),
        },
      })),
    });

    await dashboard.show(`#/missions/${missionId}`);

    expect(root.querySelector('section.blocked')).toBeNull();
    const row = ([...root.querySelectorAll('tbody tr')] as El[]).find((tr) =>
      tr.textContent?.includes('Build it'),
    );
    expect(row?.textContent).toContain('—');
    expect(row?.textContent).not.toContain('Waiting on');
  });

  it('labels a Tower-verified packet as verified even when a runner also reported on it', async () => {
    const tower = seededTower();
    const missionId = await createMission(tower);
    const packetId = await addPacket(tower, missionId, 'Verified task');
    const { root, dashboard } = mountFor(tower, {
      fetchImpl: overrideGet(tower, `/missions/${missionId}`, (body) => ({
        mission: {
          ...body.mission,
          packets: body.mission.packets.map((p: Record<string, unknown>) => ({
            ...p,
            status: 'verified',
            verification: {
              at: '2026-10-31T08:00:00.000Z',
              by: 'prn_tower',
              evidenceRefs: [],
            },
          })),
          attempts: [
            {
              id: 'att_v',
              missionId,
              packetId,
              number: 1,
              runnerId: 'prn_runner',
              status: 'self-reported-succeeded',
              dispatchedAt: '2026-10-31T07:00:00.000Z',
              startedAt: null,
              reportedAt: '2026-10-31T07:30:00.000Z',
              report: {
                outcome: 'succeeded',
                summary: 'Done',
                by: 'prn_runner',
              },
            },
          ],
        },
      })),
    });

    await dashboard.show(`#/missions/${missionId}`);

    expect(root.querySelector('[data-evidence="verified"]')?.textContent).toBe(
      'Verified by Tower',
    );
    expect(root.querySelector('[data-evidence="self-reported"]')).toBeNull();
  });

  it('ticks completed definition-of-done items and shows open ones unticked', async () => {
    const tower = seededTower();
    const missionId = await createMission(tower);
    const { root, dashboard } = mountFor(tower, {
      fetchImpl: overrideGet(tower, `/missions/${missionId}`, (body) => ({
        mission: {
          ...body.mission,
          definitionOfDone: [
            { text: 'Smoke test passes', done: true },
            { text: 'Docs updated', done: false },
          ],
        },
      })),
    });

    await dashboard.show(`#/missions/${missionId}`);

    const items = [...root.querySelectorAll('ul.checklist li')] as El[];
    expect(items[0]?.querySelector('.check')?.textContent).toBe('[x]');
    expect(items[0]?.querySelector('.check')?.getAttribute('aria-label')).toBe(
      'done',
    );
    expect(items[1]?.querySelector('.check')?.textContent).toBe('[ ]');
  });

  it('reads read and write scope into their own columns of the sync configuration', async () => {
    const tower = seededTower();
    const { root, dashboard } = mountFor(tower, {
      fetchImpl: overrideGet(tower, '/issues/sync-config', () => ({
        configs: [
          {
            provider: 'github',
            repo: 'favor/app',
            mode: 'observe',
            readScope: true,
            writeScope: false,
            version: 2,
            updatedBy: 'prn_x',
            updatedAt: '2026-10-31T00:00:00.000Z',
          },
        ],
      })),
    });

    await dashboard.show('#/integrations');

    const cells = [...root.querySelectorAll('tbody td')].map(
      (td) => (td as El).textContent,
    );
    expect(cells).toEqual([
      'github',
      'favor/app',
      'observe',
      'allowed',
      'off',
      '2',
    ]);
  });

  it('shows interrupted and fenced leases with their own labels', async () => {
    const tower = seededTower();
    const { root, dashboard } = mountFor(tower, {
      fetchImpl: overrideGet(tower, '/runners/leases', () => ({
        leases: [
          {
            id: 'lse_1',
            packetId: 'pkt_1',
            missionId: 'msn_1',
            runnerId: 'prn_1',
            status: 'recovering',
            expiresAt: '2026-10-31T09:00:00.000Z',
          },
          {
            id: 'lse_2',
            packetId: 'pkt_2',
            missionId: 'msn_1',
            runnerId: 'prn_1',
            status: 'fenced',
            expiresAt: '2026-10-31T09:00:00.000Z',
          },
        ],
      })),
    });

    await dashboard.show('#/runners');

    expect(root.querySelector('[data-state="recovering"]')?.textContent).toBe(
      'Interrupted, recovering',
    );
    expect(root.querySelector('[data-state="fenced"]')?.textContent).toBe(
      'Fenced (stale attempt rejected)',
    );
  });

  it('shows a paused runner with its own label', async () => {
    const tower = seededTower();
    await enrollRunner(tower, 'napping-runner');
    const { root, dashboard } = mountFor(tower, {
      fetchImpl: overrideGet(tower, '/runners', (body) => ({
        runners: body.runners.map((r: Record<string, unknown>) => ({
          ...r,
          status: 'paused',
        })),
      })),
    });

    await dashboard.show('#/runners');

    expect(root.querySelector('[data-state="paused"]')?.textContent).toBe(
      'Paused',
    );
  });

  it('shows the confirmation focused, with its consequence linked by describedby', async () => {
    const tower = seededTower();
    const { root, dashboard } = mountFor(tower);

    await dashboard.show('#/policy');
    await createRule(tower);
    await dashboard.show('#/policy');
    buttonNamed(root, 'Revoke repo.write').click();

    const group = root.querySelector('[role="group"]') as El;
    const describedBy = group.getAttribute('aria-describedby') as string;
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy)?.textContent).toContain(
      'blocked immediately',
    );
    expect(document.activeElement?.textContent).toBe('Cancel');
  });
});

describe('label associations', () => {
  it('ties the token field to its label and help text, and each answer choice to its label', async () => {
    const tower = seededTower();
    const missionId = await createMission(tower);
    const packetId = await addPacket(tower, missionId, 'Draft spec');
    await tower.call('POST', '/decisions', {
      dedupeKey: 'labels',
      category: 'scope_expansion',
      urgency: 'normal',
      question: 'Labelled?',
      recommendation: null,
      consequences: 'x',
      evidence: [],
      affectedScope: [],
      advisory: { confidencePercent: 80 },
      branches: [{ missionId, packetId }],
    });
    const { root, dashboard } = mountFor(tower, {
      storage: memoryStorage(null),
    });

    await dashboard.show('#/missions');
    const token = root.querySelector('input[type="password"]') as El;
    expect(root.querySelector(`label[for="${token.id}"]`)?.textContent).toBe(
      'Access token',
    );
    expect(
      document.getElementById(token.getAttribute('aria-describedby') as string)
        ?.textContent,
    ).toContain('Stored in this browser session only');

    await dashboard.show('#/decisions');
    for (const radio of [
      ...root.querySelectorAll('input[type="radio"]'),
    ] as El[]) {
      expect(
        root.querySelector(`label[for="${radio.id}"]`),
        radio.id,
      ).not.toBeNull();
    }
  });
});

// --- Second self-review: conflicts, notices, and the gaps the re-review named ---

function pendingProposal(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
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
    ...overrides,
  };
}

/** Serves one pending proposal on the policy page and answers every POST with `status`. */
function policyWithProposal(
  tower: Tower,
  proposal: Record<string, unknown>,
  postStatus: number | null,
) {
  return async (path: string, init: RequestInit) => {
    if (init.method === 'POST' && postStatus !== null) {
      return jsonResponse(
        { error: { code: 'x', message: 'Proposal changed' } },
        postStatus,
      );
    }
    if (path === '/policy' && init.method === 'GET') {
      const real = (await (
        await tower.fetchFor(null)(path, init)
      ).json()) as Record<string, unknown>;
      return jsonResponse({ ...real, proposals: [proposal] });
    }
    return tower.fetchFor(null)(path, init);
  };
}

describe('write conflicts and expiry on proposals and rules', () => {
  it('reloads the policy page with a notice when an accept is refused as stale', async () => {
    const tower = seededTower();
    const { root, dashboard } = mountFor(tower, {
      fetchImpl: policyWithProposal(tower, pendingProposal('prp_stale'), 409),
    });

    await dashboard.show('#/policy');
    buttonNamed(root, 'Accept…').click();
    buttonNamed(root, 'Accept proposal').click();

    await vi.waitFor(() =>
      expect(root.querySelector('[role="alert"]')?.textContent).toContain(
        'changed since it was loaded',
      ),
    );
    expect(root.querySelector('[role="group"]')).toBeNull();
    expect(root.querySelector('h1')?.textContent).toBe(
      'Permissions & preferences',
    );
  });

  it('reloads the policy page with a notice when a revoke is refused as stale', async () => {
    const tower = seededTower();
    await createRule(tower);
    const { root, dashboard } = mountFor(tower, {
      fetchImpl: async (path, init) => {
        if (init.method === 'POST') {
          return jsonResponse(
            { error: { code: 'version_conflict', message: 'Rule changed' } },
            409,
          );
        }
        return tower.fetchFor(null)(path, init);
      },
    });

    await dashboard.show('#/policy');
    buttonNamed(root, 'Revoke repo.write').click();
    buttonNamed(root, 'Revoke rule').click();

    await vi.waitFor(() =>
      expect(root.querySelector('[role="alert"]')?.textContent).toContain(
        'changed since it was loaded',
      ),
    );
    expect(root.querySelector('[role="group"]')).toBeNull();
    expect(text(root)).toContain('Policy version');
  });

  it('shows sign-in and clears the token when an accept is rejected as unauthorized', async () => {
    const tower = seededTower();
    const { root, dashboard, storage } = mountFor(tower, {
      fetchImpl: policyWithProposal(tower, pendingProposal('prp_expired'), 401),
    });

    await dashboard.show('#/policy');
    buttonNamed(root, 'Accept…').click();
    buttonNamed(root, 'Accept proposal').click();

    await vi.waitFor(() =>
      expect(root.querySelector('input[type="password"]')).not.toBeNull(),
    );
    expect(storage.getItem(TOKEN_KEY)).toBeNull();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain(
      'Your session token was rejected',
    );
  });

  it('does not repeat a conflict notice on a later visit to the same page', async () => {
    const tower = seededTower();
    const { root, dashboard } = mountFor(tower, {
      fetchImpl: policyWithProposal(tower, pendingProposal('prp_repeat'), 409),
    });

    await dashboard.show('#/policy');
    buttonNamed(root, 'Accept…').click();
    buttonNamed(root, 'Accept proposal').click();
    await vi.waitFor(() =>
      expect(root.querySelector('[role="alert"]')).not.toBeNull(),
    );

    await dashboard.show('#/runners');
    await dashboard.show('#/policy');

    expect(root.querySelector('[role="alert"]')).toBeNull();
  });
});

describe('failure wording and the Cancel button after an error', () => {
  it('says a failed answer may already have been applied when the network dropped', async () => {
    const tower = seededTower();
    const missionId = await createMission(tower);
    const packetId = await addPacket(tower, missionId, 'Draft spec');
    await tower.call('POST', '/decisions', {
      dedupeKey: 'dropped',
      category: 'scope_expansion',
      urgency: 'normal',
      question: 'Dropped?',
      recommendation: { alternativeId: 'approve', rationale: 'Low risk.' },
      consequences: 'x',
      evidence: [],
      affectedScope: [],
      advisory: { confidencePercent: 80 },
      branches: [{ missionId, packetId }],
    });
    const { root, dashboard } = mountFor(tower, {
      fetchImpl: async (path, init) => {
        if (init.method === 'POST') {
          throw new TypeError('fetch failed');
        }
        return tower.fetchFor(null)(path, init);
      },
    });

    await dashboard.show('#/decisions');
    buttonNamed(root, 'Answer…').click();
    buttonNamed(root, 'Confirm answer').click();

    await vi.waitFor(() =>
      expect(
        root.querySelector('[role="group"] [role="alert"]')?.textContent,
      ).toContain('reload before retrying'),
    );
  });

  it('does not talk about writes when a read fails', async () => {
    const tower = seededTower();
    const { root, dashboard } = mountFor(tower, {
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });

    await dashboard.show('#/missions');

    const alert = root.querySelector('[role="alert"]')?.textContent ?? '';
    expect(alert).toContain('Check the connection');
    expect(alert).not.toContain('reload before retrying');
  });

  it('re-enables Cancel and Confirm after a failed answer', async () => {
    const tower = seededTower();
    const missionId = await createMission(tower);
    const packetId = await addPacket(tower, missionId, 'Draft spec');
    await tower.call('POST', '/decisions', {
      dedupeKey: 'retry',
      category: 'scope_expansion',
      urgency: 'normal',
      question: 'Retry me?',
      recommendation: { alternativeId: 'approve', rationale: 'Low risk.' },
      consequences: 'x',
      evidence: [],
      affectedScope: [],
      advisory: { confidencePercent: 80 },
      branches: [{ missionId, packetId }],
    });
    const { root, dashboard } = mountFor(tower, {
      fetchImpl: async (path, init) => {
        if (init.method === 'POST') {
          return jsonResponse(
            {
              error: {
                code: 'internal_error',
                message: 'Internal server error',
              },
            },
            500,
          );
        }
        return tower.fetchFor(null)(path, init);
      },
    });

    await dashboard.show('#/decisions');
    buttonNamed(root, 'Answer…').click();
    buttonNamed(root, 'Confirm answer').click();

    await vi.waitFor(() =>
      expect(
        root.querySelector('[role="group"] [role="alert"]')?.textContent,
      ).toContain('Internal server error'),
    );
    expect(buttonNamed(root, 'Cancel').disabled).toBe(false);
    expect(buttonNamed(root, 'Confirm answer').disabled).toBe(false);
  });
});

describe('every view and every field', () => {
  it('sends the token only as a bearer header on every view', async () => {
    const tower = seededTower();
    const missionId = await createMission(tower);
    const rec = recorder(tower);
    const { dashboard } = mountFor(tower, { fetchImpl: rec.fetchImpl });

    for (const hash of [
      '#/missions',
      `#/missions/${missionId}`,
      '#/runners',
      '#/decisions',
      '#/policy',
      '#/integrations',
      '#/activity',
      '#/health',
    ]) {
      await dashboard.show(hash);
    }

    expect(rec.requests.length).toBeGreaterThan(8);
    for (const { path, init } of rec.requests) {
      expect(path).not.toContain(tower.token);
      expect((init.headers as Record<string, string>).authorization).toBe(
        `Bearer ${tower.token}`,
      );
    }
  });

  it('counts every mission, not just the first page', async () => {
    const tower = seededTower();
    await createMission(tower);
    await createMission(tower);
    const { root, dashboard } = mountFor(tower);

    await dashboard.show('#/health');

    expect(factValue(root, 'Missions')).toBe('2');
  });

  it('renders a runner whose capabilities field is absent', async () => {
    const tower = seededTower();
    await enrollRunner(tower, 'bare-runner');
    const { root, dashboard } = mountFor(tower, {
      fetchImpl: overrideGet(tower, '/runners', (body) => ({
        runners: body.runners.map((r: Record<string, unknown>) => {
          const copy = { ...r };
          delete copy.capabilities;
          return copy;
        }),
      })),
    });

    await dashboard.show('#/runners');

    expect(root.querySelector('[role="alert"]')).toBeNull();
    const row = ([...root.querySelectorAll('tbody tr')] as El[]).find((tr) =>
      tr.textContent?.includes('bare-runner'),
    );
    expect(row?.textContent).toContain('none');
  });

  it('renders markup in policy, integrations and activity as text', async () => {
    const tower = seededTower();
    const payload = '<img src=x onerror="window.__pwned=2"><b>bold</b>';
    const views: [
      string,
      (path: string, init: RequestInit) => Promise<Response>,
    ][] = [
      [
        '#/policy',
        policyWithProposal(
          tower,
          pendingProposal('prp_xss', { action: payload }),
          null,
        ),
      ],
      [
        '#/integrations',
        overrideGet(tower, '/issues/sync-config', () => ({
          configs: [
            {
              provider: 'github',
              repo: payload,
              mode: 'observe',
              readScope: true,
              writeScope: false,
              version: 1,
              updatedBy: 'x',
              updatedAt: '2026-10-31T00:00:00.000Z',
            },
          ],
        })),
      ],
      [
        '#/activity',
        overrideGet(tower, '/runners/audit', () => ({
          records: [
            {
              seq: 1,
              at: '2026-10-31T00:00:00.000Z',
              kind: payload,
              runnerId: null,
              leaseId: null,
              actorId: null,
              detail: {},
            },
          ],
        })),
      ],
    ];
    for (const [hash, fetchImpl] of views) {
      const { root, dashboard } = mountFor(tower, { fetchImpl });
      await dashboard.show(hash);
      expect(root.querySelector('img'), hash).toBeNull();
      expect(root.querySelector('b'), hash).toBeNull();
      expect(text(root), hash).toContain(payload);
    }
    expect(
      (window as unknown as { __pwned?: unknown }).__pwned,
    ).toBeUndefined();
  });

  it('treats a hostile scheme with tabs or newlines inside it as unsafe', async () => {
    const tower = seededTower();
    const missionId = await createMission(tower);
    const hostile = [
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      'data\t:text/html,x',
      'javascript:alert(1)',
    ];
    const { root, dashboard } = mountFor(tower, {
      fetchImpl: overrideGet(
        tower,
        `/missions/${missionId}/issue-links`,
        () => ({
          links: hostile.map((url, i) => ({
            id: `lnk_${i}`,
            url,
            observedState: 'unknown',
            observedSource: null,
            polledAt: null,
          })),
          discrepancies: [],
        }),
      ),
    });

    await dashboard.show(`#/missions/${missionId}`);

    const hrefs = [...root.querySelectorAll('a')].map(
      (a) => (a as El).getAttribute('href') ?? '',
    );
    expect(
      hrefs.some((href) =>
        /^(javascript|data|vbscript):/i.test(
          href.replace(/[\t\n\r]/g, '').trim(),
        ),
      ),
    ).toBe(false);
  });

  it('shows the limits and the action in the decline and accept text', async () => {
    const tower = seededTower();
    const { root, dashboard } = mountFor(tower, {
      fetchImpl: policyWithProposal(tower, pendingProposal('prp_text'), null),
    });

    await dashboard.show('#/policy');
    expect(text(root)).toContain('Limits: no amount cap; all missions.');
    buttonNamed(root, 'Accept…').click();
    expect(root.querySelector('[role="group"]')?.textContent).toContain(
      'repo.read on repo:app',
    );
  });

  it('shows the accept button for a proposal that omits limits, without failing the page', async () => {
    const tower = seededTower();
    const { root, dashboard } = mountFor(tower, {
      fetchImpl: policyWithProposal(
        tower,
        pendingProposal('prp_nolimits', { limits: undefined }),
        null,
      ),
    });

    await dashboard.show('#/policy');

    expect(root.querySelector('[role="alert"]')).toBeNull();
    expect(
      ([...root.querySelectorAll('button')] as El[]).some(
        (b) => b.textContent === 'Accept…',
      ),
    ).toBe(true);
  });
});

// --- Round 3: deterministic notices, single alerts, caps, and the remaining gaps ---

/**
 * A 409 for the decision answer whose body read signals `written`. One macrotask after that,
 * the failed write has finished its catch, so assertions are not racing a timer.
 */
function staleAnswer(tower: Tower) {
  let written: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    written = resolve;
  });
  const fetchImpl = async (path: string, init: RequestInit) => {
    if (init.method === 'POST') {
      return {
        ok: false,
        status: 409,
        text: async () => {
          written();
          return JSON.stringify({
            error: { code: 'version_conflict', message: 'Decision changed' },
          });
        },
      } as unknown as Response;
    }
    return tower.fetchFor(null)(path, init);
  };
  return { fetchImpl, done };
}

async function openQuestion(tower: Tower, question: string) {
  const missionId = await createMission(tower);
  const packetId = await addPacket(tower, missionId, 'Draft spec');
  const res = await tower.call('POST', '/decisions', {
    dedupeKey: question,
    category: 'scope_expansion',
    urgency: 'normal',
    question,
    recommendation: { alternativeId: 'approve', rationale: 'Low risk.' },
    consequences: 'x',
    evidence: [],
    affectedScope: [],
    advisory: { confidencePercent: 80 },
    branches: [{ missionId, packetId }],
  });
  expect(res.status).toBe(201);
}

describe('conflict notices, deterministically', () => {
  it('shows the conflict on the page that raised it', async () => {
    const tower = seededTower();
    await openQuestion(tower, 'Shown here?');
    const { fetchImpl, done } = staleAnswer(tower);
    const { root, dashboard } = mountFor(tower, { fetchImpl });

    await dashboard.show('#/decisions');
    buttonNamed(root, 'Answer…').click();
    buttonNamed(root, 'Confirm answer').click();
    await done;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(root.querySelector('h1')?.textContent).toBe('Decision inbox');
    expect(root.querySelector('[role="alert"]')?.textContent).toContain(
      'changed since it was loaded',
    );
  });

  it('does not show the conflict on a page the user moved to, or on a later visit to the raising page', async () => {
    const tower = seededTower();
    await openQuestion(tower, 'Not here?');
    const { fetchImpl, done } = staleAnswer(tower);
    const { root, dashboard } = mountFor(tower, { fetchImpl });

    await dashboard.show('#/decisions');
    buttonNamed(root, 'Answer…').click();
    buttonNamed(root, 'Confirm answer').click();
    await dashboard.show('#/runners');
    await done;
    await vi.waitFor(() =>
      expect(root.querySelector('h1')?.textContent).toBe('Runner fleet'),
    );
    // The stale write's notice would land after the page settles, so allow a few turns to pass.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(root.querySelector('h1')?.textContent).toBe('Runner fleet');
    expect(root.querySelector('[role="alert"]')).toBeNull();

    await dashboard.show('#/decisions');
    expect(root.querySelector('h1')?.textContent).toBe('Decision inbox');
    expect(root.querySelector('[role="alert"]')).toBeNull();
  });

  it('shows one message, the sign-in one, when an answer is rejected as unauthorized', async () => {
    const tower = seededTower();
    await openQuestion(tower, 'One message?');
    const { root, dashboard } = mountFor(tower, {
      fetchImpl: async (path, init) => {
        if (init.method === 'POST') {
          return jsonResponse(
            {
              error: {
                code: 'unauthenticated',
                message: 'A valid bearer token is required',
              },
            },
            401,
          );
        }
        return tower.fetchFor(null)(path, init);
      },
    });

    await dashboard.show('#/decisions');
    buttonNamed(root, 'Answer…').click();
    buttonNamed(root, 'Confirm answer').click();

    await vi.waitFor(() =>
      expect(root.querySelector('input[type="password"]')).not.toBeNull(),
    );
    expect(root.querySelectorAll('[role="alert"]')).toHaveLength(1);
  });
});

describe('failure wording on proposals, caps, and paths', () => {
  it('says a failed accept may already have been applied when the network dropped', async () => {
    const tower = seededTower();
    const { root, dashboard } = mountFor(tower, {
      fetchImpl: async (path, init) => {
        if (init.method === 'POST') {
          throw new TypeError('fetch failed');
        }
        if (path === '/policy') {
          const real = (await (
            await tower.fetchFor(null)(path, init)
          ).json()) as Record<string, unknown>;
          return jsonResponse({
            ...real,
            proposals: [pendingProposal('prp_net')],
          });
        }
        return tower.fetchFor(null)(path, init);
      },
    });

    await dashboard.show('#/policy');
    buttonNamed(root, 'Accept…').click();
    buttonNamed(root, 'Accept proposal').click();

    await vi.waitFor(() =>
      expect(
        root.querySelector('[role="group"] [role="alert"]')?.textContent,
      ).toContain('reload before retrying'),
    );
  });

  it('says 200 or more open decisions when the list is full, and the exact count below it', async () => {
    const tower = seededTower();
    const full = mountFor(tower, {
      fetchImpl: overrideGet(tower, '/decisions', () => ({
        decisions: Array.from({ length: 200 }, (_, i) => ({ id: `dec_${i}` })),
      })),
    });
    await full.dashboard.show('#/health');
    expect(factValue(full.root, 'Open decisions')).toBe('200 or more');

    const short = mountFor(tower, {
      fetchImpl: overrideGet(tower, '/decisions', () => ({
        decisions: Array.from({ length: 199 }, (_, i) => ({ id: `dec_${i}` })),
      })),
    });
    await short.dashboard.show('#/health');
    expect(factValue(short.root, 'Open decisions')).toBe('199');
  });

  it('says limits were not reported for a proposal without them', async () => {
    const tower = seededTower();
    const { root, dashboard } = mountFor(tower, {
      fetchImpl: policyWithProposal(
        tower,
        pendingProposal('prp_nolim', { limits: undefined }),
        null,
      ),
    });

    await dashboard.show('#/policy');
    buttonNamed(root, 'Accept…').click();

    expect(root.querySelector('[role="group"]')?.textContent).toContain(
      'Limits: not reported. Review before confirming.',
    );
    expect(text(root)).not.toContain('no amount cap');
  });

  it('puts the limits sentence in the accept confirmation itself', async () => {
    const tower = seededTower();
    const { root, dashboard } = mountFor(tower, {
      fetchImpl: policyWithProposal(tower, pendingProposal('prp_limits'), null),
    });

    await dashboard.show('#/policy');
    buttonNamed(root, 'Accept…').click();

    expect(root.querySelector('[role="group"]')?.textContent).toContain(
      'Limits: no amount cap; all missions.',
    );
  });

  it('renders markup in rules and the sync provider as text', async () => {
    const tower = seededTower();
    const payload = '<img src=x onerror="window.__pwned=3"><b>bold</b>';
    await createRule(tower);
    const views: [
      string,
      (path: string, init: RequestInit) => Promise<Response>,
    ][] = [
      [
        '#/policy',
        overrideGet(tower, '/policy', (body) => ({
          ...body,
          rules: body.rules.map((r: Record<string, unknown>) => ({
            ...r,
            action: payload,
          })),
        })),
      ],
      [
        '#/integrations',
        overrideGet(tower, '/issues/sync-config', () => ({
          configs: [
            {
              provider: payload,
              repo: 'favor/app',
              mode: 'observe',
              readScope: true,
              writeScope: false,
              version: 1,
              updatedBy: 'x',
              updatedAt: '2026-10-31T00:00:00.000Z',
            },
          ],
        })),
      ],
    ];
    for (const [hash, fetchImpl] of views) {
      const { root, dashboard } = mountFor(tower, { fetchImpl });
      await dashboard.show(hash);
      expect(root.querySelector('img'), hash).toBeNull();
      expect(root.querySelector('b'), hash).toBeNull();
      expect(text(root), hash).toContain(payload);
    }
  });

  it('shows the hostile schemes as plain text as well as withholding the links', async () => {
    const tower = seededTower();
    const missionId = await createMission(tower);
    const hostile = ['java\tscript:alert(1)', 'javascript:alert(1)'];
    const { root, dashboard } = mountFor(tower, {
      fetchImpl: overrideGet(
        tower,
        `/missions/${missionId}/issue-links`,
        () => ({
          links: hostile.map((url, i) => ({
            id: `lnk_${i}`,
            url,
            observedState: 'unknown',
            observedSource: null,
            polledAt: null,
          })),
          discrepancies: [],
        }),
      ),
    });

    await dashboard.show(`#/missions/${missionId}`);

    // The only link in the content is the back link; no issue link was rendered.
    expect(
      [...root.querySelectorAll('main a')].map((a) => a.getAttribute('href')),
    ).toEqual(['#/missions']);
    for (const url of hostile) {
      expect(text(root)).toContain(url);
    }
  });
});

// --- Authority holds, shown on Mission Detail ---------------------------------

describe('audit view and holds', () => {
  it('does not show the detail of a claim refusal in the audit view', async () => {
    const tower = seededTower();
    const { root, dashboard } = mountFor(tower, {
      fetchImpl: overrideGet(tower, '/runners/audit', () => ({
        records: [
          {
            seq: 1,
            at: '2026-10-31T08:00:00.000Z',
            kind: 'claim.authority_denied',
            runnerId: 'prn_1',
            leaseId: null,
            actorId: null,
            detail: {
              reason: 'SECRET denial reason',
              attemptId: 'att_secret_2',
            },
          },
        ],
      })),
    });

    await dashboard.show('#/activity');

    expect(text(root)).toContain('claim.authority_denied');
    expect(text(root)).not.toContain('SECRET');
    expect(text(root)).not.toContain('att_secret_2');
  });
});

describe('authority holds on Mission Detail', () => {
  it('shows each refusal as its own line, with its packet title, reason and time', async () => {
    const tower = seededTower();
    const { missionId, packetIds } = await seedAuthorityHold(tower);
    const second = await addPacket(tower, missionId, 'Second task');
    const reason = 'authority: policy ref does not name a current rule';
    const holds = [
      {
        attemptId: 'att_first',
        packetId: packetIds[0],
        reason,
        policyVersion: 1,
        at: '2026-10-31T08:12:51.708Z',
      },
      {
        attemptId: 'att_second',
        packetId: second,
        reason,
        policyVersion: 1,
        at: '2026-10-31T09:30:00.000Z',
      },
    ];
    const { root, dashboard } = mountFor(tower, {
      fetchImpl: overrideGet(tower, `/missions/${missionId}`, (body) => ({
        ...body,
        holds,
      })),
    });

    await dashboard.show(`#/missions/${missionId}`);

    const lines = (
      [...root.querySelectorAll('section.blocked li')] as El[]
    ).filter((li) => li.textContent?.includes('does not name a current rule'));
    expect(lines).toHaveLength(2);
    expect(lines[0].textContent?.startsWith('Cited task held (')).toBe(true);
    expect(lines[1].textContent?.startsWith('Second task held (')).toBe(true);
    holds.forEach((hold, i) => {
      expect(lines[i].textContent).toContain(
        new Date(hold.at).toLocaleString(),
      );
      expect(lines[i].textContent).not.toContain('—');
    });
  });

  it('shows the refusal from a real claim on a running mission, with its time from the API', async () => {
    const tower = seededTower();
    const { missionId } = await seedAuthorityHold(tower);
    const hold = (await json(await tower.call('GET', `/missions/${missionId}`)))
      .holds[0] as { at: string };
    const { root, dashboard } = mountFor(tower);

    await dashboard.show(`#/missions/${missionId}`);

    expect(
      root.querySelector('p > .badge[data-state="running"]'),
    ).not.toBeNull();
    const line = (
      [...root.querySelectorAll('section.blocked li')] as El[]
    ).find((li) => li.textContent?.includes('does not name a current rule'));
    expect(line?.textContent).toContain(new Date(hold.at).toLocaleString());
  });
});

// --- Self-review round: skip link, identifiers, writes, drafts, filters -------

// biome-ignore lint/suspicious/noExplicitAny: API JSON is reshaped per test
type Body = Record<string, any>;

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('skip link, identifiers and stale renders', () => {
  it('moves focus to main from the skip link and keeps the current route', async () => {
    const tower = seededTower();
    const { root, dashboard } = mountFor(tower);
    await dashboard.show('#/missions');

    (root.querySelector('.skip') as El).click();
    await settle();

    expect(document.activeElement?.id).toBe('main');
    expect(window.location.hash).not.toBe('#main');
    expect(text(root)).not.toContain('Page not found');
    expect(root.querySelector('h1')?.textContent).toBe('Mission overview');
  });

  it('treats the identifiers . and .. as no mission', async () => {
    const tower = seededTower();
    const { root, dashboard } = mountFor(tower);

    await dashboard.show('#/missions/%2e%2e');

    expect(root.querySelector('h1')?.textContent).toBe('Page not found');
  });

  it('drops a slow render that finishes after the user has moved on', async () => {
    const tower = seededTower();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { root, dashboard } = mountFor(tower, {
      fetchImpl: async (path, init) => {
        if (path.startsWith('/missions') && init.method === 'GET') {
          await gate;
        }
        return tower.fetchFor(null)(path, init);
      },
    });

    const slow = dashboard.show('#/missions');
    await dashboard.show('#/runners');
    expect(root.querySelector('h1')?.textContent).toBe('Runner fleet');
    release();
    await slow;
    await settle();

    expect(root.querySelector('h1')?.textContent).toBe('Runner fleet');
  });
});

describe('writes that fail or repeat', () => {
  it('keeps Confirm off after a network failure, because the write may have applied', async () => {
    const tower = seededTower();
    await createRule(tower);
    const { root, dashboard } = mountFor(tower, {
      fetchImpl: async (path, init) => {
        if (init.method === 'POST') {
          throw new TypeError('Failed to fetch');
        }
        return tower.fetchFor(null)(path, init);
      },
    });
    await dashboard.show('#/policy');

    buttonNamed(root, 'Revoke repo.write').click();
    buttonNamed(root, 'Revoke rule').click();

    await vi.waitFor(() =>
      expect(text(root)).toContain('reload before retrying'),
    );
    expect((buttonNamed(root, 'Revoke rule') as El).disabled).toBe(true);
    expect((buttonNamed(root, 'Cancel') as El).disabled).toBe(false);
  });

  it('sends the bearer token on every write, and Cancel posts nothing', async () => {
    const tower = seededTower();
    await createRule(tower);
    const posts: { path: string; auth: string | undefined }[] = [];
    const { root, dashboard } = mountFor(tower, {
      fetchImpl: async (path, init) => {
        if (init.method === 'POST') {
          const headers = init.headers as Record<string, string>;
          posts.push({ path, auth: headers.authorization });
        }
        return tower.fetchFor(null)(path, init);
      },
    });
    await dashboard.show('#/policy');

    buttonNamed(root, 'Revoke repo.write').click();
    buttonNamed(root, 'Cancel').click();
    await settle();
    expect(posts).toEqual([]);
    expect(buttonNamed(root, 'Revoke repo.write')).toBeTruthy();

    buttonNamed(root, 'Revoke repo.write').click();
    buttonNamed(root, 'Revoke rule').click();
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]?.auth).toBe(`Bearer ${tower.token}`);
  });
});

describe('malformed and partial data', () => {
  it('still renders the Decision Inbox and a mission when a decision lacks alternatives or links', async () => {
    const tower = seededTower();
    const missionId = await createMission(tower);
    const { root, dashboard } = mountFor(tower, {
      fetchImpl: async (path, init) => {
        const res = await tower.fetchFor(null)(path, init);
        if (init.method !== 'GET' || path.split('?')[0] !== '/decisions') {
          return res;
        }
        const body = (await res.json()) as Body;
        return jsonResponse({
          ...body,
          decisions: [
            {
              id: 'dec_bare',
              question: 'Bare decision?',
              urgency: 'normal',
              category: 'scope_expansion',
              requiredAuthority: 'human',
              createdBy: 'chief',
              createdAt: '2026-10-31T00:00:00.000Z',
              version: 1,
            },
            ...body.decisions,
          ],
        });
      },
    });

    await dashboard.show('#/decisions');
    expect(root.querySelector('h1')?.textContent).toBe('Decision inbox');
    expect(text(root)).toContain('Bare decision?');
    expect(root.querySelector('[role="alert"]')).toBeNull();

    await dashboard.show(`#/missions/${missionId}`);
    expect(root.querySelector('[role="alert"]')).toBeNull();
    expect(root.querySelector('h1')?.textContent).not.toBe(
      'Something went wrong',
    );
  });

  it('keeps an unsaved note when the list re-renders', async () => {
    const tower = seededTower();
    await openQuestion(tower, 'Keep my note?');
    const { root, dashboard } = mountFor(tower);
    await dashboard.show('#/decisions');

    const note = root.querySelector('textarea') as El;
    note.value = 'half-written thought';
    note.dispatchEvent(new window.Event('input'));
    await dashboard.show('#/decisions');

    expect((root.querySelector('textarea') as El).value).toBe(
      'half-written thought',
    );
  });

  it('lists only discrepancies that need attention as blockers', async () => {
    const tower = seededTower();
    const missionId = await createMission(tower);
    const { root, dashboard } = mountFor(tower, {
      fetchImpl: overrideGet(
        tower,
        `/missions/${missionId}/issue-links`,
        (body) => ({
          ...body,
          discrepancies: [
            {
              kind: 'state-mismatch',
              detail: 'Needs review here',
              requiresAttention: true,
            },
            {
              kind: 'state-mismatch',
              detail: 'Only a note',
              requiresAttention: false,
            },
          ],
        }),
      ),
    });

    await dashboard.show(`#/missions/${missionId}`);

    const blocked = root.querySelector('section.blocked')?.textContent ?? '';
    expect(blocked).toContain('Needs review here');
    expect(blocked).not.toContain('Only a note');
  });

  it('names only open decisions that block this mission', async () => {
    const tower = seededTower();
    const missionId = await createMission(tower);
    const decision = (question: string, links: unknown[]) => ({
      id: `dec_${question.length}`,
      question,
      urgency: 'normal',
      category: 'scope_expansion',
      requiredAuthority: 'human',
      createdBy: 'chief',
      createdAt: '2026-10-31T00:00:00.000Z',
      version: 1,
      alternatives: [],
      links,
    });
    const { root, dashboard } = mountFor(tower, {
      fetchImpl: async (path, init) => {
        const res = await tower.fetchFor(null)(path, init);
        if (init.method !== 'GET') {
          return res;
        }
        const body = (await res.json()) as Body;
        if (path === `/missions/${missionId}`) {
          return jsonResponse({
            ...body,
            mission: { ...body.mission, state: 'waiting-decision' },
          });
        }
        if (path.split('?')[0] === '/decisions') {
          return jsonResponse({
            ...body,
            decisions: [
              decision('Blocks here?', [{ missionId, status: 'blocked' }]),
              decision('Elsewhere?', [
                { missionId: 'msn_other', status: 'blocked' },
              ]),
              decision('Already answered?', [
                { missionId, status: 'resolved' },
              ]),
            ],
          });
        }
        return jsonResponse(body);
      },
    });

    await dashboard.show(`#/missions/${missionId}`);

    const blocked = root.querySelector('section.blocked')?.textContent ?? '';
    expect(blocked).toContain('Waiting for decision: Blocks here?');
    expect(blocked).not.toContain('Elsewhere?');
    expect(blocked).not.toContain('Already answered?');
  });
});

describe('labels and layout', () => {
  it('labels a held lease as Running', () => {
    expect(LEASE_STATES.held?.label).toBe('Running');
  });

  it('wraps every table in a named, keyboard-reachable scroll region', async () => {
    const tower = seededTower();
    await createMission(tower);
    const { root, dashboard } = mountFor(tower);

    await dashboard.show('#/missions');

    const tables = [...root.querySelectorAll('table')] as El[];
    expect(tables.length).toBeGreaterThan(0);
    for (const table of tables) {
      const wrap = table.parentElement as El;
      expect(wrap.classList.contains('table-wrap')).toBe(true);
      expect(wrap.getAttribute('role')).toBe('region');
      expect(wrap.getAttribute('tabindex')).toBe('0');
      expect(wrap.getAttribute('aria-label')).toBeTruthy();
    }
  });
});
