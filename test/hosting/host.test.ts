import { describe, expect, it } from 'vitest';
import { startHost } from '../../src/hosting/host.js';
import { tempDbPath } from '../helpers/tower.js';

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
