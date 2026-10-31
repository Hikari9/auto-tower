import { SCOPES } from '../principals.js';

/** Path of the MCP endpoint, which is also the path part of its protected resource identifier. */
export const MCP_PATH = '/mcp';

/** RFC 9728 path-insertion form: the well-known prefix goes in front of the resource's path. */
export const RESOURCE_METADATA_PATH = `/.well-known/oauth-protected-resource${MCP_PATH}`;
export const ROOT_RESOURCE_METADATA_PATH =
  '/.well-known/oauth-protected-resource';

export interface ResourceUrls {
  /** `https://host/mcp`. The audience a token must carry. */
  resource: string;
  /** Where clients fetch the metadata. */
  metadata: string;
}

/**
 * Accepts an origin only: https, or http on a loopback host for local work. A path, query or
 * fragment would make the resource identifier ambiguous, so they are refused.
 */
export function resourceUrls(publicBaseUrl: string): ResourceUrls {
  let url: URL;
  try {
    url = new URL(publicBaseUrl);
  } catch {
    throw new Error('publicBaseUrl must be an absolute URL');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('publicBaseUrl must be https, or http on loopback');
  }
  if (
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new Error('publicBaseUrl must be an origin with no path or query');
  }
  return {
    resource: `${url.origin}${MCP_PATH}`,
    metadata: `${url.origin}${RESOURCE_METADATA_PATH}`,
  };
}

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: readonly string[];
  scopes_supported: readonly string[];
  bearer_methods_supported: readonly string[];
  resource_name: string;
}

/** The RFC 9728 document an MCP client reads to find the authorization server. */
export function protectedResourceMetadata(
  urls: ResourceUrls,
  authorizationServers: readonly string[],
): ProtectedResourceMetadata {
  return {
    resource: urls.resource,
    authorization_servers: authorizationServers,
    scopes_supported: SCOPES,
    bearer_methods_supported: ['header'],
    resource_name: 'Auto Tower MCP',
  };
}

export interface ChallengeInput {
  /** Omitted when Tower publishes no metadata. */
  metadataUrl?: string | undefined;
  /** RFC 6750 error. Absent for a request that carried no credential at all. */
  error?: 'invalid_token' | 'insufficient_scope' | undefined;
  description?: string | undefined;
  /** Scopes the caller needs, space separated, on an insufficient_scope answer. */
  scope?: readonly string[] | undefined;
}

const quote = (value: string): string =>
  `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

/** A `WWW-Authenticate` value in the shape the MCP authorization spec asks for. */
export function bearerChallenge(input: ChallengeInput = {}): string {
  const params: string[] = [];
  if (input.error !== undefined) {
    params.push(`error=${quote(input.error)}`);
  }
  if (input.description !== undefined) {
    params.push(`error_description=${quote(input.description)}`);
  }
  if (input.scope !== undefined && input.scope.length > 0) {
    params.push(`scope=${quote(input.scope.join(' '))}`);
  }
  if (input.metadataUrl !== undefined) {
    params.push(`resource_metadata=${quote(input.metadataUrl)}`);
  }
  return params.length === 0 ? 'Bearer' : `Bearer ${params.join(', ')}`;
}
