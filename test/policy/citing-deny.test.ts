import { describe, expect, it } from 'vitest';
import { patternsOverlap } from '../../src/policy/patterns.js';
import { createAuthorityHarness, grant, request } from './helpers.js';

describe('patternsOverlap', () => {
  it.each([
    ['a.b', 'a.*', true],
    ['a.*', 'a.b', true],
    ['a.*', 'a.*', true],
    ['*', 'anything', true],
    ['a.b*', '*b.c', true],
    ['a.b', 'a.c', false],
    ['a.*', 'b.*', false],
    ['a*z', 'a*y', false],
    ['', '*', true],
    ['', 'a', false],
  ])('%s and %s: %s', (a, b, expected) => {
    expect(patternsOverlap(a, b)).toBe(expected);
    expect(patternsOverlap(b, a)).toBe(expected);
  });
});

describe('a cited rule and a narrower deny', () => {
  function setup() {
    const h = createAuthorityHarness();
    const allow = grant(h, {
      action: 'a.*',
      resource: 'repo:app',
      scope: 'src/*',
    });
    const cite = (scope = 'src/x') =>
      h.authority.policy.authorize(
        request({
          principal: h.cos.id,
          action: allow.action,
          resource: allow.resource,
          scope,
        }),
        { citing: allow.id },
      );
    return { h, allow, cite };
  }

  it('grants while nothing denies', () => {
    const { cite } = setup();
    expect(cite()).toMatchObject({ effect: 'allow', code: 'granted' });
  });

  it('denies a broad allow pattern when a deny rule names one action inside it', () => {
    const { h, cite } = setup();
    const deny = grant(h, { effect: 'deny', action: 'a.b', scope: 'src/*' });
    expect(cite()).toMatchObject({
      effect: 'deny',
      code: 'explicit_deny',
      ruleId: deny.id,
    });
  });

  it('denies when only the resource or the scope of the deny is narrower', () => {
    const resource = setup();
    grant(resource.h, {
      effect: 'deny',
      action: 'a.*',
      resource: 'repo:app',
      scope: 'src/secret',
    });
    expect(resource.cite('src/secret')).toMatchObject({
      code: 'explicit_deny',
    });
    // A scope the deny cannot reach is still allowed.
    expect(resource.cite('src/other')).toMatchObject({ code: 'granted' });
  });

  it('denies when only the resource of the deny is narrower than the cited rule', () => {
    const h = createAuthorityHarness();
    const allow = grant(h, {
      action: 'a.*',
      resource: 'repo:*',
      scope: 'src/*',
    });
    const cite = () =>
      h.authority.policy.authorize(
        request({
          principal: h.cos.id,
          action: allow.action,
          resource: allow.resource,
          scope: 'src/x',
        }),
        { citing: allow.id },
      );
    expect(cite()).toMatchObject({ code: 'granted' });
    grant(h, {
      effect: 'deny',
      action: 'a.*',
      resource: 'repo:app',
      scope: 'src/*',
    });
    expect(cite()).toMatchObject({ code: 'explicit_deny' });
  });

  it('ignores a deny on an unrelated resource', () => {
    const h = createAuthorityHarness();
    const allow = grant(h, {
      action: 'a.*',
      resource: 'repo:*',
      scope: 'src/*',
    });
    grant(h, {
      effect: 'deny',
      action: 'a.*',
      resource: 'host:prod',
      scope: 'src/*',
    });
    expect(
      h.authority.policy.authorize(
        request({
          principal: h.cos.id,
          action: allow.action,
          resource: allow.resource,
          scope: 'src/x',
        }),
        { citing: allow.id },
      ),
    ).toMatchObject({ code: 'granted' });
  });

  it('ignores a deny rule that cannot match anything the cited rule covers', () => {
    const { h, cite } = setup();
    grant(h, { effect: 'deny', action: 'b.c', scope: 'src/*' });
    expect(cite()).toMatchObject({ effect: 'allow', code: 'granted' });
  });

  it('does not widen an ordinary request: a literal action still needs its own match', () => {
    const { h } = setup();
    grant(h, { effect: 'deny', action: 'a.b', scope: 'src/*' });
    const literal = h.authority.policy.authorize(
      request({
        principal: h.cos.id,
        action: 'a.c',
        resource: 'repo:app',
        scope: 'src/x',
      }),
    );
    expect(literal).toMatchObject({ effect: 'allow', code: 'granted' });
  });
});
