// Auto Tower dashboard. Plain ES module, no build step. All data is rendered with
// textContent (never innerHTML) because issue text and logs are untrusted.

const main = document.getElementById('main');
const TOKEN_KEY = 'auto-tower-token';
const token = () => sessionStorage.getItem(TOKEN_KEY) ?? localStorage.getItem(TOKEN_KEY);

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const badge = (s, label) => h('span', { class: `badge s-${s}` }, label ?? String(s).replaceAll('_', ' '));
const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
const ago = (iso) => {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};
function toast(msg) {
  const t = h('div', {}, msg);
  document.getElementById('toast').append(t);
  setTimeout(() => t.remove(), 5000);
}

async function api(path, opts = {}) {
  const res = await fetch(`/api/v1${path}`, {
    method: opts.method ?? 'GET',
    headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json', ...(opts.idem ? { 'idempotency-key': opts.idem } : {}) },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) {
    sessionStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_KEY);
    route();
    throw new Error('signed out');
  }
  if (!res.ok) throw new Error(body?.error?.message ?? res.statusText);
  return body;
}
const act = (fn, ok) => async (e) => {
  e?.preventDefault?.();
  try {
    await fn();
    if (ok) toast(ok);
    route();
  } catch (err) {
    toast(`Not done: ${err.message}`);
  }
};
const key = () => crypto.randomUUID();

// ---------- views ----------

function login() {
  const input = h('input', { type: 'password', id: 'tok', autocomplete: 'current-password', required: true });
  const remember = h('input', { type: 'checkbox', id: 'remember' });
  return h(
    'section',
    { class: 'panel narrow' },
    h('h1', {}, 'Tower check-in'),
    h('p', { class: 'sub' }, 'Paste your owner or chief-of-staff token. It stays in this browser.'),
    h(
      'form',
      {
        onsubmit: async (e) => {
          e.preventDefault();
          (remember.checked ? localStorage : sessionStorage).setItem(TOKEN_KEY, input.value.trim());
          try {
            await api('/me');
            route();
          } catch (err) {
            toast(err.message);
          }
        },
      },
      h('label', { for: 'tok' }, 'Token'),
      input,
      h('label', { class: 'row' }, remember, 'Remember on this device'),
      h('p', {}, h('button', { class: 'primary', type: 'submit' }, 'Enter the tower')),
    ),
  );
}

const ACTIVE = ['draft', 'active', 'paused', 'verifying', 'reconciling', 'needs_attention'];

async function overview() {
  const [missions, me] = await Promise.all([api('/missions'), api('/me')]);
  const groups = [
    ['Needs attention', missions.filter((m) => m.state === 'needs_attention')],
    ['In flight', missions.filter((m) => ['active', 'verifying', 'reconciling'].includes(m.state))],
    ['Paused and drafts', missions.filter((m) => ['paused', 'draft'].includes(m.state))],
    ['Completed', missions.filter((m) => m.state === 'completed').slice(0, 20)],
  ];
  return h(
    'section',
    {},
    h('div', { class: 'row spread' }, h('div', {}, h('h1', {}, 'Missions'), h('p', { class: 'sub' }, `Signed in as ${me.principal.name} (${me.principal.kind}) · ${me.workspace.name}`)), h('a', { class: 'btn', href: '#/new' }, 'New mission')),
    groups.map(([title, list]) =>
      list.length
        ? [
            h('h2', {}, `${title} (${list.length})`),
            h(
              'table',
              { class: 'responsive' },
              h('thead', {}, h('tr', {}, ['Mission', 'State', 'Now', 'Progress', 'Next / blocked by', 'Owner', 'Updated'].map((x) => h('th', {}, x)))),
              h(
                'tbody',
                {},
                list.map((m) =>
                  h(
                    'tr',
                    {},
                    h('td', { 'data-label': 'Mission' }, h('a', { href: `#/missions/${m.id}` }, m.title)),
                    h('td', { 'data-label': 'State' }, badge(m.state)),
                    h('td', { 'data-label': 'Now' }, badge(m.activity)),
                    h('td', { 'data-label': 'Progress' }, m.progress.total ? `${m.progress.done}/${m.progress.total} packets` : '—'),
                    h('td', { 'data-label': 'Next' }, m.discrepancies.find((d) => !d.resolvedAt)?.detail ?? m.blockers[0]?.reason ?? '—'),
                    h('td', { 'data-label': 'Owner' }, m.ownerName, h('div', { class: 'muted' }, `priority ${m.priority}`)),
                    h('td', { 'data-label': 'Updated' }, ago(m.updatedAt)),
                  ),
                ),
              ),
            ),
          ]
        : null,
    ),
    missions.length ? null : h('p', { class: 'panel muted' }, 'No missions yet. Create one here or from ChatGPT through the MCP connector.'),
  );
}

