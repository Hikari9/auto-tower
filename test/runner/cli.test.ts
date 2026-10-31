import { describe, expect, it } from 'vitest';
import { main, parseCli, UsageError } from '../../src/runner/cli.js';

const base = [
  '--url',
  'https://tower.example',
  '--state',
  '/tmp/s.json',
  '--version',
  '1.2.3',
  '--digest',
  `sha256:${'a'.repeat(64)}`,
];

describe('parseCli', () => {
  it('reads a run command with repeated capabilities', () => {
    const options = parseCli([
      'run',
      ...base,
      '--repo',
      '/repo',
      '--capability',
      'cap:node',
      '--capability',
      'cap:git',
    ]);
    expect(options).toMatchObject({
      command: 'run',
      url: 'https://tower.example',
      version: '1.2.3',
      repoPath: '/repo',
      capabilities: ['cap:node', 'cap:git'],
      officeBinary: 'office',
    });
  });

  it.each([
    ['an unknown command', ['deploy', ...base]],
    ['an unknown flag', ['run', ...base, '--token', 'x']],
    ['a flag with no value', ['run', ...base.slice(0, -1)]],
    [
      'a missing required flag',
      ['run', '--url', 'https://t', '--state', 's', '--version', '1.2.3'],
    ],
  ])('refuses %s', (_name, argv) => {
    expect(() => parseCli(argv)).toThrow(UsageError);
  });

  it('does not take the enrollment token from the command line', () => {
    expect(() => parseCli(['register', ...base, '--token', 'secret'])).toThrow(
      UsageError,
    );
  });
});

describe('main', () => {
  it('exits 2 and prints usage on a bad command line', async () => {
    const lines: string[] = [];
    const code = await main(
      ['nope'],
      {},
      { log: () => {}, error: (l) => lines.push(l) },
    );
    expect(code).toBe(2);
    expect(lines.join('\n')).toMatch(/usage:/);
  });

  it('refuses to register without an enrollment token in the environment', async () => {
    const lines: string[] = [];
    const code = await main(
      ['register', ...base],
      {},
      { log: () => {}, error: (l) => lines.push(l) },
    );
    expect(code).toBe(2);
    expect(lines.join('\n')).toMatch(/TOWER_ENROLLMENT_TOKEN/);
  });
});
