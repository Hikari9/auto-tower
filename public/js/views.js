import { ApiError } from './api.js';
import { h, replaceChildren } from './dom.js';
import {
  describe,
  evidenceOf,
  LEASE_STATES,
  MISSION_STATES,
  PACKET_STATES,
  RUNNER_STATES,
  unmetDependencies,
} from './status.js';

/**
 * Each view is `async (ctx, params) => HTMLElement`. `ctx` carries `api`, `persona`,
 * and `refresh()`, which re-runs the current view after a write.
 *
 * @typedef {{
 *   api: { get: (path: string) => Promise<any>, post: (path: string, body?: unknown) => Promise<any>, put: (path: string, body: unknown) => Promise<any> },
 *   persona: { name: string, tagline: string },
 *   refresh: () => Promise<void>,
 *   flash: (message: string) => void,
 * }} Context
 */

const LIST_LIMIT = 100;
let confirmSeq = 0;
/** Unsaved choice and note per decision id. A refresh rebuilds the card, so these carry over. */
const decisionDrafts = new Map();

/** @param {string} id @param {{choice?: string, note?: string}} patch */
function rememberDraft(id, patch) {
  decisionDrafts.set(id, { ...decisionDrafts.get(id), ...patch });
}

/** @param {string} iso */
function when(iso) {
  if (!iso) {
    return '—';
  }
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/** Only http and https links become anchors. Anything else stays plain text. */
function safeHref(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

/** @param {string} text @param {Record<string, string>} [dataset] */
function badge(text, tone, dataset = {}) {
  return h(
    'span',
    { class: `badge tone-${tone}`, dataset: { ...dataset, tone } },
    text,
  );
}

/** @param {Record<string, {label: string, tone: string}>} table @param {string} key */
function stateBadge(table, key) {
  const state = describe(table, key);
  return badge(state.label, state.tone, { state: key });
}

function heading(text, id) {
  return h('h1', { id, tabindex: '-1' }, text);
}

function section(title, ...children) {
  const id = `section-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  return h(
    'section',
    { 'aria-labelledby': id, class: 'panel' },
    h('h2', { id }, title),
    ...children,
  );
}

/** @param {string} caption @param {string[]} columns @param {unknown[][]} rows */
function table(caption, columns, rows) {
  if (rows.length === 0) {
    return h('p', { class: 'empty' }, `No ${caption.toLowerCase()} yet.`);
  }
  return h(
    'div',
    {
      class: 'table-wrap',
      tabindex: '0',
      role: 'region',
      'aria-label': caption,
    },
    h(
      'table',
      null,
      h('caption', null, caption),
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          columns.map((column) => h('th', { scope: 'col' }, column)),
        ),
      ),
      h(
        'tbody',
        null,
        rows.map((cells) =>
          h(
            'tr',
            null,
            cells.map((cell) => h('td', null, cell)),
          ),
        ),
      ),
    ),
  );
}

function missionLink(id, title) {
  return h('a', { href: `#/missions/${encodeURIComponent(id)}` }, title || id);
}

/**
 * A destructive or authority-changing action. Its first click only opens a
 * confirmation group that states the consequence. Nothing is sent until Confirm.
 *
 * @param {{
 *   trigger: string,
 *   question: string,
 *   consequence: string,
 *   confirmLabel: string,
 *   run: () => Promise<unknown>,
 *   ctx: Context,
 * }} options
 */
function confirmAction({
  trigger,
  question,
  consequence,
  confirmLabel,
  run,
  ctx,
}) {
  const slot = h('div', { class: 'confirm-slot' });
  confirmSeq += 1;
  const messageId = `confirm-consequence-${confirmSeq}`;
  const open = h(
    'button',
    {
      type: 'button',
      class: 'secondary',
      onclick: () => {
        const message = h('p', { id: messageId }, consequence);
        const error = h('p', { role: 'alert', class: 'error' });
        const cancel = h(
          'button',
          {
            type: 'button',
            class: 'secondary',
            onclick: () => replaceChildren(slot, open),
          },
          'Cancel',
        );
        const confirm = h(
          'button',
          {
            type: 'button',
            class: 'danger',
            onclick: async () => {
              confirm.disabled = true;
              cancel.disabled = true;
              try {
                await run();
                await ctx.refresh();
              } catch (caught) {
                if (needsReload(caught)) {
                  ctx.flash(describeError(caught));
                  await ctx.refresh();
                  return;
                }
                // Only a server answer proves the write did not happen. After a network failure, Confirm stays off until reload.
                confirm.disabled = !(caught instanceof ApiError);
                cancel.disabled = false;
                error.textContent = describeWriteError(caught);
              }
            },
          },
          confirmLabel,
        );
        const group = h(
          'div',
          {
            class: 'confirm',
            role: 'group',
            'aria-label': question,
            'aria-describedby': message.id,
          },
          h('p', { class: 'confirm-question' }, question),
          message,
          h('div', { class: 'actions' }, confirm, cancel),
          error,
        );
        replaceChildren(slot, group);
        cancel.focus();
      },
    },
    trigger,
  );
  replaceChildren(slot, open);
  return slot;
}

/** @param {unknown} error */
export function describeError(error) {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return 'Your session token was rejected. Enter a valid token.';
    }
    if (error.status === 409) {
      return 'The record changed since it was loaded. The view has been refreshed; review it and try again.';
    }
    if (error.status === 403) {
      return 'This token lacks the scope for this action.';
    }
    return error.message;
  }
  return 'The request failed. Check the connection and try again.';
}

