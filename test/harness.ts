import type { Completion, Receipt } from '../src/contracts/office-v1.ts';
import { IssueProviderRegistry } from '../src/adapters/issues/registry.ts';
import type { IssueProvider } from '../src/adapters/issues/contract.ts';
import type { Actor } from '../src/domain/types.ts';
import { Tower, type TowerConfig } from '../src/service/tower.ts';
import { migrate } from '../src/store/sql.ts';
import { loadMigrations, NodeSqliteDriver } from '../src/store/sqlite-node.ts';

export class TestClock {
  ms = Date.parse('2026-11-01T00:00:00.000Z');
  now = () => new Date(this.ms);
  advance(ms: number) {
    this.ms += ms;
  }
}

export interface Harness {
  tower: Tower;
  db: NodeSqliteDriver;
  clock: TestClock;
  owner: Actor;
  ownerToken: string;
  chief: Actor;
  chiefToken: string;
  workspaceId: string;
  runnerActor(name: string): Promise<{ actor: Actor; token: string }>;
}

export async function makeHarness(opts: { providers?: IssueProvider[]; secrets?: Record<string, string>; config?: Partial<TowerConfig>; path?: string } = {}): Promise<Harness> {
  const db = new NodeSqliteDriver(opts.path ?? ':memory:');
  await migrate(db, loadMigrations());
  const clock = new TestClock();
  const tower = new Tower({
    db,
    clock: clock.now,
    config: opts.config ?? {},
    providers: new IssueProviderRegistry(opts.providers ?? [], (n) => opts.secrets?.[n]),
  });
  const boot = await tower.admin.bootstrap({ workspaceName: 'Test', ownerName: 'Owner' });
  const owner = await tower.authenticate(boot.ownerToken);
  const chiefCred = await tower.admin.issueToken(owner, { kind: 'chief', name: 'Rico Mode' });
  const chief = await tower.authenticate(chiefCred.token);
  return {
    tower,
    db,
    clock,
    owner,
    ownerToken: boot.ownerToken,
    chief,
    chiefToken: chiefCred.token,
    workspaceId: boot.workspaceId,
    async runnerActor(name: string) {
      const cred = await tower.admin.issueToken(owner, { kind: 'runner', name });
      return { actor: await tower.authenticate(cred.token), token: cred.token };
    },
  };
}

let seq = 0;
export const rid = () => `rcpt_${String(++seq).padStart(8, '0')}`;

export function completion(over: Partial<Completion> = {}): Completion {
  return {
    outcome: 'succeeded',
    producer: { engine: 'fake', runId: 'run1', sessionId: 'producer-session' },
    commitSha: 'abc1234',
    selfVerification: { status: 'pass', summary: 'self-checked' },
    independentReview: { status: 'approved', reviewer: { id: 'reviewer', sessionId: 'reviewer-session', kind: 'agent' }, independence: 'independent', sha: 'abc1234', summary: 'ok' },
    tests: { status: 'pass', summary: 'all green' },
    integratedVerification: { status: 'pass', summary: 'integrated ok' },
    residualRisks: [],
    dodItemsMet: [],
    evidence: [],
    ...over,
  };
}

export function receipt(attemptId: string, fence: number, kind: Receipt['kind'], extra: Partial<Receipt> = {}): Receipt {
  return { contract: 'tower.receipt/v1', receiptId: rid(), attemptId, fence, kind, ...extra };
}

/** Register a runner, claim one packet, and optionally complete it. */
export async function registerRunner(h: Harness, name: string, over: Record<string, unknown> = {}) {
  const r = await h.runnerActor(name);
  await h.tower.runners.register(r.actor, { name, clientVersion: '0.1.0', platform: 'darwin', engines: ['auto-office'], capabilities: [], ...over });
  return r.actor;
}

export const simpleMission = (over: Record<string, unknown> = {}) => ({
  title: 'Ship feature X',
  intent: 'Users need X',
  outcome: 'X works in main',
  risk: 'low' as const,
  authority: { actions: ['repo.push', 'pr.open'], resources: ['repo:acme/app'] },
  packets: [{ title: 'Build X', goal: 'Implement X', scope: { repo: 'acme/app' } }],
  start: true,
  ...over,
});
