import type { Context } from 'hono';
import { getPrincipal } from '../../auth/principals.js';
import type { Actor } from '../../core/types.js';
import type { IssueProvider } from '../../issues/index.js';
import type { AppEnv, RouteSpec } from '../app.js';
import { errorBody } from '../errors.js';
import { issuesOf } from './issues.js';

/** Provider webhooks are small. A larger body is refused before it is read. */
const MAX_WEBHOOK_BYTES = 1_000_000;

/**
 * What the host supplies for one workspace's webhook: the signing secret and the provider
 * adapter principal that discrepancies are recorded under. Secrets stay in host configuration,
 * never in Tower's database.
 */
export interface WebhookSettings {
  resolve(
    workspaceId: string,
    provider: string,
  ): { secret: string; actorId: string } | undefined;
}

const unauthorized = (c: Context<AppEnv>): Response =>
  c.json(
    errorBody('invalid_signature', 'The webhook signature is not valid'),
    401,
  );

async function readRaw(c: Context<AppEnv>): Promise<Uint8Array | undefined> {
  const declared = Number(c.req.header('content-length') ?? 0);
  if (declared > MAX_WEBHOOK_BYTES) {
    return undefined;
  }
  const stream = c.req.raw.body;
  if (stream === null) {
    return new Uint8Array();
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > MAX_WEBHOOK_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function codecFor(
  providers: Readonly<Record<string, IssueProvider>> | undefined,
  id: string,
) {
  return providers?.[id]?.webhook;
}

/**
 * The webhook receiver. It is public in the sense that it takes no bearer token, since the
 * signature over the raw body is its authentication. For that reason it is not in `ROUTES`:
 * `createApp` mounts it only when the host supplies `webhooks` settings, so the default public
 * surface stays `/health`.
 */
export const webhookRoutes: readonly RouteSpec[] = [
  {
    method: 'post',
    path: '/webhooks/:provider/:workspaceId',
    access: { public: true },
    handler: async (c) => {
      const deps = c.get('deps');
      const providerId = c.req.param('provider') ?? '';
      const workspaceId = c.req.param('workspaceId') ?? '';
      const settings = deps.webhooks?.resolve(workspaceId, providerId);
      const codec = codecFor(deps.issueProviders, providerId);
      // An unknown workspace, provider or secret answers like a bad signature, so none can be probed.
      if (settings === undefined || codec === undefined) {
        return unauthorized(c);
      }
      const raw = await readRaw(c);
      if (raw === undefined) {
        return c.json(
          errorBody('payload_too_large', 'The request body is too large'),
          413,
        );
      }
      if (!codec.verify(settings.secret, raw, c.req.raw.headers)) {
        return unauthorized(c);
      }
      // Only a verified request may use up a delivery id.
      const deliveryId = codec.deliveryId(c.req.raw.headers);
      if (deliveryId === undefined) {
        return c.json(
          errorBody('missing_delivery_id', 'A delivery id header is required'),
          400,
        );
      }
      let body: unknown;
      try {
        body = JSON.parse(Buffer.from(raw).toString('utf8')) as unknown;
      } catch {
        return c.json(
          errorBody('invalid_json', 'The body is not valid JSON'),
          400,
        );
      }
      const principal = getPrincipal(deps.db, settings.actorId);
      if (
        principal === undefined ||
        principal.workspaceId !== workspaceId ||
        principal.kind !== 'provider_adapter' ||
        principal.disabledAt !== null
      ) {
        // Misconfiguration on the host side. Say nothing about why.
        return c.json(
          errorBody('webhook_unavailable', 'The webhook cannot be processed'),
          503,
        );
      }
      const actor: Actor = { id: principal.id, kind: principal.kind };
      const result = issuesOf(c).handleWebhook({
        workspaceId,
        actor,
        provider: providerId,
        deliveryId,
        event: c.req.header('x-github-event') ?? 'unknown',
        observation: codec.decode(c.req.raw.headers, body),
      });
      return c.json(result);
    },
  },
];