/** Errors from a write. A network failure may still have applied it, so the message says so. */
export function describeWriteError(error) {
  if (error instanceof ApiError) {
    return describeError(error);
  }
  return 'The request failed. Check the connection. The change may already have been applied, so reload before retrying.';
}

/** A rejected token or a stale record is not fixed by retrying here. The view reloads instead. */
function needsReload(error) {
  return (
    error instanceof ApiError && (error.status === 401 || error.status === 409)
  );
}

/** Shared load-and-render wrapper. A failed load becomes an alert, not a blank page. */
async function page(title, load, build) {
  try {
    const body = await load();
    return build(body);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      throw error;
    }
    return h(
      'div',
      null,
      heading(title, 'page-title'),
      h('p', { role: 'alert', class: 'error' }, describeError(error)),
    );
  }
}

// --- Mission Overview ------------------------------------------------------

/** @param {Context} ctx */
export function renderOverview(ctx) {
  return page(
    'Mission overview',
    () => ctx.api.get(`/missions?limit=${LIST_LIMIT}`),
    ({ items, total }) => {
      const counts = new Map();
      for (const item of items) {
        counts.set(item.state, (counts.get(item.state) ?? 0) + 1);
      }
      const summary = [...counts.entries()].map(([state, count]) =>
        h(
          'li',
          null,
          h('span', null, `${describe(MISSION_STATES, state).label}: `),
          h('strong', null, String(count)),
        ),
      );
      return h(
        'div',
        null,
        h('p', { class: 'tagline' }, ctx.persona.tagline),
        heading('Mission overview', 'page-title'),
        section(
          'Status',
          summary.length === 0
            ? h('p', { class: 'empty' }, 'No missions yet.')
            : h(
                'ul',
                { class: 'summary', 'aria-label': 'Missions by state' },
                summary,
              ),
          h('p', null, `Showing ${items.length} of ${total} missions.`),
        ),
        section(
          'Missions',
          table(
            'Missions',
            ['Mission', 'Status', 'Risk', 'Priority', 'Updated'],
            items.map((m) => [
              missionLink(m.id, m.title),
              stateBadge(MISSION_STATES, m.state),
              m.risk,
              m.priority,
              when(m.updatedAt),
            ]),
          ),
        ),
      );
    },
  );
}