function newMission() {
  const f = {};
  const field = (name, label, el) => [h('label', { for: name }, label), (f[name] = el)];
  const lines = (s) => s.split('\n').map((x) => x.trim()).filter(Boolean);
  return h(
    'section',
    { class: 'panel' },
    h('h1', {}, 'New mission'),
    h('p', { class: 'sub' }, 'A mission is a verified outcome. Work runs only on an eligible runner; until then it waits safely.'),
    h(
      'form',
      {
        onsubmit: act(async () => {
          const repo = f.repo.value.trim();
          const m = await api('/missions', {
            method: 'POST',
            idem: key(),
            body: {
              title: f.title.value,
              intent: f.intent.value,
              outcome: f.outcome.value,
              risk: f.risk.value,
              definitionOfDone: lines(f.dod.value),
              constraints: lines(f.constraints.value),
              authority: { actions: lines(f.actions.value), resources: repo ? [`repo:${repo.toLowerCase()}`] : [] },
              packets: f.goal.value.trim() ? [{ title: f.title.value, goal: f.goal.value, ...(repo ? { scope: { repo } } : {}) }] : [],
              links: lines(f.links.value).map((url) => ({ url, role: 'required' })),
              start: f.start.checked,
            },
          });
          location.hash = `#/missions/${m.id}`;
        }, 'Mission created'),
      },
      field('title', 'Title', h('input', { id: 'title', required: true })),
      field('outcome', 'Measurable outcome', h('textarea', { id: 'outcome', required: true })),
      field('intent', 'Why (intent)', h('textarea', { id: 'intent' })),
      field('risk', 'Risk', h('select', { id: 'risk' }, ['low', 'medium', 'high', 'critical'].map((r) => h('option', { value: r, selected: r === 'medium' }, r)))),
      field('dod', 'Definition of done (one per line)', h('textarea', { id: 'dod' })),
      field('constraints', 'Constraints (one per line)', h('textarea', { id: 'constraints' })),
      field('repo', 'Repository (owner/name)', h('input', { id: 'repo', placeholder: 'acme/app' })),
      field('goal', 'First work packet goal', h('textarea', { id: 'goal' })),
      field('actions', 'Authorized actions (one per line, e.g. repo.push, pr.open)', h('textarea', { id: 'actions' }, 'repo.push\npr.open')),
      field('links', 'Required issue URLs (one per line)', h('textarea', { id: 'links' })),
      h('label', { class: 'row' }, (f.start = h('input', { type: 'checkbox', checked: true })), 'Authorize dispatch now'),
      h('p', {}, h('button', { class: 'primary', type: 'submit' }, 'Create mission')),
    ),
  );
}

