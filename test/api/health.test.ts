import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { readHostConfig } from '../../src/hosting/config.js';
import { startHost } from '../../src/hosting/host.js';
import worker from '../../src/hosting/worker.js';
import {
  openTestDatabase,
  seedPrincipal,
  tempDbPath,
} from '../helpers/tower.js';

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

describe('Node host', () => {
  it('binds to loopback and serves /health on the configured port', async () => {
    const server = startHost(
      { TOWER_DB_PATH: tempDbPath(), PORT: '0' },
      () => {},
    );
    try {
      await new Promise<void>((resolve) =>
        server.once('listening', () => resolve()),
      );
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('expected a TCP address');
      }

      expect(address.address).toBe('127.0.0.1');
      const res = await fetch(`http://127.0.0.1:${address.port}/health`);
      expect(await res.json()).toEqual({ status: 'ok' });
    } finally {
      server.close();
    }
  });
});

describe('Workers entry', () => {
  it('answers 503 with no data until the storage binding exists', async () => {
    const res = await worker.fetch();

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: {
        code: 'not_configured',
        message: 'Storage binding is not configured',
      },
    });
  });
});

describe('Node host config', () => {
  it('treats empty environment values as unset', () => {
    expect(readHostConfig({ TOWER_DB_PATH: '', PORT: '' })).toEqual({
      dbPath: '.tower/tower.sqlite',
      port: 8787,
    });
  });

  it('reads explicit values', () => {
    expect(
      readHostConfig({ TOWER_DB_PATH: '/var/tower.sqlite', PORT: '9000' }),
    ).toEqual({
      dbPath: '/var/tower.sqlite',
      port: 9000,
    });
  });
});
