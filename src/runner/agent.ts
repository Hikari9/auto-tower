import { RECEIPT_CONTRACT, type DispatchContract, type Receipt } from '../contracts/office-v1.ts';
import { randomToken } from '../domain/crypto.ts';
import type { OfficeEngine } from '../adapters/office/engine.ts';
import { TowerHttpError, type TowerClient } from './client.ts';

export interface LocalAttempt {
  attemptId: string;
  fence: number;
  localRunId: string;
  contract: DispatchContract;
  /** Receipts not yet acknowledged by Tower; replayed after a disconnect. */
  outbox: Receipt[];
  lastPhase?: string;
  engineState?: unknown;
}

/** Durable local state so a restarted runner reconciles instead of starting over. */
export interface RunnerStateStore {
  load(): Promise<Record<string, LocalAttempt>>;
  save(state: Record<string, LocalAttempt>): Promise<void>;
}

export class MemoryStateStore implements RunnerStateStore {
  state: Record<string, LocalAttempt> = {};
  async load() {
    return structuredClone(this.state);
  }
  async save(s: Record<string, LocalAttempt>) {
    this.state = structuredClone(s);
  }
}

export interface RunnerAgentOptions {
  client: TowerClient;
  engine: OfficeEngine;
  store: RunnerStateStore;
  registration: { name: string; clientVersion: string; platform: string; engines: string[]; capabilities?: string[]; allowedScopes?: string[]; maxConcurrency?: number };
  log?: (msg: string) => void;
}

/**
 * The runner loop: heartbeat (renew leases, obey directives), drive local runs
 * and report receipts, then claim new work if there is capacity. Every step is
 * safe to repeat; receipts carry stable ids so retries are idempotent.
 */
export class RunnerAgent {
  private readonly o: RunnerAgentOptions;
  private attempts: Record<string, LocalAttempt> = {};
  private loaded = false;
  registered = false;

  constructor(opts: RunnerAgentOptions) {
    this.o = opts;
  }

  private log(m: string) {
    this.o.log?.(m);
  }

  async register(): Promise<void> {
    if (!this.loaded) {
      this.attempts = await this.o.store.load();
      for (const a of this.active) if (a.engineState !== undefined) this.o.engine.attach?.(a.localRunId, a.engineState);
      this.loaded = true;
    }
    await this.o.client.register({ ...this.o.registration, engines: this.o.registration.engines });
    this.registered = true;
  }

  get active(): LocalAttempt[] {
    return Object.values(this.attempts);
  }

  async tick(): Promise<void> {
    if (!this.registered) await this.register();
    const hb = await this.o.client.heartbeat({ attempts: this.active.map((a) => ({ attemptId: a.attemptId, fence: a.fence, ...(a.lastPhase ? { phase: a.lastPhase } : {}), localRunId: a.localRunId })) });
    for (const d of hb.directives) {
      const a = this.attempts[d.attemptId];
      if (!a) continue;
      if (d.action === 'stop') {
        // Fenced or finished elsewhere: never keep writing to that scope.
        this.log(`stop ${a.attemptId}: ${d.reason}`);
        await this.o.engine.cancel(a.localRunId, d.reason).catch(() => undefined);
        delete this.attempts[a.attemptId];
      } else if (d.action === 'cancel') {
        await this.o.engine.cancel(a.localRunId, d.reason).catch(() => undefined);
        delete this.attempts[a.attemptId];
      } else if (d.action === 'pause') {
        const cp = await this.o.engine.pause(a.localRunId).catch(() => null);
        if (cp) a.outbox.push(this.receipt(a, 'checkpoint', { checkpoint: cp }));
        a.outbox.push(this.receipt(a, 'fail', { failure: { class: 'cancelled', detail: 'paused by owner', retryable: false } }));
      }
    }
    await this.persist();
    if (hb.status !== 'online') return;
    for (const a of this.active) await this.drive(a);
    await this.claimIfCapacity();
  }

