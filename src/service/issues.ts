import { ProviderError, type IssueProvider, type IssueSnapshot, type ProviderContext } from '../adapters/issues/contract.ts';
import { normalizeIssueUrl, untrustedText } from '../adapters/issues/url.ts';
import { fail, TowerError } from '../domain/errors.ts';
import { linksReconciled } from '../domain/lifecycle.ts';
import type { Actor, Blocker, Discrepancy, IssueLink, LinkRole, Mission, PolicyEvaluation } from '../domain/types.ts';
import { SPECS } from '../store/codec.ts';
import type { Integration } from '../store/repo.ts';
import type { UnitOfWork } from '../store/uow.ts';
import { requireScope } from './auth.ts';
import type { Tower } from './tower.ts';

const INTEGRATION_SPEC = { table: 'integrations', json: ['config'], bool: ['enabled'] } as const;
const BLOCKING_LABELS = ['blocked', 'do-not-close', 'tower:hold'];

interface Bound {
  provider: IssueProvider;
  integration: Integration;
  ctx: ProviderContext;
  canRead: boolean;
  canWrite: boolean;
}

export class IssueService {
  private readonly t: Tower;

  constructor(t: Tower) {
    this.t = t;
  }

  /** Link an issue to a mission. Works with no provider installed (link-only). */
  async addLinkTx(tx: UnitOfWork, mission: Mission, input: { url: string; role?: LinkRole; title?: string; description?: string }): Promise<IssueLink> {
    const url = normalizeIssueUrl(input.url);
    let provider = 'link';
    let externalRef: string | null = null;
    for (const p of this.t.providers.all()) {
      const parsed = p.parse(url);
      if (parsed) {
        provider = p.id;
        externalRef = parsed.ref;
        break;
      }
    }
    const link: IssueLink = {
      id: this.t.id('lnk'),
      workspaceId: mission.workspaceId,
      missionId: mission.id,
      url: url.toString(),
      provider,
      externalRef,
      role: input.role ?? 'required',
      titleSnapshot: untrustedText(input.title, 300),
      descriptionSnapshot: untrustedText(input.description),
      observedState: 'unknown',
      observedAt: null,
      observedSource: null,
      exemption: null,
      lastError: null,
      errorCount: 0,
      version: 0,
      createdAt: tx.now,
    };
    return tx.save('link', SPECS.link, link, 'link.added', { missionId: mission.id, payload: { url: link.url, role: link.role, provider } });
  }

  async addLink(actor: Actor, missionId: string, input: { url: string; role?: LinkRole; title?: string; description?: string }): Promise<IssueLink> {
    requireScope(actor, 'missions:write');
    const ws = actor.principal.workspaceId;
    const m = await this.t.repo.mission(ws, missionId);
    if (m.state === 'cancelled') fail('invalid_transition', 'mission is cancelled');
    const tx = this.t.uow(actor);
    const link = await this.addLinkTx(tx, m, input);
    await tx.commit(this.t.db);
    await this.observeSafely(ws, link.id);
    await this.t.missions.refresh(ws, missionId);
    return this.t.repo.link(ws, link.id);
  }

  async setRole(actor: Actor, linkId: string, role: LinkRole): Promise<IssueLink> {
    requireScope(actor, 'missions:write');
    const ws = actor.principal.workspaceId;
    const l = await this.t.repo.link(ws, linkId);
    // Downgrading a required link is a scope change only the owner may make.
    if (l.role === 'required' && role !== 'required' && actor.principal.kind !== 'human') fail('forbidden', 'only the owner can relax a required link');
    const tx = this.t.uow(actor);
    const saved = tx.save('link', SPECS.link, { ...l, role }, 'link.role_changed', { missionId: l.missionId, payload: { from: l.role, to: role } });
    await tx.commit(this.t.db);
    await this.t.missions.refresh(ws, l.missionId);
    return saved;
  }

  /** Human attestation for link-only issues Tower cannot read itself. */
  async attest(actor: Actor, linkId: string, state: 'open' | 'closed', note = ''): Promise<IssueLink> {
    requireScope(actor, 'decisions:answer');
    const ws = actor.principal.workspaceId;
    const l = await this.t.repo.link(ws, linkId);
    const tx = this.t.uow(actor);
    const saved = tx.save('link', SPECS.link, { ...l, observedState: state, observedAt: tx.now, observedSource: `human:${actor.principal.id}` }, 'link.attested', {
      missionId: l.missionId,
      payload: { state, note },
    });
    await tx.commit(this.t.db);
    await this.t.missions.refresh(ws, l.missionId);
    return saved;
  }

