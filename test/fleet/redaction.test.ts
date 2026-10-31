import { describe, expect, it } from 'vitest';
import { redactString, redactValue } from '../../src/fleet/redact.js';
import {
  createFleetHarness,
  type FleetHarness,
  type RunnerClient,
} from './helpers.js';

// Built from parts so this file holds no literal that a secret scanner would flag.
const SECRETS = {
  github: `ghp_${'A1b2C3d4E5f6G7h8I9j0'}${'K1l2M3n4O5p6'}`,
  awsKey: `AKIA${'IOSFODNN7EXAMPLE'}`,
  provider: `sk-${'proj-abcdefghijklmnopqrstuvwxyz0123456789'}`,
  slack: `xoxb-${'1234567890-abcdefghijkl'}`,
  jwt: `eyJ${'hbGciOiJIUzI1NiJ9'}.eyJ${'zdWIiOiIxMjM0NTY3ODkwIn0'}.${'abcdefghijklmnop12345'}`,
  pem: `-----BEGIN ${'RSA PRIVATE KEY'}-----\nMIIEowIBAAKCAQEA7planted7planted7\n-----END ${'RSA PRIVATE KEY'}-----`,
  urlPassword: 'hunter2-planted-password',
  assigned: 'plantedAssignedValue9876',
  towerToken: `twr_${'plantedplantedplantedplanted1234'}`,
  bearer: `Bearer ${'plantedBearerValue1234567890'}`,
};

const needles = [
  SECRETS.github,
  SECRETS.awsKey,
  SECRETS.provider,
  SECRETS.slack,
  SECRETS.jwt,
  'MIIEowIBAAKCAQEA7planted7planted7',
  SECRETS.urlPassword,
  SECRETS.assigned,
  SECRETS.towerToken,
  'plantedBearerValue1234567890',
  'keyedPlantedValue',
];

describe('redaction patterns', () => {
  it('replaces each known secret shape', () => {
    expect(redactString(`token ${SECRETS.github} end`)).toBe(
      'token [REDACTED] end',
    );
    expect(redactString(SECRETS.awsKey)).toBe('[REDACTED]');
    expect(redactString(`key=${SECRETS.provider}`)).not.toContain(
      'abcdefghijklmnop',
    );
    expect(redactString(SECRETS.slack)).toBe('[REDACTED]');
    expect(redactString(SECRETS.jwt)).toBe('[REDACTED]');
    expect(redactString(SECRETS.pem)).toBe('[REDACTED]');
    expect(redactString(SECRETS.bearer)).toBe('[REDACTED]');
    expect(redactString(SECRETS.towerToken)).toBe('[REDACTED]');
    expect(redactString(`password = ${SECRETS.assigned}`)).toBe('[REDACTED]');
    expect(redactString(`API_KEY: "${SECRETS.assigned}"`)).not.toContain(
      SECRETS.assigned,
    );
  });

  it('keeps the host of a URL that carried credentials', () => {
    const out = redactString(
      `clone https://deploy:${SECRETS.urlPassword}@git.example.com/org/repo.git`,
    );
    expect(out).not.toContain(SECRETS.urlPassword);
    expect(out).toContain('git.example.com/org/repo.git');
  });

  it('truncated PEM block is still removed', () => {
    expect(redactString(`-----BEGIN ${'PRIVATE KEY'}-----\nabcdef`)).toBe(
      '[REDACTED]',
    );
  });

  it('leaves ordinary text alone', () => {
    const text =
      'ran 12 tests, 0 failed. See src/auth/tokens.ts and the author field.';
    expect(redactString(text)).toBe(text);
  });

  it('redacts nested values, secret-named keys and deep structures, without mutating the input', () => {
    const input = {
      ok: 'fine',
      nested: { list: [`x ${SECRETS.github}`], apiKey: 'keyedPlantedValue' },
      Authorization: 'whatever',
    };
    const snapshot = JSON.stringify(input);
    const out = JSON.stringify(redactValue(input));
    expect(out).not.toContain(SECRETS.github);
    expect(out).not.toContain('keyedPlantedValue');
    expect(out).not.toContain('whatever');
    expect(out).toContain('fine');
    expect(JSON.stringify(input)).toBe(snapshot);

    let deep: Record<string, unknown> = { leaf: SECRETS.github };
    for (let i = 0; i < 20; i += 1) {
      deep = { next: deep };
    }
    expect(JSON.stringify(redactValue(deep))).not.toContain(SECRETS.github);
  });
});