// --- Mission Detail --------------------------------------------------------

/** @param {Context} ctx @param {{id: string}} params */
export function renderMission(ctx, params) {
  const id = encodeURIComponent(params.id);
  return page(
    'Mission',
    async () => {
      const [{ mission, holds = [] }, links, activity, decisions] =
        await Promise.all([
          ctx.api.get(`/missions/${id}`),
          ctx.api.get(`/missions/${id}/issue-links`),
          ctx.api.get(`/missions/${id}/activity`),
          ctx.api.get('/decisions?status=open&limit=200'),
        ]);
      return { mission, holds: holds ?? [], links, activity, decisions };
    },
    ({ mission, holds, links, activity, decisions }) => {
      const packetsById = new Map(mission.packets.map((p) => [p.id, p]));
      const attemptsByPacket = new Map(
        mission.attempts.map((a) => [a.packetId, a]),
      );
      const openForMission = decisions.decisions.filter((d) =>
        (d.links ?? []).some(
          (l) => l.missionId === mission.id && l.status === 'blocked',
        ),
      );
      const discrepancies = links.discrepancies ?? [];

      return h(
        'div',
        null,
        h('p', null, h('a', { href: '#/missions' }, 'Back to missions')),
        heading(mission.title, 'page-title'),
        h(
          'p',
          null,
          stateBadge(MISSION_STATES, mission.state),
          ' ',
          h('span', { class: 'meta' }, `Version ${mission.version}`),
        ),
        blockedPanel(
          mission,
          packetsById,
          openForMission,
          discrepancies,
          holds,
        ),
        section(
          'Outcome',
          h(
            'dl',
            { class: 'facts' },
            fact('Outcome', mission.outcome),
            fact('Intent', mission.intent),
            fact('Risk', mission.risk),
            fact('Size', mission.size),
            fact('Priority', mission.priority),
          ),
          (mission.constraints ?? []).length > 0
            ? h(
                'ul',
                { 'aria-label': 'Constraints' },
                (mission.constraints ?? []).map((c) => h('li', null, c)),
              )
            : null,
          h(
            'p',
            null,
            mission.outcomeVerification
              ? badge('Outcome verified by Tower', 'done', {
                  evidence: 'outcome-verified',
                })
              : badge('Outcome not verified by Tower', 'verify', {
                  evidence: 'outcome-unverified',
                }),
          ),
        ),
        section(
          'Definition of done',
          (mission.definitionOfDone ?? []).length === 0
            ? h('p', { class: 'empty' }, 'No criteria recorded.')
            : h(
                'ul',
                { class: 'checklist', 'aria-label': 'Definition of done' },
                (mission.definitionOfDone ?? []).map((item) =>
                  h(
                    'li',
                    null,
                    h(
                      'span',
                      {
                        class: 'check',
                        'aria-label': item.done ? 'done' : 'not done',
                      },
                      item.done ? '[x]' : '[ ]',
                    ),
                    ' ',
                    item.text,
                  ),
                ),
              ),
        ),
        section(
          'Tasks',
          table(
            'Work packets',
            ['Task', 'Status', 'Evidence', 'Depends on', 'Why it waits'],
            mission.packets.map((p) => {
              const evidence = evidenceOf(p, attemptsByPacket.get(p.id));
              const blocked = unmetDependencies(p, packetsById);
              return [
                p.title,
                stateBadge(PACKET_STATES, p.status),
                badge(
                  evidence.label,
                  evidence.kind === 'verified'
                    ? 'done'
                    : evidence.kind === 'self-reported'
                      ? 'verify'
                      : 'neutral',
                  { evidence: evidence.kind },
                ),
                (p.dependsOn ?? []).length === 0
                  ? '—'
                  : (p.dependsOn ?? [])
                      .map((depId) => packetsById.get(depId)?.title ?? depId)
                      .join(', '),
                blocked.length === 0 ? '—' : `Waiting on ${blocked.join(', ')}`,
              ];
            }),
          ),
        ),
        section(
          'Attempts',
          table(
            'Runner attempts',
            ['Attempt', 'Task', 'Runner', 'Status', 'Self-report'],
            mission.attempts.map((a) => [
              `#${a.number}`,
              packetsById.get(a.packetId)?.title ?? a.packetId,
              a.runnerId,
              a.status,
              a.report
                ? `${a.report.outcome} (self-reported): ${a.report.summary ?? 'no summary'}`
                : 'None',
            ]),
          ),
        ),
        section(
          'Issue links',
          linksTable(links.links ?? []),
          discrepancies.length > 0 ? discrepanciesList(discrepancies) : null,
        ),
        section(
          'Evidence',
          (mission.evidenceRefs ?? []).length === 0
            ? h('p', { class: 'empty' }, 'No evidence references recorded.')
            : h(
                'ul',
                { 'aria-label': 'Evidence references' },
                (mission.evidenceRefs ?? []).map((ref) => h('li', null, ref)),
              ),
        ),
        section('Timeline', timeline(activity.items ?? [])),
      );
    },
  );
}