  /** Approved exemption: the mission may complete while this required issue stays open. */
  async exempt(actor: Actor, linkId: string, reason: string): Promise<IssueLink> {
    requireScope(actor, 'decisions:answer');
    if (!reason?.trim()) fail('invalid', 'an exemption needs a reason');
    const ws = actor.principal.workspaceId;
    const l = await this.t.repo.link(ws, linkId);
    const tx = this.t.uow(actor);
    const saved = tx.save('link', SPECS.link, { ...l, exemption: { by: actor.principal.id, reason, at: tx.now } }, 'link.exempted', { missionId: l.missionId, payload: { reason } });
    await tx.commit(this.t.db);
    await this.t.missions.refresh(ws, l.missionId);
    return saved;
  }

  async configure(actor: Actor, provider: string, config: Record<string, unknown>, enabled = true): Promise<Integration> {
    requireScope(actor, 'admin');
    if (!this.t.providers.get(provider)) fail('invalid', `provider ${provider} is not installed`);
    for (const k of Object.keys(config)) if (/token$|secret$/i.test(k) && !/Secret$/.test(k)) fail('invalid', `store secrets in the host secret store and pass their name (${k})`);
    const ws = actor.principal.workspaceId;
    const existing = await this.t.repo.integration(ws, provider);
    const tx = this.t.uow(actor);
    const next: Integration = existing
      ? { ...existing, config, enabled }
      : { id: this.t.id('int'), workspaceId: ws, provider, config, enabled, version: 0, createdAt: tx.now };
    const saved = tx.save('integration', INTEGRATION_SPEC, next, existing ? 'integration.updated' : 'integration.configured', { payload: { provider, enabled, syncMode: config.syncMode } });
    await tx.commit(this.t.db);
    return saved;
  }

  async listIntegrations(actor: Actor) {
    requireScope(actor, 'missions:read');
    return (await this.t.repo.integrations(actor.principal.workspaceId)).map((i) => ({ ...i, installed: Boolean(this.t.providers.get(i.provider)) }));
  }

  private async bind(ws: string, link: IssueLink): Promise<Bound | null> {
    if (!link.externalRef) return null;
    const provider = this.t.providers.get(link.provider);
    const integration = await this.t.repo.integration(ws, link.provider);
    if (!provider || !integration?.enabled) return null;
    const cfg = integration.config as { syncMode?: string; repos?: { repo: string; read: boolean; write: boolean }[] };
    if (!cfg.syncMode || cfg.syncMode === 'link') return null;
    const repo = link.externalRef.split('#')[0]!;
    const rc = cfg.repos?.find((r) => r.repo.toLowerCase() === repo);
    if (!rc?.read) return null;
    return {
      provider,
      integration,
      ctx: { config: integration.config, secret: this.t.providers.secret },
      canRead: true,
      canWrite: cfg.syncMode === 'bidirectional' && rc.write,
    };
  }

  /** Read a link's current provider state and apply it. Provider failures are recorded, not thrown. */
  async observeSafely(ws: string, linkId: string): Promise<IssueLink> {
    const link = await this.t.repo.link(ws, linkId);
    const b = await this.bind(ws, link);
    if (!b) return link;
    try {
      const snap = await b.provider.read(link.externalRef!, b.ctx);
      await this.applyObservation(ws, link.id, snap.canonicalRef === link.externalRef ? snap.state : 'transferred', `${b.provider.id}:read`, snap);
    } catch (err) {
      await this.recordProviderError(ws, link, err);
    }
    return this.t.repo.link(ws, linkId);
  }

  private async recordProviderError(ws: string, link: IssueLink, err: unknown): Promise<void> {
    const msg = err instanceof ProviderError ? `${err.kind}: ${err.message}${err.retryAt ? ` (retry after ${err.retryAt})` : ''}` : String(err);
    await this.t.retrying(async () => {
      const l = await this.t.repo.link(ws, link.id);
      const tx = this.t.uow(this.t.systemActor(ws));
      tx.save('link', SPECS.link, { ...l, lastError: msg, errorCount: l.errorCount + 1 }, 'link.provider_error', { missionId: l.missionId, payload: { error: msg } });
      await tx.commit(this.t.db);
    });
  }

