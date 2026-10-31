import { serve } from '@hono/node-server';

/** The dev host binds to loopback only, so it is never reachable from the LAN by accident. */
export const LOOPBACK_HOST = '127.0.0.1';

type FetchHandler = (request: Request) => Response | Promise<Response>;

export function listenLoopback(
  fetch: FetchHandler,
  port: number,
  onListening?: (info: { port: number }) => void,
  serveFn: typeof serve = serve,
) {
  return serveFn({ fetch, hostname: LOOPBACK_HOST, port }, onListening);
}
