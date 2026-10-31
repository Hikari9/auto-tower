import { DEFAULT_PERSONA, mountDashboard } from './app.js';

/** Persona text is data. Missing or malformed values fall back to the defaults. */
async function loadPersona() {
  try {
    const res = await fetch('/dashboard/persona.json', { cache: 'no-store' });
    if (!res.ok) {
      return DEFAULT_PERSONA;
    }
    const raw = await res.json();
    return {
      name: textOr(raw?.name, DEFAULT_PERSONA.name),
      tagline: textOr(raw?.tagline, DEFAULT_PERSONA.tagline),
    };
  } catch {
    return DEFAULT_PERSONA;
  }
}

/** @param {unknown} value @param {string} fallback */
function textOr(value, fallback) {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim().slice(0, 80)
    : fallback;
}

const root = document.getElementById('app');
if (root) {
  const persona = await loadPersona();
  const dashboard = mountDashboard({ root, persona });
  await dashboard.show(window.location.hash || '#/missions');
}
