import {
  protectedResourceMetadata,
  RESOURCE_METADATA_PATH,
  type ResourceUrls,
  ROOT_RESOURCE_METADATA_PATH,
  resourceUrls,
} from '../../auth/oauth/challenge.js';
import type { AuthProvider } from '../../auth/oauth/provider.js';
import type { AppDependencies, RouteSpec } from '../app.js';
import { errorBody } from '../errors.js';

export interface OAuthSetup {
  urls: ResourceUrls;
  /** Absent when only the public URL is set. Then no metadata is published. */
  provider: AuthProvider | undefined;
}

const setups = new WeakMap<AppDependencies, OAuthSetup | null>();

/**
 * The public URLs and identity provider this app was configured with, or undefined when it was
 * given no `publicBaseUrl`. A bad URL throws, so `createApp` calls this once to fail at startup.
 */
export function oauthOf(deps: AppDependencies): OAuthSetup | undefined {
  let setup = setups.get(deps);
  if (setup === undefined) {
    const settings = deps.mcp;
    setup =
      settings?.publicBaseUrl === undefined
        ? null
        : {
            urls: resourceUrls(settings.publicBaseUrl),
            provider: settings.authProvider,
          };
    setups.set(deps, setup);
  }
  return setup ?? undefined;
}

/**
 * The protected resource metadata of RFC 9728. It is public by design, since a client reads it
 * before it has a token, and it holds nothing but URLs and scope names. With no provider
 * configured there is no authorization server to name, so it answers 404.
 */
function metadataRoute(path: string): RouteSpec {
  return {
    method: 'get',
    path,
    access: { public: true },
    handler: (c) => {
      const setup = oauthOf(c.get('deps'));
      if (setup === undefined || setup.provider === undefined) {
        return c.json(
          errorBody(
            'oauth_not_configured',
            'No identity provider is configured',
          ),
          404,
        );
      }
      return c.json(
        protectedResourceMetadata(
          setup.urls,
          setup.provider.authorizationServers,
        ),
        200,
        { 'Cache-Control': 'public, max-age=300' },
      );
    },
  };
}

/** Self-describing and public. Kept out of `ROUTES` so /health stays the only public route there. */
export const oauthRoutes: readonly RouteSpec[] = [
  metadataRoute(RESOURCE_METADATA_PATH),
  metadataRoute(ROOT_RESOURCE_METADATA_PATH),
];
