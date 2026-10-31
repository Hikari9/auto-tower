import type { AuthProvider } from '../auth/oauth/provider.js';

export interface McpSettings {
  /**
   * Public origin of this Tower, such as `https://tower.example.com`. It fixes the resource
   * identifier tokens must be minted for. Without it the endpoint serves Tower tokens only and
   * publishes no OAuth metadata, because a URL taken from request headers can be forged.
   */
  publicBaseUrl?: string;
  /** The identity provider. Needs `publicBaseUrl`. Faked in tests, real one is in DEFERRED.md. */
  authProvider?: AuthProvider;
  /**
   * Browser origins allowed to call the endpoint. A request that carries an `Origin` header from
   * anywhere else is refused, which stops a web page from driving a local Tower. Server-to-server
   * clients send no `Origin` and are unaffected.
   */
  allowedOrigins?: readonly string[];
  /** AI providers a person approved at deploy time. Empty by default, so no flag can turn on. */
  approvedAiProviders?: readonly string[];
}
