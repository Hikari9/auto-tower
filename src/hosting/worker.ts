// Cloudflare Workers entry. The D1-backed SqlDatabase is deferred (see DEFERRED.md),
// so until it lands the API answers every request with 503 and touches no data.
//
// The dashboard is served from the Workers static-assets binding `ASSETS` (wrangler
// `[assets] directory = "public"`). The node:fs reader in src/api/routes/dashboard.ts
// cannot run here, so this entry serves the same files with the same policy.

/** Shell and assets served under /dashboard. Keep in step with DASHBOARD_ASSETS in dashboard.ts. */
export const WORKER_DASHBOARD_FILES: readonly string[] = [
  'index.html',
  'styles.css',
  'persona.json',
  'js/app.js',
  'js/api.js',
  'js/boot.js',
  'js/dom.js',
  'js/status.js',
  'js/views.js',
];

/** Same policy as the Node route. Tests assert both responses carry it. */
export const WORKER_DASHBOARD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export interface WorkerEnv {
  ASSETS?: { fetch(request: Request): Response | Promise<Response> };
}

const DASHBOARD_PATHS = new Map<string, string>([
  // The shell is requested at "/". Workers static assets answer /index.html with a 307 to "/".
  ['/dashboard', ''],
  ['/dashboard/', ''],
  ...WORKER_DASHBOARD_FILES.map(
    (name) => [`/dashboard/${name}`, name] as const,
  ),
]);

function notConfigured(message: string): Response {
  return Response.json(
    { error: { code: 'not_configured', message } },
    { status: 503 },
  );
}

async function serveDashboard(
  request: Request,
  env: WorkerEnv,
  file: string,
): Promise<Response> {
  if (env.ASSETS === undefined) {
    return notConfigured('Dashboard assets are not bound');
  }
  const upstream = await env.ASSETS.fetch(
    new Request(new URL(`/${file}`, request.url)),
  );
  if (!upstream.ok) {
    return Response.json(
      { error: { code: 'not_found', message: 'Route not found' } },
      { status: 404 },
    );
  }
  return new Response(upstream.body, {
    headers: {
      'content-type':
        upstream.headers.get('content-type') ?? 'application/octet-stream',
      'content-security-policy': WORKER_DASHBOARD_CSP,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-cache',
    },
  });
}

export default {
  fetch(request?: Request, env: WorkerEnv = {}): Response | Promise<Response> {
    const pathname = request === undefined ? '' : new URL(request.url).pathname;
    if (
      request?.method === 'GET' &&
      (pathname === '/dashboard' || pathname.startsWith('/dashboard/'))
    ) {
      const file = DASHBOARD_PATHS.get(pathname);
      return file === undefined
        ? Response.json(
            { error: { code: 'not_found', message: 'Route not found' } },
            { status: 404 },
          )
        : serveDashboard(request, env, file);
    }
    return notConfigured('Storage binding is not configured');
  },
};
