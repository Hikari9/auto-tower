import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ClassifiedFailure,
  classifyError,
  FAILURE_CLASSES,
  isFailureClass,
} from '../../src/runner/failure.js';
import {
  createFileStateStore,
  createMemoryStateStore,
} from '../../src/runner/state.js';
import {
  createHttpTransport,
  refusalOf,
  TransportError,
} from '../../src/runner/transport.js';

function fetchReturning(status: number, body: string) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('createHttpTransport', () => {
  it('sends the bearer token and a JSON body to the joined path', async () => {
    const { calls, fetchImpl } = fetchReturning(200, '{"ok":true}');
    const transport = createHttpTransport('https://tower.example/', fetchImpl);
    const res = await transport({
      method: 'POST',
      path: '/runners/claims',
      body: { a: 1 },
      token: 'tkn',
    });
    expect(res).toEqual({ status: 200, body: { ok: true } });
    expect(calls[0]?.url).toBe('https://tower.example/runners/claims');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer tkn');
    expect(headers['content-type']).toBe('application/json');
    expect(calls[0]?.init.body).toBe('{"a":1}');
  });

  it('sends no authorization header when there is no token', async () => {
    const { calls, fetchImpl } = fetchReturning(200, '');
    await createHttpTransport(
      'https://t',
      fetchImpl,
    )({ method: 'GET', path: '/x' });
    const headers = calls[0]?.init.headers as
      | Record<string, string>
      | undefined;
    expect(headers?.authorization).toBeUndefined();
  });

  it('turns a network failure into a TransportError', async () => {
    const failing = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    await expect(
      createHttpTransport('https://t', failing)({ method: 'GET', path: '/x' }),
    ).rejects.toBeInstanceOf(TransportError);
  });

  it('turns a non-JSON answer into a TransportError', async () => {
    const { fetchImpl } = fetchReturning(502, '<html>');
    await expect(
      createHttpTransport(
        'https://t',
        fetchImpl,
      )({ method: 'GET', path: '/x' }),
    ).rejects.toBeInstanceOf(TransportError);
  });

  it('reads the typed code from a refusal body', () => {
    const refusal = refusalOf({
      status: 409,
      body: { error: { code: 'lease_fenced', message: 'old fence' } },
    });
    expect(refusal.code).toBe('lease_fenced');
    expect(refusal.status).toBe(409);
    expect(refusalOf({ status: 500, body: null }).code).toBe('unknown');
  });
});

describe('failure classes', () => {
  it('is the seven classes the contract names', () => {
    expect([...FAILURE_CLASSES].sort()).toEqual(
      [
        'adapter',
        'environment',
        'implementation-defect',
        'policy-denial',
        'quota',
        'review-failure',
        'runner',
      ].sort(),
    );
    expect(isFailureClass('quota')).toBe(true);
    expect(isFailureClass('made-up')).toBe(false);
  });

  it('keeps a classified error’s class and calls any other error an adapter failure', () => {
    expect(classifyError(new ClassifiedFailure('environment', 'x'))).toBe(
      'environment',
    );
    expect(classifyError(new Error('boom'))).toBe('adapter');
  });
});

describe('state stores', () => {
  it('round-trips the file store, owner-only, with no temporary file left behind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'runner-state-'));
    const path = join(dir, 'nested', 'state.json');
    const store = createFileStateStore(path);
    expect(store.load()).toBeUndefined();
    store.save({ runnerId: 'r1', token: 't', leases: {} });
    expect(store.load()).toEqual({ runnerId: 'r1', token: 't', leases: {} });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(dir, 'nested'))).toEqual(['state.json']);
    expect(readFileSync(path, 'utf8')).toContain('"runnerId": "r1"');
  });

  it('gives the memory store a copy, so a later change does not reach a stored state', () => {
    const store = createMemoryStateStore();
    const state = { runnerId: 'r1', token: 't', leases: {} };
    store.save(state);
    state.runnerId = 'changed';
    expect(store.load()?.runnerId).toBe('r1');
  });
});