  /**
   * Apply an observed external state. A required issue that reopens (or drifts)
   * after completion moves the mission to needs_attention with a discrepancy;
   * the historical completion event stays in the log.
   */
  async applyObservation(ws: string, linkId: string, state: 'open' | 'closed' | 'deleted' | 'transferred', source: string, snap?: IssueSnapshot): Promise<void> {
    await this.t.retrying(async () => {
      const l = await this.t.repo.link(ws, linkId);
      const m = await this.t.repo.mission(ws, l.missionId);
      const tx = this.t.uow(this.t.systemActor(ws));
      const observed = state === 'closed' ? 'closed' : state === 'open' ? 'open' : 'unknown';
      const changed = observed !== l.observedState;
      tx.save(
        'link',
        SPECS.link,
        {
          ...l,
          observedState: observed,
          observedAt: tx.now,
          observedSource: source,
          lastError: state === 'deleted' || state === 'transferred' ? `issue was ${state}` : null,
          errorCount: 0,
          ...(snap ? { titleSnapshot: untrustedText(snap.title, 300) } : {}),
        },
        changed ? 'link.state_changed' : 'link.observed',
        { missionId: l.missionId, payload: { from: l.observedState, to: observed, source, raw: state } },
      );
      const regressed = l.role === 'required' && !l.exemption && observed !== 'closed' && (l.observedState === 'closed' || state === 'deleted' || state === 'transferred');
      if (regressed && m.state === 'completed') {
        const d: Discrepancy = { id: this.t.id('dsc'), linkId: l.id, kind: state === 'open' ? 'reopened' : 'drift', detail: `required issue ${l.url} is now ${state}`, detectedAt: tx.now };
        tx.save('mission', SPECS.mission, { ...m, state: 'needs_attention' as const, discrepancies: [...m.discrepancies, d] }, 'mission.drift_detected', {
          missionId: m.id,
          payload: d,
        });
      }
      await tx.commit(this.t.db);
    });
  }

  /**
   * Reconcile a mission in `reconciling`. It completes only when every required
   * link is verified closed (provider read-back or human attestation) or exempt.
   * Tower closes an issue itself only with bidirectional sync, repo write access
   * and a current grant for issue.close, and then re-reads it.
   */
  async reconcile(ws: string, missionId: string): Promise<Mission> {
    const m0 = await this.t.repo.mission(ws, missionId);
    if (m0.state !== 'reconciling') return m0;
    const blockers: Blocker[] = [];
    let failures = 0;
    for (const link of await this.t.repo.links(ws, missionId)) {
      if (link.role !== 'required' || link.exemption) continue;
      const b = await this.bind(ws, link);
      if (!b) {
        if (link.observedState !== 'closed') blockers.push({ kind: 'external', ref: link.id, reason: `link-only issue ${link.url} needs an owner attestation or exemption` });
        continue;
      }
      try {
        let snap = await b.provider.read(link.externalRef!, b.ctx);
        if (snap.canonicalRef !== link.externalRef) throw new ProviderError('invalid', `issue moved to ${snap.canonicalRef}; not the intended issue`);
        if (snap.state === 'open') {
          const reason = await this.closeBlocker(ws, m0, link, b, snap);
          if (reason) {
            await this.applyObservation(ws, link.id, 'open', `${b.provider.id}:read`, snap);
            blockers.push({ kind: 'external', ref: link.id, reason });
            continue;
          }
          const marker = this.t.id('eff');
          await this.recordTowerEffect(ws, link, marker, 'issue.close.requested');
          await b.provider.close(link.externalRef!, b.ctx, { comment: `Closed by Auto Tower: mission "${m0.title}" is verified complete.`, marker });
          snap = await b.provider.read(link.externalRef!, b.ctx);
          await this.recordTowerEffect(ws, link, marker, snap.state === 'closed' ? 'issue.close.verified' : 'issue.close.readback_mismatch');
          if (snap.state !== 'closed') throw new ProviderError('unavailable', 'close was not confirmed by read-back');
        }
        await this.applyObservation(ws, link.id, snap.state, `${b.provider.id}:read`, snap);
      } catch (err) {
        failures++;
        await this.recordProviderError(ws, link, err);
        blockers.push({ kind: 'external', ref: link.id, reason: `cannot verify ${link.url}: ${err instanceof Error ? err.message : String(err)}` });
      }
    }

    return this.t.retrying(async () => {
      const m = await this.t.repo.mission(ws, missionId);
      if (m.state !== 'reconciling') return m;
      const links = await this.t.repo.links(ws, missionId);
      const check = linksReconciled(links);
      const tx = this.t.uow(this.t.systemActor(ws));
      if (check.ok) {
        tx.save('mission', SPECS.mission, { ...m, state: 'completed' as const, activity: 'done' as const, blockers: [], completedAt: tx.now }, 'mission.completed', {
          missionId,
          payload: { verification: m.verification, links: links.map((l) => ({ url: l.url, role: l.role, state: l.observedState, exempt: Boolean(l.exemption) })) },
        });
      } else {
        const errored = links.filter((l) => l.role === 'required' && l.errorCount >= this.t.config.reconcileFailureLimit);
        if (failures > 0 && errored.length) {
          const ds: Discrepancy[] = errored.map((l) => ({ id: this.t.id('dsc'), linkId: l.id, kind: 'provider_error', detail: `${l.url}: ${l.lastError ?? 'unknown error'}`, detectedAt: tx.now }));
          tx.save('mission', SPECS.mission, { ...m, state: 'needs_attention' as const, blockers, discrepancies: [...m.discrepancies, ...ds] }, 'mission.reconcile_failed', { missionId, payload: { blockers } });
        } else {
          tx.run('UPDATE missions SET activity = ?, blockers_json = ? WHERE id = ?', 'waiting_external', JSON.stringify(blockers), missionId);
        }
      }
      await tx.commit(this.t.db);
      return this.t.repo.mission(ws, missionId);
    });
  }

