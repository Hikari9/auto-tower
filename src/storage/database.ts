export type SqlValue = string | number | bigint | null;

export interface SqlDatabase {
  exec(sql: string): void;
  run(
    sql: string,
    params?: readonly SqlValue[],
  ): { lastInsertRowid: number | bigint };
  get<T>(sql: string, params?: readonly SqlValue[]): T | undefined;
  all<T>(sql: string, params?: readonly SqlValue[]): T[];
  /** Runs `fn` inside one write transaction; rolls back if `fn` throws. */
  transaction<T>(fn: (tx: SqlDatabase) => T): T;
  /**
   * Runs `fn` against one consistent snapshot without taking the write lock, so writers carry on.
   * `fn` must only read. A port without it falls back to `transaction`.
   */
  readTransaction?<T>(fn: (tx: SqlDatabase) => T): T;
  close(): void;
}
