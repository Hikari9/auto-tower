/** The dev host binds to loopback only, so it is never reachable from the LAN by accident. */
export const LOOPBACK_HOST = '127.0.0.1';

export interface HostConfig {
  dbPath: string;
  port: number;
}

/** Empty environment values count as unset. */
export function readHostConfig(
  env: Readonly<Record<string, string | undefined>>,
): HostConfig {
  return {
    dbPath: env.TOWER_DB_PATH || '.tower/tower.sqlite',
    port: Number(env.PORT || 8787),
  };
}
