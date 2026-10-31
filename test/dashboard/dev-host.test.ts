import { describe, expect, it } from 'vitest';
import { startHost } from '../../src/hosting/host.js';
import { tempDbPath } from '../helpers/tower.js';

describe('dev host', () => {
  it('serves the dashboard shell beside the API under the loopback host', async () => {
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
      const base = `http://127.0.0.1:${address.port}`;

      const shell = await fetch(`${base}/dashboard`);
      expect(shell.status).toBe(200);
      expect(await shell.text()).toContain('id="app"');

      const script = await fetch(`${base}/dashboard/js/app.js`);
      expect(script.status).toBe(200);
      expect(script.headers.get('content-type')).toContain('text/javascript');

      expect((await fetch(`${base}/missions`)).status).toBe(401);
    } finally {
      server.close();
    }
  });
});