function fact(term, value) {
  return h('div', null, h('dt', null, term), h('dd', null, String(value)));
}

/** One line per authority hold: the packet it refuses, why, and when it was last refused. */
function blockedPanel(
  mission,
  packetsById,
  openDecisions,
  discrepancies,
  holds,
) {
  const reasons = [];
  if (mission.state === 'waiting-runner') {
    reasons.push(
      'No runner has claimed this mission. Nothing is executing and no execution is claimed.',
    );
  }
  if (mission.state === 'waiting-decision') {
    for (const d of openDecisions) {
      reasons.push(`Waiting for decision: ${d.question}`);
    }
  }
  if (mission.state === 'verifying') {
    reasons.push('Runners reported results. Tower has not verified them yet.');
  }
  for (const p of mission.packets) {
    const blocked = unmetDependencies(p, packetsById);
    if (blocked.length > 0) {
      reasons.push(`${p.title} is blocked by ${blocked.join(', ')}`);
    }
  }
  for (const d of discrepancies.filter((x) => x.requiresAttention)) {
    reasons.push(`Issue discrepancy (${d.kind}): ${d.detail}`);
  }
  for (const hold of holds) {
    const title = packetsById.get(hold.packetId)?.title ?? hold.packetId;
    reasons.push(`${title} held (${when(hold.at)}): ${hold.reason}`);
  }
  if (reasons.length === 0) {
    return null;
  }
  return h(
    'section',
    { class: 'panel blocked', 'aria-labelledby': 'blocked-title' },
    h('h2', { id: 'blocked-title' }, 'Why this is blocked'),
    h(
      'ul',
      null,
      reasons.map((r) => h('li', null, r)),
    ),
  );
}

function linksTable(links) {
  return table(
    'Issue links',
    ['Link', 'Observed state', 'Source', 'Last poll'],
    links.map((l) => {
      const href = safeHref(l.url);
      return [
        href
          ? h(
              'a',
              { href, rel: 'noopener noreferrer', target: '_blank' },
              l.url,
            )
          : l.url,
        l.observedState,
        l.observedSource ?? 'not observed',
        when(l.polledAt),
      ];
    }),
  );
}

function discrepanciesList(discrepancies) {
  return h(
    'ul',
    { 'aria-label': 'Issue discrepancies' },
    discrepancies.map((d) =>
      h(
        'li',
        null,
        badge(
          d.resolvedAt
            ? 'Resolved'
            : d.requiresAttention
              ? 'Needs attention'
              : 'Noted',
          d.requiresAttention && !d.resolvedAt ? 'alert' : 'muted',
        ),
        ` ${d.kind}: ${d.detail}`,
      ),
    ),
  );
}

