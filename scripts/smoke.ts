import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { runScenario } from '../test/e2e/scenario.js';

/**
 * `pnpm smoke`: the whole control plane in one process, end to end, with no network and no paid
 * service. Exits non-zero at the first check that fails.
 */
async function main(): Promise<void> {
  const report = await runScenario((line) => console.log(`ok  ${line}`));
  rmSync(dirname(report.backupPath), { recursive: true, force: true });
  console.log(
    `smoke passed: ${report.steps.length} steps, state ${report.fingerprint.slice(0, 12)}`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
