import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../src/core/errors.js';
import { parseCreateRule } from '../../src/policy/inputs.js';

const RULE = {
  action: 'deploy.staging',
  resource: 'repo:app',
  scope: 'env:staging',
  grantee: { kind: 'chief_of_staff' },
};

const expiry = (expiresAt: string) =>
  parseCreateRule({ ...RULE, expiresAt }).expiresAt;

describe('expiresAt', () => {
  it.each([
    ['0000-02-29T00:00:00Z', '0000-02-29T00:00:00.000Z'],
    ['0004-02-29T00:00:00Z', '0004-02-29T00:00:00.000Z'],
    ['2000-02-29T00:00:00Z', '2000-02-29T00:00:00.000Z'],
    ['2400-02-29T00:00:00Z', '2400-02-29T00:00:00.000Z'],
    ['2030-01-01T10:00Z', '2030-01-01T10:00:00.000Z'],
    ['2030-01-01T10:00+08:00', '2030-01-01T02:00:00.000Z'],
  ])('reads %s', (value, canonical) => {
    expect(expiry(value)).toBe(canonical);
  });

  it.each([
    '0100-02-29T00:00:00Z',
    '1900-02-29T00:00:00Z',
    '2100-02-29T00:00:00Z',
    '2030-04-31T00:00:00Z',
    '2030-02-30T00:00:00Z',
    '2030-06-31T00:00:00Z',
  ])('refuses %s, a day that does not exist', (value) => {
    expect(() => expiry(value)).toThrow(ValidationError);
  });
});