function timeline(items) {
  if (items.length === 0) {
    return h('p', { class: 'empty' }, 'No events yet.');
  }
  return h(
    'ol',
    { class: 'timeline', 'aria-label': 'Mission timeline' },
    items.map((item) =>
      h(
        'li',
        null,
        h('time', { datetime: item.recordedAt }, when(item.recordedAt)),
        ' ',
        h('strong', null, item.type),
        ` by ${item.actorId}, now ${describe(MISSION_STATES, item.stateAfter).label}`,
      ),
    ),
  );
}

// --- Runner Fleet ----------------------------------------------------------

/** @param {Context} ctx */
export function renderRunners(ctx) {
  return page(
    'Runner fleet',
    async () => {
      const [{ runners }, { leases }] = await Promise.all([
        ctx.api.get('/runners'),
        ctx.api.get('/runners/leases'),
      ]);
      return { runners, leases };
    },
    ({ runners, leases }) => {
      const byId = new Map(runners.map((r) => [r.id, r.name]));
      return h(
        'div',
        null,
        heading('Runner fleet', 'page-title'),
        section(
          'Runners',
          table(
            'Runners',
            ['Name', 'Status', 'Last seen', 'Max concurrent', 'Capabilities'],
            runners.map((r) => [
              r.name,
              stateBadge(RUNNER_STATES, r.status),
              when(r.lastSeenAt),
              String(r.maxConcurrent),
              (r.capabilities ?? []).join(', ') || 'none',
            ]),
          ),
        ),
        section(
          'Leases',
          table(
            'Leases',
            ['Task', 'Mission', 'Runner', 'Status', 'Expires'],
            leases.map((l) => [
              l.packetId,
              missionLink(l.missionId, l.missionId),
              byId.get(l.runnerId) ?? l.runnerId,
              stateBadge(LEASE_STATES, l.status),
              when(l.expiresAt),
            ]),
          ),
        ),
      );
    },
  );
}

// --- Decision Inbox --------------------------------------------------------

/** @param {Context} ctx */
export function renderDecisions(ctx) {
  return page(
    'Decision inbox',
    () => ctx.api.get('/decisions?status=open&limit=200'),
    ({ decisions }) =>
      h(
        'div',
        null,
        heading('Decision inbox', 'page-title'),
        decisions.length === 0
          ? h('p', { class: 'empty' }, 'No open decisions.')
          : h(
              'ol',
              { class: 'cards', 'aria-label': 'Open decisions' },
              decisions.map((d) => h('li', null, decisionCard(ctx, d))),
            ),
      ),
  );
}