async function missionDetail(id) {
  const d = await api(`/missions/${id}`);
  const m = d.mission;
  const ctl = (label, path, opts = {}) => h('button', { class: opts.danger ? 'danger' : '', onclick: act(() => api(`/missions/${id}/${path}`, { method: 'POST', body: opts.body ?? {} }), `${label}: done`) }, label);
  const verifyNote = h('input', { placeholder: 'Verification note' });
  const evidence = new Map(d.evidence.map((e) => [e.id, e]));
  return h(
    'section',
    {},
    h('p', {}, h('a', { href: '#/' }, '← Missions')),
    h('div', { class: 'row spread' }, h('h1', {}, m.title), h('div', { class: 'row' }, badge(m.state), badge(m.activity), badge(m.risk, `${m.risk} risk`))),
    h('p', { class: 'sub' }, m.outcome),
    h(
      'div',
      { class: 'row' },
      m.state === 'draft' && ctl('Authorize & start', 'start'),
      ['active', 'verifying'].includes(m.state) && ctl('Pause', 'pause', { body: { reason: 'paused from dashboard' } }),
      ['paused', 'needs_attention'].includes(m.state) && ctl('Resume', 'resume'),
      ['active', 'verifying', 'reconciling', 'needs_attention'].includes(m.state) && ctl('Reconcile now', 'reconcile'),
      !['completed', 'cancelled'].includes(m.state) &&
        h('button', { class: 'danger', onclick: act(async () => confirm('Cancel this mission? Linked issues will not be closed.') && api(`/missions/${id}/cancel`, { method: 'POST', body: { reason: 'cancelled from dashboard' } }), 'Cancelled') }, 'Cancel'),
    ),
    m.state === 'verifying' &&
      h(
        'div',
        { class: 'panel' },
        h('h2', {}, 'Outcome verification'),
        h('p', { class: 'muted' }, 'Pass only if the integrated result achieves the outcome. Missing evidence blocks a pass.'),
        verifyNote,
        h('div', { class: 'row mt' },
          h('button', { class: 'primary', onclick: act(() => api(`/missions/${id}/verify`, { method: 'POST', body: { verdict: 'pass', note: verifyNote.value } }), 'Verified') }, 'Pass'),
          h('button', { class: 'danger', onclick: act(() => api(`/missions/${id}/verify`, { method: 'POST', body: { verdict: 'fail', note: verifyNote.value } }), 'Marked failed') }, 'Fail'),
        ),
      ),
    m.discrepancies.length > 0 && [h('h2', {}, 'Discrepancies'), m.discrepancies.map((x) => h('div', { class: 'discrepancy' }, `${x.kind}: ${x.detail} (${when(x.detectedAt)})`))],
    m.blockers.length > 0 && [h('h2', {}, 'Blocked branches'), m.blockers.map((b) => h('div', { class: 'blocker' }, `${b.kind}: ${b.reason}`))],
    h(
      'div',
      { class: 'grid' },
      h('div', { class: 'panel' }, h('h2', {}, 'Definition of done'), m.dod.length ? m.dod.map((x) => h('div', {}, x.done ? '✓ ' : '○ ', x.text, x.evidenceId ? h('span', { class: 'muted' }, ` (${evidence.get(x.evidenceId)?.verified ? 'verified' : 'self-reported'})`) : '')) : h('p', { class: 'muted' }, 'None set')),
      h(
        'div',
        { class: 'panel' },
        h('h2', {}, 'Authority envelope'),
        h('dl', { class: 'kv' }, h('dt', {}, 'Actions'), h('dd', {}, m.authority.actions.join(', ') || '—'), h('dt', {}, 'Resources'), h('dd', {}, m.authority.resources.join(', ') || '—'), h('dt', {}, 'Policy ref'), h('dd', {}, `v${m.policyVersionRef}`)),
      ),
      h(
        'div',
        { class: 'panel' },
        h('h2', {}, 'Verification'),
        m.verification
          ? h('dl', { class: 'kv' }, h('dt', {}, 'Verdict'), h('dd', {}, badge(m.verification.verdict === 'pass' ? 'verified' : 'bad', m.verification.verdict)), h('dt', {}, 'By'), h('dd', {}, `${m.verification.byKind} ${m.verification.by}`), h('dt', {}, 'Note'), h('dd', {}, m.verification.note ?? '—'))
          : h('p', { class: 'muted' }, 'Not verified yet'),
      ),
    ),
    h('h2', {}, 'Work packets'),
    h(
      'table',
      { class: 'responsive' },
      h('thead', {}, h('tr', {}, ['Packet', 'State', 'Scope', 'Attempts', 'Gate', ''].map((x) => h('th', {}, x)))),
      h(
        'tbody',
        {},
        d.packets.map((p) =>
          h(
            'tr',
            {},
            h('td', { 'data-label': 'Packet' }, p.title, p.kind === 'integration' ? h('span', { class: 'muted' }, ' (integration)') : '', p.origin !== 'planned' ? h('span', { class: 'muted' }, ` (${p.origin})`) : ''),
            h('td', { 'data-label': 'State' }, badge(p.state), p.holdReason ? h('div', { class: 'muted' }, p.holdReason) : ''),
            h('td', { 'data-label': 'Scope' }, p.execScope),
            h('td', { 'data-label': 'Attempts' }, `${p.attemptsCount}/${p.maxAttempts}`),
            h('td', { 'data-label': 'Gate' }, p.gate ? (p.gate.passed ? badge('verified', 'verified') : h('span', {}, badge('bad', 'gate failed'), h('div', { class: 'muted' }, p.gate.reasons.join('; ')))) : p.state === 'done' ? '' : h('span', { class: 'muted' }, '—')),
            h(
              'td',
              {},
              ['failed', 'review_pending'].includes(p.state) && h('button', { onclick: act(() => api(`/packets/${p.id}/retry`, { method: 'POST', body: {} }), 'Retry queued') }, 'Retry'),
              ['ready', 'pending', 'running', 'leased', 'held'].includes(p.state) && h('button', { onclick: act(() => api(`/packets/${p.id}/pause`, { method: 'POST', body: {} }), 'Paused') }, 'Pause'),
              p.state === 'paused' && h('button', { onclick: act(() => api(`/packets/${p.id}/resume`, { method: 'POST', body: {} }), 'Resumed') }, 'Resume'),
            ),
          ),
        ),
      ),
    ),
    h('h2', {}, 'Linked issues'),
    d.links.length
      ? h(
          'table',
          { class: 'responsive' },
          h('thead', {}, h('tr', {}, ['Issue', 'Role', 'Observed', 'Source', ''].map((x) => h('th', {}, x)))),
          h(
            'tbody',
            {},
            d.links.map((l) =>
              h(
                'tr',
                {},
                h('td', { 'data-label': 'Issue' }, h('a', { href: l.url, rel: 'noopener noreferrer', target: '_blank' }, l.titleSnapshot ?? l.url), l.lastError ? h('div', { class: 's-bad' }, l.lastError) : ''),
                h('td', { 'data-label': 'Role' }, l.role, l.exemption ? h('div', { class: 'muted' }, `exempt: ${l.exemption.reason}`) : ''),
                h('td', { 'data-label': 'Observed' }, badge(l.observedState), h('div', { class: 'muted' }, ago(l.observedAt))),
                h('td', { 'data-label': 'Source' }, l.observedSource ?? l.provider),
                h(
                  'td',
                  {},
                  l.role === 'required' && l.observedState !== 'closed' && !l.exemption && [
                    h('button', { onclick: act(() => api(`/links/${l.id}/attest`, { method: 'POST', body: { state: 'closed', note: 'attested from dashboard' } }), 'Attested closed') }, 'I confirm it is closed'),
                    h('button', { onclick: act(async () => { const r = prompt('Exemption reason'); if (r) await api(`/links/${l.id}/exempt`, { method: 'POST', body: { reason: r } }); }, 'Exempted') }, 'Exempt'),
                  ],
                ),
              ),
            ),
          ),
        )
      : h('p', { class: 'muted' }, 'No linked issues.'),
    h('h2', {}, 'Evidence'),
    d.evidence.length
      ? h('table', { class: 'responsive' }, h('tbody', {}, d.evidence.map((e) => h('tr', {}, h('td', {}, badge(e.verified ? 'verified' : 'self', e.verified ? 'verified' : 'self-reported')), h('td', {}, e.kind), h('td', {}, e.summary, e.sha ? h('div', { class: 'muted' }, e.sha) : ''), h('td', {}, when(e.createdAt))))))
      : h('p', { class: 'muted' }, 'No evidence yet.'),
    d.children.length > 0 && [h('h2', {}, 'Child missions'), d.children.map((c) => h('div', {}, h('a', { href: `#/missions/${c.id}` }, c.title), ' ', badge(c.state)))],
    h('h2', {}, 'Timeline'),
    timeline(d.events),
  );
}

