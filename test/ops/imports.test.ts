import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** Every module `entry` reaches through static imports and re-exports, and the node: modules among them. */
function reach(entry: string) {
  const seen = new Set<string>();
  const nodeModules = new Map<string, string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(
      /(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/g,
    )) {
      const spec = match[1] as string;
      if (spec.startsWith('node:')) {
        nodeModules.set(spec, file);
      } else if (spec.startsWith('.')) {
        const target = join(dirname(file), spec.replace(/\.js$/, '.ts'));
        if (existsSync(target)) {
          queue.push(target);
        }
      }
    }
  }
  return { seen, nodeModules };
}

describe('what createApp pulls into a bundle', () => {
  // The Workers entry will build the app over D1. Anything the app imports must run there: no
  // file system, no node:sqlite, no child processes. Hosts add Node-only routes themselves.
  it('reaches no Node-only module, so the Workers bundle can include the app', () => {
    const { seen, nodeModules } = reach(join(ROOT, 'src/api/app.ts'));
    const forbidden = [
      'node:fs',
      'node:sqlite',
      'node:child_process',
      'node:path',
      'node:url',
      'node:util',
      'node:os',
      'node:net',
      'node:http',
    ];
    const found = [...nodeModules].filter(([name]) => forbidden.includes(name));
    expect(found, JSON.stringify(found)).toEqual([]);
    // The check walks real code: it must have seen the ops tools it is guarding against.
    expect([...seen].some((f) => f.endsWith('src/mcp/tools/ops.ts'))).toBe(
      true,
    );
    expect([...seen].some((f) => f.endsWith('src/ops/halt.ts'))).toBe(true);
  });

  it('does not reach the CLI or the backup tool, which read and write files', () => {
    const { seen } = reach(join(ROOT, 'src/api/app.ts'));
    const names = [...seen].map((f) => f.slice(ROOT.length + 1));
    expect(names).not.toContain('src/ops/cli.ts');
    expect(names).not.toContain('src/ops/index.ts');
  });

  it('is able to see a violation: the CLI itself reaches node:fs', () => {
    expect(reach(join(ROOT, 'src/ops/cli.ts')).nodeModules.has('node:fs')).toBe(
      true,
    );
  });
});
