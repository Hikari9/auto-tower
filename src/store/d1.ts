import { mapDriverError, type SqlDriver, type SqlValue, type Stmt } from './sql.ts';

/** Structural subset of the Cloudflare D1 binding that Tower uses. */
export interface D1Like {
  prepare(sql: string): D1StmtLike;
  batch(stmts: D1StmtLike[]): Promise<unknown[]>;
  exec(sql: string): Promise<unknown>;
}
export interface D1StmtLike {
  bind(...values: unknown[]): D1StmtLike;
  all<T = unknown>(): Promise<{ results: T[] }>;
  first<T = unknown>(): Promise<T | null>;
}

/** Cloudflare D1 driver. D1 `batch()` runs as one SQL transaction and rolls back on error. */
export class D1Driver implements SqlDriver {
  readonly d1: D1Like;

  constructor(d1: D1Like) {
    this.d1 = d1;
  }

  async all<T>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    try {
      return (await this.d1.prepare(sql).bind(...params).all<T>()).results;
    } catch (err) {
      return mapDriverError(err);
    }
  }

  async first<T>(sql: string, params: SqlValue[] = []): Promise<T | undefined> {
    try {
      return (await this.d1.prepare(sql).bind(...params).first<T>()) ?? undefined;
    } catch (err) {
      return mapDriverError(err);
    }
  }

  async batch(stmts: Stmt[]): Promise<void> {
    if (stmts.length === 0) return;
    try {
      await this.d1.batch(stmts.map((s) => this.d1.prepare(s.sql).bind(...s.params)));
    } catch (err) {
      mapDriverError(err);
    }
  }

  async exec(sql: string): Promise<void> {
    await this.d1.exec(sql);
  }
}
