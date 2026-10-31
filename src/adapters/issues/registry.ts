import type { IssueProvider } from './contract.ts';

/**
 * Installed issue providers plus the host's secret lookup. Secrets come from the
 * hosting environment (Workers secrets, env vars); Tower stores only their names.
 */
export class IssueProviderRegistry {
  private readonly providers = new Map<string, IssueProvider>();
  readonly secret: (name: string) => string | undefined;

  constructor(providers: IssueProvider[] = [], secret: (name: string) => string | undefined = () => undefined) {
    for (const p of providers) this.providers.set(p.id, p);
    this.secret = secret;
  }

  get(id: string): IssueProvider | undefined {
    return this.providers.get(id);
  }

  all(): IssueProvider[] {
    return [...this.providers.values()];
  }
}
