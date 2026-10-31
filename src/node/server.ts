import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { createApi } from '../http/api.ts';
import type { Tower } from '../service/tower.ts';

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

/** Self-hosted Node server: the same API and dashboard as the Worker, backed by local SQLite. */
export function startServer(tower: Tower, opts: { port: number; host?: string; publicDir: string; sweepMs?: number }): { server: Server; stop: () => Promise<void> } {
  const api = createApi(tower);
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (url.pathname.startsWith('/api/') || url.pathname === '/mcp' || url.pathname.startsWith('/webhooks/') || url.pathname === '/healthz') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
        const body = ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : Buffer.concat(chunks);
        const response = await api(new Request(url, { method: req.method ?? 'GET', headers, ...(body ? { body } : {}) }));
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
        return;
      }
      const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^(\.\.[/\\])+/, '');
      const file = join(opts.publicDir, rel);
      if (!file.startsWith(opts.publicDir)) throw Object.assign(new Error('forbidden'), { status: 403 });
      const data = await readFile(file).catch(() => readFile(join(opts.publicDir, 'index.html')));
      res.writeHead(200, {
        'content-type': TYPES[extname(file)] ?? 'text/html; charset=utf-8',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
        'referrer-policy': 'no-referrer',
      });
      res.end(data);
    } catch (err) {
      res.writeHead((err as { status?: number }).status ?? 500, { 'content-type': 'text/plain' });
      res.end('error');
    }
  });
  server.listen(opts.port, opts.host ?? '127.0.0.1');
  const timer = opts.sweepMs ? setInterval(() => void tower.scheduler.sweep().catch((e) => console.error('sweep failed', e)), opts.sweepMs) : null;
  return {
    server,
    stop: () =>
      new Promise((resolve) => {
        if (timer) clearInterval(timer);
        server.close(() => resolve());
      }),
  };
}