function timeline(events) {
  return h(
    'table',
    { class: 'responsive' },
    h('thead', {}, h('tr', {}, ['When', 'Event', 'Actor', 'Policy', 'Correlation'].map((x) => h('th', {}, x)))),
    h(
      'tbody',
      {},
      events.map((e) =>
        h(
          'tr',
          {},
          h('td', { 'data-label': 'When' }, when(e.createdAt)),
          h('td', { 'data-label': 'Event' }, e.type, h('div', { class: 'muted' }, `${e.streamType}/${e.streamId} v${e.streamVersion}`)),
          h('td', { 'data-label': 'Actor' }, `${e.actorKind}`, h('div', { class: 'muted' }, e.actorId)),
          h('td', { 'data-label': 'Policy' }, e.policy ? `${e.policy.allowed ? 'allowed' : 'denied'} (${e.policy.basis}, v${e.policy.policyVersion})` : ''),
          h('td', { 'data-label': 'Correlation' }, h('span', { class: 'muted' }, e.correlationId)),
        ),
      ),
    ),
  );
}

async function inbox() {
  const [open, me] = await Promise.all([api('/decisions?status=open'), api('/me')]);
  const isHuman = me.principal.kind === 'human';
  const card = (d) => {
    const note = h('input', { placeholder: 'Note (optional)' });
    return h(
      'article',
      { class: `panel decision ${d.urgency === 'urgent' ? 'urgent' : ''}` },
      h('div', { class: 'row spread' }, h('strong', {}, d.question), h('div', { class: 'row' }, badge(d.urgency), badge(d.category), d.audience === 'chief' ? badge('wait', 'for chief of staff') : null)),
      d.recommendation && h('p', {}, h('strong', {}, 'Recommendation: '), d.recommendation.rationale),
      d.consequences && h('p', { class: 'muted' }, d.consequences),
      h('dl', { class: 'kv' },
        h('dt', {}, 'Authority needed'), h('dd', {}, `${d.requiredAuthority.action} on ${d.requiredAuthority.resource} (${d.requiredAuthority.risk})`),
        h('dt', {}, 'Mission'), h('dd', {}, h('a', { href: `#/missions/${d.missionId}` }, d.missionId)),
        h('dt', {}, 'Blocks'), h('dd', {}, d.linkedPackets.length ? `${d.linkedPackets.length} branch(es); everything else keeps running` : 'nothing'),
        h('dt', {}, 'Raised'), h('dd', {}, ago(d.createdAt)),
      ),
      d.alternatives.length > 2 && h('ul', {}, d.alternatives.map((a) => h('li', {}, a.label, a.consequence ? h('span', { class: 'muted' }, ` — ${a.consequence}`) : ''))),
      (isHuman || d.audience === 'chief') &&
        h('div', { class: 'row' }, note,
          h('button', { class: 'primary', onclick: act(() => api(`/decisions/${d.id}/answer`, { method: 'POST', idem: key(), body: { approved: true, note: note.value } }), 'Approved; affected branches resume') }, 'Approve'),
          h('button', { onclick: act(() => api(`/decisions/${d.id}/answer`, { method: 'POST', idem: key(), body: { approved: false, note: note.value } }), 'Declined') }, 'Decline'),
        ),
    );
  };
  const mine = open.filter((d) => d.audience === 'human');
  const chief = open.filter((d) => d.audience === 'chief');
  return h(
    'section',
    {},
    h('h1', {}, 'Decision Inbox'),
    h('p', { class: 'sub' }, 'Only real executive choices land here. Silence never approves anything; unrelated work keeps running.'),
    mine.length ? mine.map(card) : h('p', { class: 'panel muted' }, 'Nothing needs you. The tower is quiet.'),
    chief.length > 0 && [h('h2', {}, 'With the Chief of Staff'), chief.map(card)],
  );
}