  private async closeBlocker(ws: string, m: Mission, link: IssueLink, b: Bound, snap: IssueSnapshot): Promise<string | null> {
    if (!b.canWrite) return `required issue ${link.url} is open; Tower has no write access, so it waits for the issue to be closed`;
    const blocking = snap.labels.filter((l) => BLOCKING_LABELS.includes(l.toLowerCase()));
    if (blocking.length) return `issue ${link.url} carries blocking labels: ${blocking.join(', ')}`;
    if (snap.locked) return `issue ${link.url} is locked`;
    const ev = await this.t.policy.evaluate(ws, { grantee: 'tower', action: 'issue.close', resource: `${b.provider.id}:${link.externalRef}`, risk: m.risk, missionId: m.id }, { authority: m.authority, risk: m.risk });
    await this.recordTowerEffect(ws, link, null, ev.allowed ? 'issue.close.authorized' : 'issue.close.denied', ev);
    if (!ev.allowed) return `closing ${link.url} is not authorized: ${ev.reason}`;
    return null;
  }

  private async recordTowerEffect(ws: string, link: IssueLink, marker: string | null, type: string, policy?: PolicyEvaluation): Promise<void> {
    await this.t.retrying(async () => {
      const l = await this.t.repo.link(ws, link.id);
      const tx = this.t.uow(this.t.systemActor(ws));
      tx.save('link', SPECS.link, l, type, { missionId: l.missionId, ...(policy ? { policy } : {}), payload: { marker } });
      await tx.commit(this.t.db);
    });
  }

  /**
   * Verified webhook intake. Signature and delivery-id replay are checked before
   * anything is applied. Webhooks only update observed state; Tower never writes
   * back in response to one, so there is no event loop.
   */
  async handleWebhook(workspaceId: string, providerId: string, headers: Headers, rawBody: string): Promise<{ applied: number; duplicate: boolean }> {
    const provider = this.t.providers.get(providerId) ?? fail('not_found', `provider ${providerId} is not installed`);
    const integration = await this.t.repo.integration(workspaceId, providerId);
    if (!integration?.enabled) fail('not_found', 'integration is not enabled');
    let verified;
    try {
      verified = await provider.verifyWebhook(headers, rawBody, { config: integration!.config, secret: this.t.providers.secret });
    } catch (err) {
      throw new TowerError('unauthenticated', err instanceof Error ? err.message : 'webhook rejected');
    }
    try {
      await this.t.db.batch([{ sql: 'INSERT INTO webhook_deliveries (provider, delivery_id, received_at) VALUES (?, ?, ?)', params: [providerId, verified.deliveryId, this.t.now()] }]);
    } catch (err) {
      if (err instanceof TowerError && err.code === 'conflict') return { applied: 0, duplicate: true };
      throw err;
    }
    let applied = 0;
    const touched = new Set<string>();
    for (const o of verified.observations) {
      for (const link of await this.t.repo.linksByRef(workspaceId, o.ref)) {
        await this.applyObservation(workspaceId, link.id, o.state, `${providerId}:webhook${o.towerOrigin ? ':tower-origin' : ''}`);
        touched.add(link.missionId);
        applied++;
      }
    }
    for (const mid of touched) await this.t.missions.refresh(workspaceId, mid);
    return { applied, duplicate: false };
  }

  /** Polling fallback for missed webhooks; bounded per sweep to respect rate limits. */
  async pollDue(ws: string, max = 20): Promise<number> {
    const cutoff = new Date(this.t.clock().getTime() - this.t.config.linkPollMs).toISOString();
    let polled = 0;
    const touched = new Set<string>();
    for (const provider of this.t.providers.all()) {
      for (const link of await this.t.repo.observableLinks(ws, provider.id)) {
        if (polled >= max) break;
        if (link.observedAt && link.observedAt > cutoff) continue;
        if (link.lastError?.includes('retry after')) {
          const at = link.lastError.match(/retry after ([^)]+)\)/)?.[1];
          if (at && at > this.t.now()) continue;
        }
        const m = await this.t.repo.mission(ws, link.missionId);
        if (m.state === 'cancelled') continue;
        const before = link.observedState;
        const after = await this.observeSafely(ws, link.id);
        polled++;
        if (after.observedState !== before) touched.add(link.missionId);
      }
    }
    for (const mid of touched) await this.t.missions.refresh(ws, mid);
    return polled;
  }
}
