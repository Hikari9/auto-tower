import type { SqlValue } from './sql.ts';

/**
 * Maps camelCase domain objects to snake_case rows. Fields listed in `json` are
 * stored as `<snake>_json`; `bool` fields are stored as 0/1; `omit` fields are
 * not columns (loaded separately).
 */
export interface EntitySpec {
  table: string;
  json: readonly string[];
  bool?: readonly string[];
  omit?: readonly string[];
}

const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

export function toRow(spec: EntitySpec, obj: object): Record<string, SqlValue> {
  const row: Record<string, SqlValue> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (spec.omit?.includes(k)) continue;
    if (spec.json.includes(k)) row[`${snake(k)}_json`] = v === null || v === undefined ? null : JSON.stringify(v);
    else if (spec.bool?.includes(k)) row[snake(k)] = v ? 1 : 0;
    else row[snake(k)] = (v ?? null) as SqlValue;
  }
  return row;
}

export function fromRow<T>(spec: EntitySpec, row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [col, v] of Object.entries(row)) {
    if (col.endsWith('_json')) {
      const base = col.slice(0, -5);
      const key = camel(base);
      out[key] = typeof v === 'string' ? JSON.parse(v) : null;
    } else {
      const key = camel(col);
      out[key] = spec.bool?.includes(key) ? Boolean(v) : v;
    }
  }
  return out as T;
}

const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

export function upsertSql(table: string, row: Record<string, SqlValue>): { sql: string; params: SqlValue[] } {
  const cols = Object.keys(row);
  const updates = cols.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`);
  return {
    sql: `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) ON CONFLICT(id) DO UPDATE SET ${updates.join(', ')}`,
    params: cols.map((c) => row[c] ?? null),
  };
}

export const SPECS = {
  mission: { table: 'missions', json: ['constraints', 'risks', 'dod', 'acceptance', 'authority', 'blockers', 'dependsOn', 'verification', 'discrepancies'] },
  packet: {
    table: 'packets',
    json: ['scope', 'acceptance', 'capabilities', 'dependsOn', 'blockedBy', 'checkpoint', 'result', 'gate'],
    bool: ['reviewRequired'],
  },
  attempt: { table: 'attempts', json: ['contract', 'checkpoint', 'receipt'] },
  runner: { table: 'runners', json: ['engines', 'capabilities', 'allowedScopes'] },
  decision: {
    table: 'decisions',
    json: ['alternatives', 'recommendation', 'requiredAuthority', 'evidence', 'onApprove', 'answer', 'ruleRef'],
    omit: ['linkedPackets'],
  },
  rule: { table: 'policy_rules', json: ['conditions'] },
  link: { table: 'issue_links', json: ['exemption'] },
  principal: { table: 'principals', json: ['scopes'] },
} as const satisfies Record<string, EntitySpec>;