async function fleet() {
  const [runners, me] = await Promise.all([api('/runners'), api('/me')]);
  return h(
    'section',
    {},
    h('h1', {}, 'Runner fleet'),
    h('p', { class: 'sub' }, 'Computers connect outbound and claim authorized work. Online means reachable, not proof of work.'),
    runners.length === 0 && h('p', { class: 'panel muted' }, 'No runners yet. Issue a runner token and start `tower-runner` on a machine.'),
    h(
      'div',
      { class: 'grid' },
      runners.map((r) =>
        h(
          'div',
          { class: 'panel' },
          h('div', { class: 'row spread' }, h('strong', {}, r.name), badge(r.status)),
          h('dl', { class: 'kv' },
            h('dt', {}, 'Last seen'), h('dd', {}, ago(r.lastSeenAt)),
            h('dt', {}, 'Engines'), h('dd', {}, r.engines.join(', ')),
            h('dt', {}, 'Capacity'), h('dd', {}, `${r.attempts.filter((a) => a.state !== 'lost').length}/${r.maxConcurrency}`),
            h('dt', {}, 'Platform'), h('dd', {}, `${r.platform ?? '?'} · v${r.clientVersion ?? '?'}`),
            r.capabilities.length > 0 && [h('dt', {}, 'Capabilities'), h('dd', {}, r.capabilities.join(', '))],
            r.quarantineReason && [h('dt', {}, 'Quarantine'), h('dd', {}, r.quarantineReason)],
          ),
          r.attempts.map((a) => h('div', { class: 'blocker' }, h('a', { href: `#/missions/${a.missionId}` }, a.packetId), ' ', badge(a.state), a.phase ? ` · ${a.phase}` : '')),
          me.principal.kind === 'human' &&
            h('div', { class: 'row mt' },
              r.status === 'quarantined'
                ? h('button', { onclick: act(() => api(`/runners/${r.id}/release`, { method: 'POST', body: {} }), 'Released') }, 'Release')
                : h('button', { class: 'danger', onclick: act(async () => { const reason = prompt('Why quarantine this runner?'); if (reason) await api(`/runners/${r.id}/quarantine`, { method: 'POST', body: { reason } }); }, 'Quarantined; its attempts are fenced') }, 'Quarantine'),
            ),
        ),
      ),
    ),
  );
}

