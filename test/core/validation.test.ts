import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../src/core/errors.js';
import {
  parseActivity,
  parseAddPacket,
  parseCreateMission,
  parseSearch,
  parseTransition,
  parseUpdateMission,
} from '../../src/core/inputs.js';

const valid = { title: 'T', intent: 'I', outcome: 'O' };

function issues(fn: () => unknown): Array<[string, string]> {
  try {
    fn();
  } catch (error) {
    if (error instanceof ValidationError) {
      return error.issues.map((i) => [i.path, i.message]);
    }
    throw error;
  }
  throw new Error('expected a validation error');
}

describe('parseCreateMission', () => {
  it('applies defaults', () => {
    expect(parseCreateMission(valid)).toEqual({
      title: 'T',
      intent: 'I',
      outcome: 'O',
      constraints: [],
      risk: 'medium',
      size: 'm',
      priority: 'normal',
      definitionOfDone: [],
      source: 'api',
      parentId: null,
      requiredForParent: true,
      links: [],
      policyRefs: [],
    });
  });

  it('reports every problem at once, with paths', () => {
    expect(
      issues(() =>
        parseCreateMission({
          title: '',
          risk: 'extreme',
          links: [{ url: 'nope', classification: 'x' }],
          extra: 1,
        }),
      ),
    ).toEqual(
      expect.arrayContaining([
        ['title', 'must not be empty'],
        ['intent', 'is required'],
        ['outcome', 'is required'],
        ['risk', expect.stringContaining('must be one of')],
        ['links[0].url', 'must be an absolute URL'],
        ['links[0].classification', expect.stringContaining('must be one of')],
        ['extra', 'is not a recognised field'],
      ]),
    );
  });

  it.each([null, [], 'text', 7])('rejects a non-object body: %j', (body) => {
    expect(issues(() => parseCreateMission(body))[0]).toEqual([
      '',
      'must be a JSON object',
    ]);
  });

  it('rejects whitespace-only and oversized text', () => {
    expect(
      issues(() => parseCreateMission({ ...valid, title: '   ' })),
    ).toEqual([['title', 'must not be empty']]);
    expect(
      issues(() => parseCreateMission({ ...valid, title: 'x'.repeat(201) })),
    ).toEqual([['title', 'must be at most 200 characters']]);
  });

  it('rejects wrong types instead of coercing them', () => {
    expect(
      issues(() =>
        parseCreateMission({
          ...valid,
          constraints: 'a',
          requiredForParent: 'yes',
          title: 5,
        }),
      ),
    ).toEqual(
      expect.arrayContaining([
        ['title', 'must be a string'],
        ['constraints', 'must be an array of strings'],
        ['requiredForParent', 'must be a boolean'],
      ]),
    );
  });

  it('bounds list sizes', () => {
    expect(
      issues(() =>
        parseCreateMission({
          ...valid,
          constraints: Array.from({ length: 101 }, () => 'c'),
        }),
      ),
    ).toEqual([['constraints', 'must have at most 100 items']]);
  });

  describe('links', () => {
    const link = (url: string) =>
      parseCreateMission({
        ...valid,
        links: [{ url, classification: 'required' }],
      });

    it('keeps https, drops the fragment, and records a null title', () => {
      expect(
        link('https://github.com/o/r/issues/1#issuecomment-5').links,
      ).toEqual([
        {
          url: 'https://github.com/o/r/issues/1',
          classification: 'required',
          title: null,
        },
      ]);
    });

    it('rejects plain http', () => {
      expect(issues(() => link('http://tracker.example/x'))).toEqual([
        ['links[0].url', 'must use https'],
      ]);
    });

    it.each([
      'javascript:alert(1)',
      'file:///etc/passwd',
      'ftp://host/x',
      'data:text/plain,hi',
    ])('rejects the scheme in %s', (url) => {
      expect(issues(() => link(url))).toEqual([
        ['links[0].url', 'must use https'],
      ]);
    });

    it.each([
      'https://localhost/x',
      'https://127.0.0.1/x',
      'https://[::1]/x',
      'https://10.0.0.5/x',
      'https://192.168.1.1/x',
      'https://169.254.169.254/latest/meta-data',
      'https://2130706433/x',
      'https://intranet.internal/x',
      'https://tracker/x',
      'https://example.com:8443/x',
    ])('rejects the non-public host in %s', (url) => {
      const found = issues(() => link(url));
      expect(found).toHaveLength(1);
      expect(found[0]?.[0]).toBe('links[0].url');
    });

    it('rejects credentials in the URL', () => {
      expect(issues(() => link('https://user:secret@github.com/o/r'))).toEqual([
        ['links[0].url', 'must not contain credentials'],
      ]);
    });

    it('rejects a duplicate link after normalization', () => {
      expect(
        issues(() =>
          parseCreateMission({
            ...valid,
            links: [
              { url: 'https://example.com/a#x', classification: 'required' },
              { url: 'https://example.com/a', classification: 'optional' },
            ],
          }),
        ),
      ).toEqual([['links', 'lists https://example.com/a more than once']]);
    });
  });
});

