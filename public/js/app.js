import { ApiError, createApiClient } from './api.js';
import { h, replaceChildren } from './dom.js';
import { describeError, VIEWS } from './views.js';

export const TOKEN_KEY = 'tower.dashboard.token';

/** Used when persona.json is missing. Nothing here is personal. */
export const DEFAULT_PERSONA = {
  name: 'Control Tower',
  tagline: 'Missions, runners and decisions in one place.',
};

/** @type {{ path: string, label: string, view: keyof typeof VIEWS, match: RegExp, params?: (m: RegExpMatchArray) => Record<string, string> }[]} */
const ROUTES = [
  {
    path: '/missions',
    label: 'Mission Overview',
    view: 'missions',
    match: /^\/missions$/,
  },
  {
    path: '/runners',
    label: 'Runner Fleet',
    view: 'runners',
    match: /^\/runners$/,
  },
  {
    path: '/decisions',
    label: 'Decision Inbox',
    view: 'decisions',
    match: /^\/decisions$/,
  },
  {
    path: '/policy',
    label: 'Permissions & Preferences',
    view: 'policy',
    match: /^\/policy$/,
  },
  {
    path: '/integrations',
    label: 'Integrations',
    view: 'integrations',
    match: /^\/integrations$/,
  },
  {
    path: '/activity',
    label: 'Activity/Audit',
    view: 'activity',
    match: /^\/activity$/,
  },
  { path: '/health', label: 'Health', view: 'health', match: /^\/health$/ },
  {
    path: '/missions/:id',
    label: 'Mission Overview',
    view: 'mission',
    match: /^\/missions\/([^/]+)$/,
    params: (m) => ({ id: decodeURIComponent(m[1] ?? '') }),
  },
];

/** Reads the route from a hash such as `#/missions/msn_1`. Unknown or empty hashes go to the overview. */
export function resolveRoute(hash) {
  const path =
    String(hash ?? '')
      .replace(/^#/, '')
      .split('?')[0] || '/missions';
  for (const route of ROUTES) {
    const match = path.match(route.match);
    if (match) {
      return { route, params: route.params ? route.params(match) : {}, path };
    }
  }
  return null;
}

/**
 * Mounts the dashboard shell into `root` and renders views on demand. The API
 * client sends the session token as a bearer header. There is no other auth path.
 *
 * @param {{
 *   root: HTMLElement,
 *   fetchImpl?: (path: string, init: RequestInit) => Promise<Response>,
 *   storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
 *   persona?: { name: string, tagline: string },
 * }} options
 */
export function mountDashboard({
  root,
  fetchImpl,
  storage = globalThis.sessionStorage,
  persona = DEFAULT_PERSONA,
}) {
  const api = createApiClient({
    ...(fetchImpl ? { fetchImpl } : {}),
    getToken: () => storage.getItem(TOKEN_KEY),
    onUnauthorized: () => storage.removeItem(TOKEN_KEY),
  });
  const brand = {
    name: persona.name || DEFAULT_PERSONA.name,
    tagline: persona.tagline || DEFAULT_PERSONA.tagline,
  };

  const nav = h(
    'nav',
    { 'aria-label': 'Sections' },
    h(
      'ul',
      { class: 'nav' },
      ROUTES.filter((r) => r.view !== 'mission').map((r) =>
        h(
          'li',
          null,
          h('a', { href: `#${r.path}`, dataset: { view: r.view } }, r.label),
        ),
      ),
    ),
  );
  const main = h('main', { id: 'main', tabindex: '-1' });
  const signOut = h(
    'button',
    { type: 'button', class: 'secondary', onclick: () => signedOut() },
    'Sign out',
  );
  const header = h(
    'header',
    { class: 'site-header' },
    h('a', { class: 'skip', href: '#main' }, 'Skip to content'),
    h(
      'div',
      { class: 'brand' },
      h('strong', { class: 'brand-name' }, brand.name),
      h('span', { class: 'brand-tagline' }, brand.tagline),
    ),
    nav,
    signOut,
  );
  replaceChildren(root, header, main);

  let current = '#/missions';
  let generation = 0;

  /** @param {string} hash */
  async function show(hash) {
    current = hash || current;
    const gen = ++generation;
    const resolved = resolveRoute(current);
    markNav(
      resolved?.route.view === 'mission' ? 'missions' : resolved?.route.view,
    );
    signOut.hidden = !storage.getItem(TOKEN_KEY);
    if (!storage.getItem(TOKEN_KEY)) {
      return renderSignIn(gen);
    }
    if (!resolved) {
      return paint(
        gen,
        h(
          'div',
          null,
          h('h1', { id: 'page-title', tabindex: '-1' }, 'Page not found'),
          h('p', null, 'Choose a section from the menu.'),
        ),
      );
    }
    main.setAttribute('aria-busy', 'true');
    replaceChildren(main, h('p', { role: 'status' }, 'Loading…'));
    try {
      const node = await VIEWS[resolved.route.view](
        { api, persona: brand, refresh: () => show(current) },
        resolved.params,
      );
      return paint(gen, node);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        return renderSignIn(
          gen,
          'Your session token was rejected. Enter a valid token.',
        );
      }
      return paint(
        gen,
        h(
          'div',
          null,
          h('h1', { id: 'page-title', tabindex: '-1' }, 'Something went wrong'),
          h('p', { role: 'alert', class: 'error' }, describeError(error)),
        ),
      );
    }
  }

  /** @param {number} gen @param {Node} node */
  function paint(gen, node) {
    if (gen !== generation) {
      return;
    }
    replaceChildren(main, node);
    main.removeAttribute('aria-busy');
    main.querySelector('h1')?.focus();
  }

  /** @param {string | null} [message] */
  function renderSignIn(gen, message = null) {
    const input = h('input', {
      id: 'token',
      name: 'token',
      type: 'password',
      autocomplete: 'off',
      spellcheck: 'false',
      required: true,
      'aria-describedby': 'token-help',
    });
    const form = h(
      'form',
      {
        onsubmit: (event) => {
          event.preventDefault();
          const value = input.value.trim();
          if (value) {
            storage.setItem(TOKEN_KEY, value);
            show(current);
          }
        },
      },
      h('label', { for: 'token' }, 'Access token'),
      input,
      h(
        'p',
        { id: 'token-help', class: 'meta' },
        'Stored in this browser session only. Use a token issued by `pnpm tower token create`.',
      ),
      h('button', { type: 'submit' }, 'Use token'),
    );
    return paint(
      gen,
      h(
        'div',
        { class: 'panel' },
        h('h1', { id: 'page-title', tabindex: '-1' }, 'Sign in'),
        message ? h('p', { role: 'alert', class: 'error' }, message) : null,
        form,
      ),
    );
  }

  function signedOut() {
    storage.removeItem(TOKEN_KEY);
    show('#/missions');
  }

  /** @param {string | undefined} view */
  function markNav(view) {
    for (const link of nav.querySelectorAll('a')) {
      if (link.dataset.view === view) {
        link.setAttribute('aria-current', 'page');
      } else {
        link.removeAttribute('aria-current');
      }
    }
  }

  const win = root.ownerDocument.defaultView;
  const onHashChange = () => show(win?.location.hash || '#/missions');
  win?.addEventListener('hashchange', onHashChange);

  return {
    /** @param {string} hash */
    show,
    destroy() {
      win?.removeEventListener('hashchange', onHashChange);
    },
  };
}
