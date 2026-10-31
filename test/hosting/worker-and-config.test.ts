import { describe, expect, it } from 'vitest';
import { readHostConfig } from '../../src/hosting/config.js';
import worker from '../../src/hosting/worker.js';

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
