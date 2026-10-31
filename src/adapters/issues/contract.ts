/**
 * Issue provider contract, version 1 (tower.issues/v1).
 *
 * A provider owns its issues. Tower links to them by URL, observes their state
 * when the owner enables a provider, and writes only under explicit grants.
 * Future Linear/Jira/Basecamp adapters implement this same interface.
 */
export const ISSUE_PROVIDER_CONTRACT = 'tower.issues/v1';

export interface IssueSnapshot {
  /** Canonical reference after any transfer/redirect, e.g. "owner/repo#12". */
  canonicalRef: string;
  url: string;
  state: 'open' | 'closed';
  title: string;
  body: string;
  labels: string[];
  locked: boolean;
  updatedAt: string | null;
}

export interface ProviderContext {
  config: Record<string, unknown>;
  secret(name: string): string | undefined;
}

export interface WebhookObservation {
  ref: string;
  state: 'open' | 'closed' | 'deleted' | 'transferred';
  action: string;
  title?: string;
  /** Present when the change was made by Tower itself (origin marker). */
  towerOrigin?: string;
}

export interface VerifiedWebhook {
  deliveryId: string;
  observations: WebhookObservation[];
}

export type ProviderErrorKind = 'auth' | 'forbidden' | 'not_found' | 'rate_limited' | 'unavailable' | 'invalid';

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly retryAt: string | undefined;

  constructor(kind: ProviderErrorKind, message: string, retryAt?: string) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.retryAt = retryAt;
  }
}

export interface IssueProvider {
  readonly id: string;
  readonly contract: typeof ISSUE_PROVIDER_CONTRACT;
  /** Recognize a URL this provider owns and return its stable reference. */
  parse(url: URL): { ref: string; repo: string } | null;
  read(ref: string, ctx: ProviderContext): Promise<IssueSnapshot>;
  /** Close idempotently. `marker` is embedded so webhooks can recognize Tower's own writes. */
  close(ref: string, ctx: ProviderContext, opts: { comment: string; marker: string }): Promise<void>;
  verifyWebhook(headers: Headers, rawBody: string, ctx: ProviderContext): Promise<VerifiedWebhook>;
}
