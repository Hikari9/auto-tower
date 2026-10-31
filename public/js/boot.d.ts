// Types for the browser bootstrap, so TypeScript tests can import the persona loader from public/js/boot.js.

export interface Persona {
  name: string;
  tagline: string;
}

/** Reads persona.json. Missing or malformed values fall back to the defaults. */
export function loadPersona(): Promise<Persona>;

/** Trims and bounds a configured string, or returns the fallback. */
export function textOr(value: unknown, fallback: string): string;