/** @param {Context} ctx @param {any} decision */
function decisionCard(ctx, decision) {
  const titleId = `decision-${decision.id}`;
  const alternatives = decision.alternatives ?? [];
  const links = decision.links ?? [];
  const draft = decisionDrafts.get(decision.id) ?? {};
  const choice = h('fieldset', null, h('legend', null, 'Choose an answer'));
  for (const alt of alternatives) {
    const radioId = `${titleId}-${alt.id}`;
    choice.append(
      h(
        'div',
        { class: 'radio' },
        h('input', {
          type: 'radio',
          name: `${titleId}-choice`,
          id: radioId,
          value: alt.id,
          checked: alt.id === (draft.choice ?? alternatives[0]?.id),
          onchange: () => rememberDraft(decision.id, { choice: alt.id }),
        }),
        h(
          'label',
          { for: radioId },
          alt.label,
          alt.consequence ? ` (${alt.consequence})` : '',
          alt.resumes ? ' · resumes blocked work' : '',
        ),
      ),
    );
  }
  const note = h('textarea', {
    id: `${titleId}-note`,
    rows: '2',
    maxlength: '2000',
    oninput: () => rememberDraft(decision.id, { note: note.value }),
  });
  note.value = draft.note ?? '';
  const status = h('p', { role: 'status', class: 'meta' });
  const submit = h(
    'button',
    {
      type: 'button',
      onclick: () => {
        const selected = choice.querySelector('input:checked');
        const alt = alternatives.find((a) => a.id === selected?.value);
        if (!alt) {
          status.textContent = 'Choose an answer first.';
          return;
        }
        const resumes = alt.resumes
          ? 'Resumes the blocked branches only. Unrelated work continues.'
          : 'Does not resume the blocked branches.';
        const error = h('p', { role: 'alert', class: 'error' });
        const cancel = cancelButton(() => confirmGroup.remove());
        const confirmGroup = h(
          'div',
          {
            class: 'confirm',
            role: 'group',
            'aria-label': `Confirm answer: ${alt.label}`,
          },
          h('p', null, `Answer "${alt.label}" to: ${decision.question}`),
          h('p', null, resumes),
          h(
            'div',
            { class: 'actions' },
            confirmButton(ctx, decision, alt, note, error, cancel),
            cancel,
          ),
          error,
        );
        card.querySelector('.confirm')?.remove();
        card.append(confirmGroup);
        cancel.focus();
      },
    },
    'Answer…',
  );
  const card = h(
    'article',
    { class: 'card', 'aria-labelledby': titleId },
    h('h2', { id: titleId }, decision.question),
    h(
      'p',
      null,
      badge(
        decision.urgency,
        decision.urgency === 'urgent' || decision.urgency === 'high'
          ? 'alert'
          : 'neutral',
      ),
      ' ',
      badge(decision.category, 'neutral'),
      ' ',
      badge(`Requires ${decision.requiredAuthority}`, 'neutral'),
    ),
    decision.consequences
      ? h('p', null, `Consequences: ${decision.consequences}`)
      : null,
    decision.recommendation
      ? h(
          'p',
          { class: 'meta' },
          `Recommendation: ${decision.recommendation.rationale}`,
        )
      : null,
    decision.request
      ? h(
          'p',
          { class: 'meta' },
          `Would authorize ${decision.request.action} on ${decision.request.resource} (${decision.request.risk} risk)`,
        )
      : null,
    h(
      'p',
      { class: 'meta' },
      `Blocks ${links.filter((l) => l.status === 'blocked').length} branch(es). Requested by ${decision.createdBy} at ${when(decision.createdAt)}.`,
    ),
    h(
      'form',
      {
        onsubmit: (event) => {
          event.preventDefault();
          submit.click();
        },
      },
      choice,
      h('label', { for: note.id }, 'Note (optional)'),
      note,
      h('div', { class: 'actions' }, submit),
      status,
    ),
  );
  return card;
}

/** @param {Context} ctx @param {any} decision @param {any} alt @param {HTMLTextAreaElement} note @param {HTMLElement} error @param {HTMLButtonElement} cancel */
function confirmButton(ctx, decision, alt, note, error, cancel) {
  return h(
    'button',
    {
      type: 'button',
      class: 'danger',
      onclick: async (event) => {
        const button = /** @type {HTMLButtonElement} */ (event.currentTarget);
        button.disabled = true;
        cancel.disabled = true;
        error.textContent = '';
        try {
          await ctx.api.post(
            `/decisions/${encodeURIComponent(decision.id)}/answers`,
            {
              version: decision.version,
              choice: alt.id,
              note: note.value.trim() || null,
            },
          );
          decisionDrafts.delete(decision.id);
          await ctx.refresh();
        } catch (caught) {
          if (needsReload(caught)) {
            ctx.flash(describeError(caught));
            await ctx.refresh();
            return;
          }
          // A network failure may have applied the answer. Keep Confirm off until reload.
          button.disabled = !(caught instanceof ApiError);
          cancel.disabled = false;
          error.textContent = describeWriteError(caught);
        }
      },
    },
    'Confirm answer',
  );
}

/** @param {() => void} onClick */
function cancelButton(onClick) {
  return h(
    'button',
    { type: 'button', class: 'secondary', onclick: onClick },
    'Cancel',
  );
}

// --- Permissions & Preferences ---------------------------------------------