async function policy() {
  const [p, me] = await Promise.all([api('/policy'), api('/me')]);
  const isHuman = me.principal.kind === 'human';
  const g = {};
  return h(
    'section',
    {},
    h('h1', {}, 'Permissions & preferences'),
    h('p', { class: 'sub' }, `Policy version ${p.policyVersion}. Default deny. Explicit deny wins. Preferences are signals and never grant anything.`),
    h('h2', {}, 'Rules'),
    p.rules.length
      ? h(
          'table',
          { class: 'responsive' },
          h('thead', {}, h('tr', {}, ['Effect', 'Action', 'Resource', 'Grantee', 'Conditions', 'Uses', 'Status', ''].map((x) => h('th', {}, x)))),
          h(
            'tbody',
            {},
            p.rules.map((r) =>
              h(
                'tr',
                {},
                h('td', { 'data-label': 'Effect' }, badge(r.effect === 'deny' ? 'bad' : 'active-rule', r.effect)),
                h('td', { 'data-label': 'Action' }, r.action),
                h('td', { 'data-label': 'Resource' }, r.resource),
                h('td', { 'data-label': 'Grantee' }, r.grantee),
                h('td', { 'data-label': 'Conditions' }, JSON.stringify(r.conditions), r.expiresAt ? h('div', { class: 'muted' }, `expires ${when(r.expiresAt)}`) : ''),
                h('td', { 'data-label': 'Uses' }, r.uses),
                h('td', { 'data-label': 'Status' }, r.effective ? badge('active-rule', `active (v${r.createdPolicyVersion})`) : badge('cancelled', r.status)),
                h('td', {}, isHuman && r.status === 'active' && h('button', { class: 'danger', onclick: act(() => api(`/policy/rules/${r.id}/revoke`, { method: 'POST', body: { reason: 'revoked from dashboard' } }), 'Revoked; applies to the next guarded effect') }, 'Revoke')),
              ),
            ),
          ),
        )
      : h('p', { class: 'muted panel' }, 'No standing rules. Everything outside mission envelopes goes to a decision.'),
    isHuman &&
      h(
        'form',
        {
          class: 'panel',
          onsubmit: act(
            () =>
              api('/policy/rules', {
                method: 'POST',
                idem: key(),
                body: { effect: g.effect.value, action: g.action.value, resource: g.resource.value, grantee: g.grantee.value, conditions: g.maxRisk.value ? { maxRisk: g.maxRisk.value } : {}, ...(g.expires.value ? { expiresAt: new Date(g.expires.value).toISOString() } : {}), note: g.note.value },
              }),
            'Rule saved',
          ),
        },
        h('h2', {}, 'Grant or deny'),
        h('label', {}, 'Effect'), (g.effect = h('select', {}, h('option', { value: 'allow' }, 'allow'), h('option', { value: 'deny' }, 'deny'))),
        h('label', {}, 'Action (e.g. deploy.preview)'), (g.action = h('input', { required: true })),
        h('label', {}, 'Resource pattern (e.g. env:preview/*)'), (g.resource = h('input', { required: true })),
        h('label', {}, 'Grantee'), (g.grantee = h('select', {}, ['chief', 'runner', 'tower', 'any'].map((x) => h('option', { value: x }, x)))),
        h('label', {}, 'Max risk'), (g.maxRisk = h('select', {}, h('option', { value: '' }, 'any'), ['low', 'medium', 'high'].map((x) => h('option', { value: x }, x)))),
        h('label', {}, 'Expires'), (g.expires = h('input', { type: 'datetime-local' })),
        h('label', {}, 'Note'), (g.note = h('input', {})),
        h('p', {}, h('button', { class: 'primary', type: 'submit' }, 'Save rule')),
      ),
    h('h2', {}, 'Suggested standing rules'),
    p.proposals.filter((x) => x.status === 'pending').length
      ? p.proposals.filter((x) => x.status === 'pending').map((x) =>
          h('div', { class: 'panel' }, h('p', {}, x.proposed.note || `${x.proposed.action} on ${x.proposed.resource}`), h('p', { class: 'muted' }, `${x.proposed.grantee} · ${JSON.stringify(x.proposed.conditions)}`),
            isHuman && h('div', { class: 'row' },
              h('button', { class: 'primary', onclick: act(() => api(`/policy/proposals/${x.id}/accept`, { method: 'POST', body: {} }), 'Rule created') }, 'Accept'),
              h('button', { onclick: act(async () => { const resource = prompt('Narrow the resource pattern', x.proposed.resource); if (resource) await api(`/policy/proposals/${x.id}/accept`, { method: 'POST', body: { resource } }); }, 'Narrowed rule created') }, 'Narrow'),
              h('button', { onclick: act(() => api(`/policy/proposals/${x.id}/decline`, { method: 'POST', body: {} }), 'Declined') }, 'Decline'),
            )))
      : h('p', { class: 'muted' }, 'No suggestions.'),
    h('h2', {}, 'Observed preferences (non-authoritative)'),
    p.preferences.length ? h('pre', {}, p.preferences.map((x) => `${x.key}  ×${x.observedCount}`).join('\n')) : h('p', { class: 'muted' }, 'None yet.'),
  );
}