/** Every text value in every table, so a secret cannot hide in a column nobody thought of. */
function everythingStored(h: FleetHarness): string {
  const tables = h.db
    .all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .map((t) => t.name);
  return tables
    .map((t) => JSON.stringify(h.db.all(`SELECT * FROM "${t}"`)))
    .join('\n');
}

async function plant(h: FleetHarness, runner: RunnerClient) {
  const { id } = h.mission([{ scope: ['repo:app'] }]);
  const res = await runner.claim();
  const a = res.body.assignments[0];
  const dirty = (label: string) =>
    [
      `${label} ${SECRETS.github} and ${SECRETS.awsKey}`,
      SECRETS.provider,
      SECRETS.slack,
      SECRETS.jwt,
      SECRETS.pem,
      `https://u:${SECRETS.urlPassword}@host.example/x`,
      `password=${SECRETS.assigned}`,
      SECRETS.towerToken,
      SECRETS.bearer,
    ].join('\n');
  const data = {
    log: dirty('progress'),
    nested: [{ apiKey: 'keyedPlantedValue' }],
  };

  const progress = await runner.progress(a.leaseId, {
    fence: a.fence,
    seq: 1,
    message: dirty('msg'),
    data,
  });
  expect(progress.status).toBe(201);
  // Rejected calls are recorded too, and must not carry the secret into the audit.
  const stale = await runner.progress(a.leaseId, {
    fence: 9,
    seq: 2,
    message: dirty('stale'),
    data,
  });
  expect(stale.status).toBe(409);
  const stalledReceipt = await runner.receipt(a.leaseId, {
    receiptId: 'x',
    fence: 9,
    outcome: 'failed',
    summary: dirty('s'),
    evidence: data,
  });
  expect(stalledReceipt.status).toBe(409);
  const receipt = await runner.receipt(a.leaseId, {
    receiptId: 'rcp',
    fence: a.fence,
    outcome: 'succeeded',
    summary: dirty('summary'),
    evidence: data,
  });
  expect(receipt.status).toBe(201);
  return { missionId: id, leaseId: a.leaseId as string };
}

describe('a planted secret never reaches storage or API output', () => {
  it('is redacted in every table, including the mission event log', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    await plant(h, runner);
    const stored = everythingStored(h);
    for (const needle of needles) {
      expect(stored, needle).not.toContain(needle);
    }
    // The redaction left evidence that something was there.
    expect(stored).toContain('[REDACTED]');
    // A real token is a different matter: Tower stores only digests of those.
    expect(stored).not.toContain(runner.token);
  });

  it('is redacted in everything the API returns', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    const { missionId, leaseId } = await plant(h, runner);
    const outputs = [
      await h.call(h.owner.token, 'GET', `/runners/leases/${leaseId}`),
      await runner.call('GET', `/runners/leases/${leaseId}`),
      await h.call(h.owner.token, 'GET', '/runners/audit?limit=500'),
      await h.call(h.owner.token, 'GET', '/runners/leases'),
      await h.call(h.owner.token, 'GET', `/missions/${missionId}`),
      await h.call(h.owner.token, 'GET', `/missions/${missionId}/activity`),
    ];
    for (const out of outputs) {
      expect(out.status).toBe(200);
      const text = JSON.stringify(out.body);
      for (const needle of needles) {
        expect(text, needle).not.toContain(needle);
      }
    }
    const detail = outputs[0]?.body;
    expect(detail.progress[0].message).toContain('[REDACTED]');
    expect(detail.receipts[0].summary).toContain('[REDACTED]');
  });

  it('is redacted in an operator-supplied quarantine reason and release reason', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    const held = await (async () => {
      h.mission([{}]);
      return (await runner.claim()).body.assignments[0];
    })();
    await h.call(h.owner.token, 'POST', `/runners/${runner.id}/quarantine`, {
      reason: `leaked ${SECRETS.github}`,
    });
    await h.call(
      h.owner.token,
      'POST',
      `/runners/leases/${held.leaseId}/release`,
      { reason: `token=${SECRETS.assigned}` },
    );
    const stored = everythingStored(h);
    expect(stored).not.toContain(SECRETS.github);
    expect(stored).not.toContain(SECRETS.assigned);
  });

  it('keeps credentials out of checkpoint refs by refusing anything but a ref', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    h.mission([{}]);
    const a = (await runner.claim()).body.assignments[0];
    for (const ref of [
      `https://u:${SECRETS.urlPassword}@host/x.git`,
      `refs/heads/${SECRETS.github} x`,
      'refs/../x',
    ]) {
      const res = await runner.checkpoint(a.leaseId, { fence: a.fence, ref });
      expect(res.status, ref).toBe(400);
    }
    expect(everythingStored(h)).not.toContain(SECRETS.urlPassword);
  });
});