/** @param {Context} ctx */
export function renderPolicy(ctx) {
  return page(
    'Permissions & preferences',
    () => ctx.api.get('/policy'),
    (policy) =>
      h(
        'div',
        null,
        heading('Permissions & preferences', 'page-title'),
        section(
          'Effective policy',
          h(
            'p',
            null,
            `Policy version ${policy.policyVersion}. ${policy.rules.length} active rule(s).`,
          ),
          rulesTable(ctx, policy.rules),
        ),
        section('Preferences', preferencesList(policy.preferences)),
        section('Proposals', proposalsList(ctx, policy.proposals)),
      ),
  );
}

function rulesTable(ctx, rules) {
  return table(
    'Active rules',
    [
      'Effect',
      'Action',
      'Resource',
      'Scope',
      'Max risk',
      'Grantee',
      'Expires',
      'Revoke',
    ],
    rules.map((rule) => [
      rule.effect,
      rule.action,
      rule.resource,
      rule.scope,
      rule.maxRisk,
      rule.grantee?.kind ?? 'any',
      rule.expiresAt ? when(rule.expiresAt) : 'never',
      confirmAction({
        trigger: `Revoke ${rule.action}`,
        question: `Revoke rule for ${rule.action}?`,
        consequence:
          'The next guarded action this rule covers is blocked immediately.',
        confirmLabel: 'Revoke rule',
        run: () =>
          ctx.api.post(`/policy/rules/${encodeURIComponent(rule.id)}/revoke`, {
            expectedVersion: rule.version,
            reason: null,
          }),
        ctx,
      }),
    ]),
  );
}

function preferencesList(preferences) {
  if (preferences.length === 0) {
    return h(
      'p',
      { class: 'empty' },
      'No preferences recorded. Preferences only produce proposals, never grants.',
    );
  }
  return h(
    'dl',
    { class: 'facts' },
    preferences.map((p) => fact(p.key, JSON.stringify(p.value))),
  );
}

function limitsText(limits) {
  if (limits === undefined || limits === null) {
    return 'Limits: not reported. Review before confirming.';
  }
  const { maxAmount = null, missionIds = null } = limits;
  const amount = maxAmount === null ? 'no amount cap' : `up to ${maxAmount}`;
  const missions =
    missionIds === null || missionIds === undefined
      ? 'all missions'
      : `missions ${missionIds.join(', ')}`;
  return `Limits: ${amount}; ${missions}.`;
}

function proposalsList(ctx, proposals) {
  const pending = proposals.filter((p) => p.status === 'pending');
  const note = h(
    'p',
    { class: 'meta' },
    'A proposal authorizes nothing until a person accepts it.',
  );
  if (pending.length === 0) {
    return h(
      'div',
      null,
      note,
      h('p', { class: 'empty' }, 'No pending proposals.'),
    );
  }
  return h(
    'div',
    null,
    note,
    h(
      'ul',
      { class: 'cards', 'aria-label': 'Pending proposals' },
      pending.map((p) =>
        h(
          'li',
          { class: 'card' },
          h(
            'p',
            null,
            `${p.action} on ${p.resource} (${p.maxRisk} risk), suggested after ${p.approvals} approvals`,
          ),
          h(
            'p',
            null,
            `Scope ${p.scope}, grantee ${p.granteeKind}, max risk ${p.maxRisk}. ${limitsText(p.limits)}`,
          ),
          h(
            'div',
            { class: 'actions' },
            confirmAction({
              trigger: 'Accept…',
              question: `Accept proposal for ${p.action}?`,
              consequence: `Creates an active rule: ${p.action} on ${p.resource}, scope ${p.scope}, grantee ${p.granteeKind}, max risk ${p.maxRisk}. ${limitsText(p.limits)}`,
              confirmLabel: 'Accept proposal',
              run: () =>
                ctx.api.post(
                  `/policy/proposals/${encodeURIComponent(p.id)}/accept`,
                  { note: null },
                ),
              ctx,
            }),
            confirmAction({
              trigger: 'Decline…',
              question: `Decline proposal for ${p.action}?`,
              consequence: 'The proposal is closed and no rule is created.',
              confirmLabel: 'Decline proposal',
              run: () =>
                ctx.api.post(
                  `/policy/proposals/${encodeURIComponent(p.id)}/decline`,
                  { note: null },
                ),
              ctx,
            }),
          ),
        ),
      ),
    ),
  );
}

