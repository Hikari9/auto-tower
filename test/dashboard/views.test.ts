// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PERSONA,
  mountDashboard,
  TOKEN_KEY,
} from '../../public/js/app.js';
import { loadPersona } from '../../public/js/boot.js';
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
