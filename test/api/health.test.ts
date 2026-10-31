import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { openTestDatabase, seedPrincipal } from '../helpers/tower.js';

describe('GET /health', () => {
  it('answers 200 without any credential', async () => {
    const app = createApp({ db: openTestDatabase() });

    const res = await app.request('/health');

    expect(res.status).toBe(200);
  });

  it('returns only a liveness flag, with no workspace or storage detail', async () => {
    const db = openTestDatabase();
    seedPrincipal(db, { kind: 'human', workspaceId: 'ws_secret' });
    const app = createApp({ db });

    const res = await app.request('/health');

    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('ignores credentials, valid or not', async () => {
    const db = openTestDatabase();
    const human = seedPrincipal(db, { kind: 'human' });
    const app = createApp({ db });

    const valid = await app.request('/health', {
      headers: { authorization: `Bearer ${human.token}` },
    });
    const invalid = await app.request('/health', {
      headers: { authorization: 'Bearer nope' },
    });

    expect(valid.status).toBe(200);
    expect(invalid.status).toBe(200);
  });
});