// --- Integrations ----------------------------------------------------------

/** @param {Context} ctx */
export function renderIntegrations(ctx) {
  return page(
    'Integrations',
    () => ctx.api.get('/issues/sync-config'),
    ({ configs }) =>
      h(
        'div',
        null,
        heading('Integrations', 'page-title'),
        section(
          'Issue sync',
          configs.length === 0
            ? h(
                'p',
                { class: 'empty' },
                'No provider configured. Links are stored and nothing is fetched or written (link-only).',
              )
            : table(
                'Issue sync configuration',
                ['Provider', 'Repository', 'Mode', 'Read', 'Write', 'Version'],
                configs.map((c) => [
                  c.provider,
                  c.repo,
                  c.mode,
                  c.readScope ? 'allowed' : 'off',
                  c.writeScope ? 'allowed' : 'off',
                  String(c.version),
                ]),
              ),
        ),
      ),
  );
}

// --- Activity & Audit ------------------------------------------------------

/** @param {Context} ctx */
export function renderActivity(ctx) {
  return page(
    'Activity and audit',
    async () => {
      const [{ records }, history] = await Promise.all([
        ctx.api.get('/runners/audit'),
        ctx.api.get('/policy/history'),
      ]);
      return { records, history: history.items ?? [] };
    },
    ({ records, history }) =>
      h(
        'div',
        null,
        heading('Activity and audit', 'page-title'),
        section(
          'Fleet audit',
          table(
            'Fleet audit records',
            ['At', 'Kind', 'Runner', 'Lease', 'Actor'],
            records.map((r) => [
              when(r.at),
              r.kind,
              r.runnerId ?? '—',
              r.leaseId ?? '—',
              r.actorId ?? '—',
            ]),
          ),
        ),
        section(
          'Policy history',
          table(
            'Policy history',
            ['Version', 'Type', 'Actor', 'Recorded'],
            history.map((e) => [
              String(e.version ?? e.seq ?? '—'),
              e.type,
              e.actorId ?? '—',
              when(e.recordedAt),
            ]),
          ),
        ),
      ),
  );
}

// --- Health ----------------------------------------------------------------

/** @param {Context} ctx */
export function renderHealth(ctx) {
  return page(
    'Health',
    async () => {
      const [health, missions, runners, decisions] = await Promise.all([
        ctx.api.get('/health'),
        ctx.api.get('/missions?limit=1'),
        ctx.api.get('/runners'),
        ctx.api.get('/decisions?status=open&limit=200'),
      ]);
      return { health, missions, runners: runners.runners, decisions };
    },
    ({ health, missions, runners, decisions }) =>
      h(
        'div',
        null,
        heading('Health', 'page-title'),
        section(
          'Service',
          h(
            'dl',
            { class: 'facts' },
            fact('API', health.status),
            fact('Missions', String(missions.total)),
            fact(
              'Open decisions',
              decisions.decisions.length >= 200
                ? '200 or more'
                : String(decisions.decisions.length),
            ),
            fact('Runners', String(runners.length)),
          ),
          h(
            'p',
            { class: 'meta' },
            'Liveness only. The health endpoint returns no workspace or storage detail.',
          ),
        ),
      ),
  );
}

export const VIEWS = {
  missions: renderOverview,
  mission: renderMission,
  runners: renderRunners,
  decisions: renderDecisions,
  policy: renderPolicy,
  integrations: renderIntegrations,
  activity: renderActivity,
  health: renderHealth,
};
