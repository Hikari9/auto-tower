import type {
  AuthProvider,
  VerifiedAccessToken,
} from '../../../src/auth/oauth/provider.js';

export const ISSUER = 'https://idp.example.test';
export const BASE_URL = 'https://tower.example.test';
export const RESOURCE = `${BASE_URL}/mcp`;

/** A provider whose tokens the test mints. It never touches the network. */
export class FakeAuthProvider implements AuthProvider {
  readonly authorizationServers: readonly [string, ...string[]] = [ISSUER];
  private readonly tokens = new Map<string, VerifiedAccessToken>();
  failWith: Error | undefined;

  mint(
    token: string,
    claims: Partial<VerifiedAccessToken> & { subject: string },
  ): string {
    this.tokens.set(token, {
      issuer: ISSUER,
      scopes: ['mission:read'],
      audience: [RESOURCE],
      expiresAt: new Date('2100-01-01T00:00:00Z'),
      ...claims,
    });
    return token;
  }

  verifyAccessToken(token: string): Promise<VerifiedAccessToken | undefined> {
    if (this.failWith !== undefined) {
      return Promise.reject(this.failWith);
    }
    return Promise.resolve(this.tokens.get(token));
  }
}
