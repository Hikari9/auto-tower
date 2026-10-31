import type { DispatchContract, Receipt } from '../contracts/office-v1.ts';
import type { Attempt } from '../domain/types.ts';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class TowerHttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Outbound-only runner client for tower.runner/v1. No inbound port is needed. */
export class TowerClient {
  private readonly base: string;
  private readonly token: string;
  private readonly fetch: FetchLike;

  constructor(opts: { baseUrl: string; token: string; fetch?: FetchLike }) {
    this.base = opts.baseUrl.replace(/\/$/, '');
    this.token = opts.token;
    this.fetch = opts.fetch ?? ((u, i) => fetch(u, i));
  }

  async post<T>(path: string, body: unknown, idempotencyKey?: string): Promise<T> {
    const res = await this.fetch(`${this.base}/api/v1${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json', ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) },
      body: JSON.stringify(body),
    });
    const j = (await res.json()) as T & { error?: { code: string; message: string } };
    if (!res.ok) throw new TowerHttpError(res.status, j.error?.code ?? 'error', j.error?.message ?? res.statusText);
    return j;
  }

  register(body: unknown) {
    return this.post<{ runner: { id: string; status: string }; heartbeatMs: number; leaseMs: number }>('/runner/register', body);
  }
  heartbeat(body: unknown) {
    return this.post<{ status: string; directives: { attemptId: string; action: string; reason: string }[] }>('/runner/heartbeat', body);
  }
  claim() {
    return this.post<{ claim: { attempt: Attempt; contract: DispatchContract } | null }>('/runner/claim', {});
  }
  receipt(r: Receipt) {
    return this.post<unknown>('/runner/receipts', r);
  }
  effect(body: unknown) {
    return this.post<{ allowed: boolean; reason: string }>('/runner/effects', body);
  }
}