  private receipt(a: LocalAttempt, kind: Receipt['kind'], extra: Partial<Receipt> = {}): Receipt {
    return { contract: RECEIPT_CONTRACT, receiptId: `${a.attemptId}.${randomToken(9)}`, attemptId: a.attemptId, fence: a.fence, kind, ...extra };
  }

  private async flush(a: LocalAttempt): Promise<'ok' | 'fenced'> {
    while (a.outbox.length) {
      try {
        await this.o.client.receipt(a.outbox[0]!);
      } catch (err) {
        if (err instanceof TowerHttpError && (err.code === 'fenced' || err.status === 404)) return 'fenced';
        if (err instanceof TowerHttpError && err.code === 'conflict') {
          a.outbox.shift();
          continue;
        }
        throw err;
      }
      a.outbox.shift();
      await this.persist();
    }
    return 'ok';
  }

  private async drive(a: LocalAttempt): Promise<void> {
    if ((await this.flush(a)) === 'fenced') return this.drop(a, 'fenced while flushing receipts');
    if (a.outbox.length === 0 && a.lastPhase === 'terminal') return this.drop(a, 'finished');
    const st = await this.o.engine.poll(a.localRunId, a.contract);
    if (st.state === 'running') {
      if (st.effect) {
        let allowed = false;
        let reason = '';
        try {
          const ev = await this.o.client.effect({ attemptId: a.attemptId, fence: a.fence, action: st.effect.action, resource: st.effect.resource, producerSessionId: st.effect.producerSessionId, ...(st.effect.review ? { review: st.effect.review } : {}) });
          allowed = ev.allowed;
          reason = ev.reason;
        } catch (err) {
          if (err instanceof TowerHttpError && err.code === 'fenced') return this.drop(a, 'fenced at point of effect');
          reason = err instanceof Error ? err.message : String(err);
        }
        await this.o.engine.effectResult(a.localRunId, st.effect.key, allowed, reason);
      }
      if (st.phase !== a.lastPhase || st.checkpoint) {
        a.lastPhase = st.phase;
        a.outbox.push(this.receipt(a, st.checkpoint ? 'checkpoint' : 'progress', { phase: st.phase, localRunId: a.localRunId, ...(st.checkpoint ? { checkpoint: st.checkpoint } : {}) }));
      }
    } else if (st.state === 'succeeded') {
      a.outbox.push(this.receipt(a, 'complete', { completion: st.completion }));
      a.lastPhase = 'terminal';
    } else {
      a.outbox.push(this.receipt(a, 'fail', { failure: st.failure }));
      a.lastPhase = 'terminal';
    }
    await this.persist();
    if ((await this.flush(a)) === 'fenced') return this.drop(a, 'fenced');
    if (a.lastPhase === 'terminal' && a.outbox.length === 0) await this.drop(a, 'finished');
  }

  private async drop(a: LocalAttempt, why: string) {
    this.log(`drop ${a.attemptId}: ${why}`);
    delete this.attempts[a.attemptId];
    await this.persist();
  }

  private async claimIfCapacity(): Promise<void> {
    const cap = this.o.registration.maxConcurrency ?? 1;
    while (this.active.length < cap) {
      const { claim } = await this.o.client.claim();
      if (!claim) return;
      const { attempt, contract } = claim;
      try {
        const { localRunId } = await this.o.engine.start(contract);
        this.attempts[attempt.id] = { attemptId: attempt.id, fence: attempt.fence, localRunId, contract, outbox: [] };
        await this.persist();
        this.log(`claimed ${contract.packet.title} (${attempt.id}, fence ${attempt.fence})`);
      } catch (err) {
        const la: LocalAttempt = { attemptId: attempt.id, fence: attempt.fence, localRunId: 'none', contract, outbox: [], lastPhase: 'terminal' };
        la.outbox.push(this.receipt(la, 'fail', { failure: { class: 'environment', detail: err instanceof Error ? err.message : String(err), retryable: true } }));
        await this.flush(la);
      }
    }
  }

  private async persist() {
    for (const a of this.active) {
      const snap = this.o.engine.snapshot?.(a.localRunId);
      if (snap !== undefined) a.engineState = snap;
    }
    await this.o.store.save(this.attempts);
  }
}
