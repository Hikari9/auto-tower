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
    params: (m) => {
      const id = decodeURIComponent(m[1] ?? '');
      // `.` and `..` survive encodeURIComponent and normalize away in the request path.
      if (id === '.' || id === '..') {
        throw new Error('not a mission id');
      }
      return { id };
    },
  },
];

/**
 * Session storage when the browser grants it. Otherwise an in-memory copy, so the
 * dashboard still works, with the token kept only for this page load.
 */
function sessionTokenStore() {
  try {
    const store = globalThis.sessionStorage;
    store.getItem(TOKEN_KEY);
    return store;
  } catch {
    const memory = new Map();
    return {
      getItem: (/** @type {string} */ key) => memory.get(key) ?? null,
      setItem: (/** @type {string} */ key, /** @type {string} */ value) =>
        memory.set(key, value),
      removeItem: (/** @type {string} */ key) => memory.delete(key),
    };
  }
}

/** Reads the route from a hash such as `#/missions/msn_1`. An empty hash goes to the overview. An unknown path returns null. */
export function resolveRoute(hash) {
  const path =
    String(hash ?? '')
      .replace(/^#/, '')
      .split('?')[0] || '/missions';
  for (const route of ROUTES) {
    const match = path.match(route.match);
    if (match) {
      try {
        return { route, params: route.params ? route.params(match) : {}, path };
      } catch {
        // A malformed percent-encoding in the hash is not a page we can show.
        return null;
      }
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
  storage = sessionTokenStore(),
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
    h(
      'a',
      {
        class: 'skip',
        href: '#main',
        // Focus moves to main. The hash stays put, so the link does not route to "#main".
        onclick: (/** @type {Event} */ event) => {
          event.preventDefault();
          main.focus();
        },
      },
      'Skip to content',
    ),
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
  /** A message to show above the next render, such as a rejected write. */
  /** @type {{ hash: string, message: string } | null} */
  let notice = null;

  /** @param {string} hash */
  async function show(hash) {
    current = hash || current;
    // The view this render belongs to. A write it started reports back to this view only.
    const viewHash = current;
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
        {
          api,
          persona: brand,
          // After navigating away, a finished write must not re-render a different page.
          refresh: () => {
            if (current !== viewHash) {
              notice = null;
              return undefined;
            }
            return show(viewHash);
          },
          flash: (message) => {
            notice = { hash: viewHash, message };
          },
        },
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
    // A notice belongs to the view that raised it. Any render consumes it, so it cannot reappear later.
    const alert =
      notice?.hash === current
        ? h('p', { role: 'alert', class: 'error' }, notice.message)
        : null;
    notice = null;
    replaceChildren(main, alert, node);
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
    win?.history.replaceState(null, '', '#/missions');
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
