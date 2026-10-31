import { describe, expect, it } from 'vitest';
import { categoryOf, isSensitive } from '../../src/policy/actions.js';
import {
  isNarrowerPattern,
  matchesPattern,
} from '../../src/policy/patterns.js';

describe('matchesPattern', () => {
  it.each([
    ['repo:app', 'repo:app', true],
    ['repo:app', 'repo:apps', false],
    ['repo:*', 'repo:app', true],
    ['repo:*', 'repo:', true],
    ['*', '', true],
    ['*', 'anything at all', true],
    ['', '', true],
    ['', 'x', false],
    ['a*c', 'abc', true],
    ['a*c', 'ac', true],
    ['a*c', 'abd', false],
    ['*b*', 'abc', true],
    ['a*b*c', 'a-b-b-c', true],
    ['a**c', 'abc', true],
    ['repo:app/*', 'repo:app', false],
  ])('%s against %s is %s', (pattern, value, expected) => {
    expect(matchesPattern(pattern, value)).toBe(expected);
  });

  it('is case sensitive and treats everything but * literally', () => {
    expect(matchesPattern('Repo:*', 'repo:app')).toBe(false);
    expect(matchesPattern('a.c', 'abc')).toBe(false);
    expect(matchesPattern('a?c', 'abc')).toBe(false);
    expect(matchesPattern('(a+)+$', 'aaaa')).toBe(false);
  });

  it('stays fast on input built to make a naive matcher backtrack', () => {
    const value = 'a'.repeat(512);
    const started = performance.now();
    expect(matchesPattern('a*a*a*a*a*a*a*a*b', value)).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('isNarrowerPattern', () => {
  it.each([
    ['repo:app', 'repo:*', true],
    ['repo:app', 'repo:app', true],
    ['repo:app*', 'repo:*', true],
    ['repo:*', 'repo:app', false],
    ['*', 'repo:*', false],
    ['other:app', 'repo:*', false],
    ['repo:*', 'repo:*', true],
    ['*b*', '*b', false],
  ])('%s within %s is %s', (candidate, original, expected) => {
    expect(isNarrowerPattern(candidate, original)).toBe(expected);
  });
});

describe('categoryOf', () => {
  it.each([
    ['spend', 'spend'],
    ['spend.cloud', 'spend'],
    ['deploy.production', 'production_deploy'],
    ['deploy.production.web', 'production_deploy'],
    ['deploy.prod', 'production_deploy'],
    ['deploy.staging', 'standard'],
    ['security.disable-scan', 'security'],
    ['issue.close', 'external_issue_close'],
    ['issue.close.github', 'external_issue_close'],
    ['issue.comment', 'standard'],
    ['destructive.truncate', 'destructive'],
    ['repo.delete', 'destructive'],
    ['db.drop', 'destructive'],
    ['git.force-push', 'destructive'],
    ['review.independent.approve', 'independent_review'],
    ['review.self', 'standard'],
    ['cleanup.release-lease', 'cleanup'],
    ['cleanupish.thing', 'standard'],
    ['spending.report', 'spend'],
    ['deploy.prod-eu', 'production_deploy'],
    ['deploy.production_eu', 'production_deploy'],
    ['db.drop_table', 'destructive'],
    ['iam.security.disable', 'security'],
    ['billing.spend.create', 'spend'],
    ['deploy.preview', 'standard'],
    ['docs.publish', 'standard'],
  ])('%s is %s', (action, category) => {
    expect(categoryOf(action)).toBe(category);
  });

  it('treats everything but standard and cleanup as sensitive', () => {
    expect(isSensitive('standard')).toBe(false);
    expect(isSensitive('cleanup')).toBe(false);
    for (const category of [
      'spend',
      'production_deploy',
      'security',
      'destructive',
      'external_issue_close',
      'independent_review',
    ] as const) {
      expect(isSensitive(category)).toBe(true);
    }
  });
});
