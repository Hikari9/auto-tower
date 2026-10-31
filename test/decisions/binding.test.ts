import { describe, expect, it } from 'vitest';
import type { WorkPacket } from '../../src/core/types.js';
import {
  packetCovers,
  withinAuthorizedScope,
} from '../../src/decisions/binding.js';
import { hasTraversal } from '../../src/policy/patterns.js';

function packet(id: string, scope: string[], authorized = false): WorkPacket {
  return {
    id,
    missionId: 'msn_1',
    position: 1,
    title: id,
    instructions: '',
    scope,
    required: true,
    status: authorized ? 'ready' : 'pending',
    dependsOn: [],
    authorization: authorized
      ? { at: '2026-03-01T00:00:00.000Z', by: 'prn_owner', policyRefs: [] }
      : null,
    verification: null,
    activeAttemptId: null,
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-01T00:00:00.000Z',
  };
}

describe('hasTraversal', () => {
  it.each([
    ['src/..', true],
    ['../x', true],
    ['a/../b', true],
    ['a\\..\\b', true],
    ['..', true],
    ['a/..b', false],
    ['a/.hidden', false],
    ['a/b..c', false],
    ['src/utils', false],
  ])('%s is %s', (value, expected) => {
    expect(hasTraversal(value)).toBe(expected);
  });
});

describe('packetCovers', () => {
  it('needs a declared scope that matches the request', () => {
    expect(packetCovers(packet('p', ['env:staging']), 'env:staging')).toBe(
      true,
    );
    expect(packetCovers(packet('p', ['env:*']), 'env:staging')).toBe(true);
    expect(packetCovers(packet('p', ['env:production']), 'env:staging')).toBe(
      false,
    );
    expect(packetCovers(packet('p', []), 'env:staging')).toBe(false);
  });

  it.each(['*', '**', '*:*', '*/*', '*.*', '.*', '..*', ''])(
    'does not count a scope of %j as declaring anything',
    (pattern) => {
      expect(packetCovers(packet('p', [pattern]), 'env:staging')).toBe(false);
      expect(packetCovers(packet('p', [pattern]), 'a/b')).toBe(false);
    },
  );

  it.each(['*e*', '*a*', '*0*', 'a*', 'ab*', '*src', '*/utils'])(
    'does not count %s, which names too little to bind anything',
    (pattern) => {
      expect(packetCovers(packet('p', [pattern]), 'repo/docs/x')).toBe(false);
      expect(
        withinAuthorizedScope(
          undefined,
          [packet('s', [pattern], true)],
          'repo/docs/x',
        ),
      ).toBe(false);
    },
  );

  it.each(['src/*', 'env:*', 'infra', 'ci', 'abc*'])(
    'counts %s as declaring something',
    (pattern) => {
      expect(
        packetCovers(packet('p', [pattern]), pattern.replace('*', 'x')),
      ).toBe(true);
    },
  );

  it.each(['src/.*', 'src/..*', 'src/*.*', 'src/*..*'])(
    'does not count %s, which could expand to a parent path',
    (pattern) => {
      expect(packetCovers(packet('p', [pattern]), 'src/.hidden')).toBe(false);
      expect(packetCovers(packet('p', ['src/*']), 'src/.hidden')).toBe(true);
    },
  );

  it('rejects a request that climbs out of the declared subtree', () => {
    const p = packet('p', ['src/*']);
    expect(packetCovers(p, 'src/utils')).toBe(true);
    expect(packetCovers(p, 'src/../../etc/x')).toBe(false);
    expect(packetCovers(packet('p', ['src*']), 'src\\..\\x')).toBe(false);
    expect(packetCovers(packet('p', ['src/../x']), 'src/../x')).toBe(false);
  });
});

describe('withinAuthorizedScope', () => {
  const base = packet('base', ['src/*'], true);

  it('needs an authorized sibling whose scope covers the request', () => {
    expect(withinAuthorizedScope(undefined, [base], 'src/utils')).toBe(true);
    expect(withinAuthorizedScope(undefined, [base], 'infra/x')).toBe(false);
    expect(withinAuthorizedScope(undefined, [], 'src/utils')).toBe(false);
  });

  it('ignores siblings that are not authorized, and the packet itself', () => {
    const waiting = packet('waiting', ['infra/*']);
    expect(withinAuthorizedScope(undefined, [base, waiting], 'infra/x')).toBe(
      false,
    );
    const self = packet('self', ['infra/*'], true);
    expect(withinAuthorizedScope(self, [base, self], 'infra/x')).toBe(false);
  });

  it.each(['*', '**', '*:*', '.*'])(
    'does not count a sibling scope of %j',
    (pattern) => {
      const wide = packet('wide', [pattern], true);
      expect(withinAuthorizedScope(undefined, [wide], 'anything/x')).toBe(
        false,
      );
      expect(
        withinAuthorizedScope(
          packet('t', ['anything/x']),
          [wide],
          'anything/x',
        ),
      ).toBe(false);
    },
  );

  it('rejects traversal in the request and in the target packet', () => {
    expect(withinAuthorizedScope(undefined, [base], 'src/../etc')).toBe(false);
    expect(
      withinAuthorizedScope(packet('t', ['src/../etc']), [base], 'src/utils'),
    ).toBe(false);
  });

  it('needs every scope the target declares to stay inside, and some scope declared', () => {
    expect(
      withinAuthorizedScope(packet('t', ['src/a']), [base], 'src/utils'),
    ).toBe(true);
    expect(
      withinAuthorizedScope(
        packet('t', ['src/a', 'infra/b']),
        [base],
        'src/utils',
      ),
    ).toBe(false);
    expect(withinAuthorizedScope(packet('t', []), [base], 'src/utils')).toBe(
      false,
    );
  });
});