async function integrations() {
  const list = await api('/integrations');
  const gh = list.find((x) => x.provider === 'github');
  const f = {};
  return h(
    'section',
    {},
    h('h1', {}, 'Integrations'),
    h('p', { class: 'sub' }, 'Plain issue links work with no integration. GitHub sync is opt-in, per repository, with explicit read/write.'),
    h(
      'form',
      {
        class: 'panel',
        onsubmit: act(() => api('/integrations/github', { method: 'PUT', body: { enabled: f.enabled.checked, config: { syncMode: f.mode.value, repos: JSON.parse(f.repos.value || '[]'), tokenSecret: f.tokenSecret.value, webhookSecret: f.webhookSecret.value } } }), 'GitHub integration saved'),
      },
      h('h2', {}, 'GitHub'),
      h('label', { class: 'row' }, (f.enabled = h('input', { type: 'checkbox', checked: gh?.enabled ?? false })), 'Enabled'),
      h('label', {}, 'Sync mode'),
      (f.mode = h('select', {}, ['link', 'observe', 'bidirectional'].map((x) => h('option', { value: x, selected: gh?.config?.syncMode === x }, x)))),
      h('label', {}, 'Repositories (JSON)'),
      (f.repos = h('textarea', {}, JSON.stringify(gh?.config?.repos ?? [{ repo: 'owner/name', read: true, write: false }], null, 2))),
      h('label', {}, 'Token secret name (the value lives in your host secret store)'),
      (f.tokenSecret = h('input', { value: gh?.config?.tokenSecret ?? 'GITHUB_TOKEN' })),
      h('label', {}, 'Webhook secret name'),
      (f.webhookSecret = h('input', { value: gh?.config?.webhookSecret ?? 'GITHUB_WEBHOOK_SECRET' })),
      h('p', {}, h('button', { class: 'primary', type: 'submit' }, 'Save')),
    ),
  );
}

