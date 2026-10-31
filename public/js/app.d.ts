// Types for the browser entry point, so TypeScript tests can import public/js/app.js.
// The implementation is plain browser JavaScript and is not compiled by the repo's tsconfig.

export interface Persona {
  name: string;
  tagline: string;
}

export interface Dashboard {
  show(hash: string): Promise<void>;
  destroy(): void;
}

export const TOKEN_KEY: string;
export const DEFAULT_PERSONA: Persona;

export function resolveRoute(hash: string): {
  route: { path: string; label: string; view: string };
  params: Record<string, string>;
  path: string;
} | null;

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function mountDashboard(options: {
  /** The element the dashboard renders into. Its `ownerDocument` supplies `document` and `window`. */
  root: object;
  fetchImpl?: (path: string, init: RequestInit) => Promise<Response>;
  storage?: KeyValueStorage;
  persona?: Persona;
}): Dashboard;