describe('parseUpdateMission', () => {
  it('applies the public https check to links', () => {
    expect(
      issues(() =>
        parseUpdateMission({
          expectedVersion: 1,
          links: [
            {
              url: 'http://github.com/o/r/issues/1',
              classification: 'required',
            },
            { url: 'https://127.0.0.1/x', classification: 'optional' },
          ],
        }),
      ),
    ).toEqual([
      ['links[0].url', 'must use https'],
      ['links[1].url', 'must name a DNS host, not an IP address'],
    ]);
  });

  it('requires an expected version and at least one change', () => {
    expect(issues(() => parseUpdateMission({ title: 'x' }))).toEqual([
      ['expectedVersion', 'is required'],
    ]);
    expect(issues(() => parseUpdateMission({ expectedVersion: 1 }))).toEqual([
      ['', 'must change at least one field'],
    ]);
  });

  it('carries only the fields that were sent', () => {
    expect(
      parseUpdateMission({
        expectedVersion: 3,
        priority: 'high',
        policyRefs: [],
      }),
    ).toEqual({
      expectedVersion: 3,
      changes: { priority: 'high', policyRefs: [] },
    });
  });

  it.each([0, -1, 1.5, '2', null])('rejects expectedVersion %j', (value) => {
    expect(
      issues(() =>
        parseUpdateMission({ expectedVersion: value, title: 'x' }),
      )[0]?.[0],
    ).toBe('expectedVersion');
  });

  it('refuses to change immutable fields', () => {
    expect(
      issues(() =>
        parseUpdateMission({
          expectedVersion: 1,
          parentId: 'x',
          state: 'completed',
        }),
      ),
    ).toEqual(
      expect.arrayContaining([
        ['parentId', 'is not a recognised field'],
        ['state', 'is not a recognised field'],
      ]),
    );
  });
});

describe('other inputs', () => {
  it('parses a transition and rejects an unknown state', () => {
    expect(parseTransition({ expectedVersion: 2, to: 'ready' })).toEqual({
      expectedVersion: 2,
      to: 'ready',
      reason: null,
    });
    expect(
      issues(() => parseTransition({ expectedVersion: 2, to: 'done' }))[0]?.[0],
    ).toBe('to');
  });

  it('parses packets with defaults and rejects a repeated dependency', () => {
    expect(parseAddPacket({ expectedVersion: 1, title: 'A' }).packet).toEqual({
      title: 'A',
      instructions: '',
      scope: [],
      required: true,
      dependsOn: [],
    });
    expect(
      issues(() =>
        parseAddPacket({
          expectedVersion: 1,
          title: 'A',
          dependsOn: ['x', 'x'],
        }),
      ),
    ).toEqual([['dependsOn', 'lists a packet more than once']]);
  });

  it('reads search parameters with bounds', () => {
    expect(
      parseSearch({
        q: 'launch',
        state: 'ready,running',
        limit: '5',
        offset: '10',
      }),
    ).toEqual({
      text: 'launch',
      states: ['ready', 'running'],
      limit: 5,
      offset: 10,
    });
    expect(parseSearch({})).toEqual({ limit: 25, offset: 0 });
    expect(issues(() => parseSearch({ limit: '0' }))).toEqual([
      ['limit', 'must be an integer from 1 to 100'],
    ]);
    expect(issues(() => parseSearch({ limit: '1e3' }))).toEqual([
      ['limit', 'must be an integer from 1 to 100'],
    ]);
    expect(issues(() => parseSearch({ state: 'ready,bogus' }))).toEqual([
      ['state', 'bogus is not a mission state'],
    ]);
    expect(issues(() => parseSearch({ nope: '1' }))).toEqual([
      ['nope', 'is not a recognised field'],
    ]);
  });

  it('reads activity paging parameters', () => {
    expect(parseActivity({ after: '4', limit: '10' })).toEqual({
      afterVersion: 4,
      limit: 10,
    });
    expect(parseActivity({})).toEqual({ afterVersion: 0, limit: 50 });
    expect(issues(() => parseActivity({ after: '-1' }))[0]?.[0]).toBe('after');
  });
});