async function activity() {
  return h('section', {}, h('h1', {}, 'Activity & audit'), h('p', { class: 'sub' }, 'Append-only event history: who, what, which policy version, which correlation id.'), timeline(await api('/activity?limit=200')));
}

async function health() {
  const x = await api('/health');
  return h(
    'section',
    {},
    h('h1', {}, 'Health'),
    h('div', { class: 'panel' }, x.signals.length ? x.signals.map((s) => h('div', { class: 'blocker' }, s)) : h('p', {}, 'All quiet. No signals.')),
    h('div', { class: 'grid' },
      [['Missions', x.missions], ['Packets', x.packets], ['Runners', x.runners], ['Open decisions', x.openDecisions], ['Cloud AI (off by default)', x.cloudAi]].map(([t, v]) => h('div', { class: 'panel' }, h('h2', {}, t), h('pre', {}, JSON.stringify(v, null, 2)))),
    ),
    h('div', { class: 'panel' }, h('h2', {}, 'Scheduler'), h('pre', {}, JSON.stringify(x.scheduler, null, 2))),
    x.providerErrors.length > 0 && h('div', { class: 'panel' }, h('h2', {}, 'Provider errors'), h('pre', {}, JSON.stringify(x.providerErrors, null, 2))),
  );
}

// ---------- router ----------

async function refreshChrome() {
  try {
    const [open, hl] = await Promise.all([api('/decisions?status=open&audience=human'), api('/health')]);
    const pill = document.getElementById('inbox-count');
    pill.hidden = open.length === 0;
    pill.textContent = String(open.length);
    document.getElementById('tower-status').textContent = hl.halted ? 'Emergency halt active' : hl.signals[0] ?? 'All quiet';
    document.querySelector('.beacon').classList.toggle('alert', hl.halted || !hl.ok);
  } catch {
    /* chrome is best effort */
  }
}

async function route() {
  const hash = location.hash || '#/';
  for (const a of document.querySelectorAll('nav a')) a.toggleAttribute('aria-current', a.getAttribute('href') === hash.split('/').slice(0, 2).join('/') || (hash === '#/' && a.getAttribute('href') === '#/'));
  for (const a of document.querySelectorAll('nav a[aria-current]')) a.setAttribute('aria-current', 'page');
  if (!token()) {
    main.replaceChildren(login());
    return;
  }
  const [, view, id] = hash.split('/');
  const views = { '': overview, new: newMission, missions: () => missionDetail(id), inbox, fleet, policy, integrations, activity, health };
  try {
    main.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
    main.replaceChildren(await (views[view ?? ''] ?? overview)());
  } catch (err) {
    if (err.message !== 'signed out') main.replaceChildren(h('p', { class: 'panel s-bad' }, `Could not load: ${err.message}`));
  }
  refreshChrome();
}

window.addEventListener('hashchange', route);
setInterval(() => {
  if (token() && !document.querySelector('main form, main input:focus')) route();
}, 30_000);
route();
