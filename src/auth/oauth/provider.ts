/**
 * The seam to the real identity provider. Tower is only the resource server: the provider runs
 * the authorization flow, registers clients and mints access tokens, and this port answers one
 * question, "who does this access token belong to?". Tests use a fake. The real adapter is listed
 * in DEFERRED.md.
 */
export interface VerifiedAccessToken {
  /** Issuer of the token. Must be one of the provider's `authorizationServers`. */
  issuer: string;
  /** The provider's stable id for the person or agent. Linked to a Tower principal by a human. */
  subject: string;
  /** Scopes the provider granted. Names Tower does not know are ignored. */
  scopes: readonly string[];
  /** Resources the token was issued for (RFC 8707). Tower refuses a token not minted for it. */
  audience: readonly string[];
  expiresAt: Date;
}

export interface AuthProvider {
  /** Issuer URLs listed in the protected resource metadata. At least one. */
  readonly authorizationServers: readonly [string, ...string[]];
  /**
   * Checks the signature, expiry and issuer of an access token and returns its claims, or
   * undefined for anything it cannot vouch for. It never needs to return why: Tower answers the
   * same 401 either way. A thrown error counts as a refusal.
   */
  verifyAccessToken(
    token: string,
    now: Date,
  ): Promise<VerifiedAccessToken | undefined>;
}
