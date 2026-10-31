import type { RouteSpec } from '../app.js';

// Liveness only. Deliberately returns no version, workspace or storage detail.
export const healthRoute: RouteSpec = {
  method: 'get',
  path: '/health',
  access: { public: true },
  handler: (c) => c.json({ status: 'ok' }),
};
