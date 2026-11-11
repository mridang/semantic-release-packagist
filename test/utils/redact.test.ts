/**
 * Unit tests for the credential and secret redaction helpers.
 * @file
 */
import { describe, expect, it } from '@jest/globals';
// noinspection ES6PreferShortImport
import { redactCredentials, redactSecrets } from '../../src/utils/redact.js';

const SECRET = 'a/b+c=d e';

describe('redactCredentials', () => {
  it.each([
    ['https://user:pw0rd@host/o/r.git', 'https://***@host/o/r.git'],
    [
      'https://x-access-token:abc123@github.com/o/r',
      'https://***@github.com/o/r',
    ],
    ['https://user:p@ss@host/o/r.git', 'https://***@host/o/r.git'],
    ['https://user:p%40ss@host/o/r.git', 'https://***@host/o/r.git'],
    ['HTTPS://user:pw0rd@host/o/r.git', 'HTTPS://***@host/o/r.git'],
    ['git+https://user:pw0rd@host/o/r', 'git+https://***@host/o/r'],
    [
      'oci://u:TOKENINURL@localhost:5000/charts',
      'oci://***@localhost:5000/charts',
    ],
    ['https://token123@host/o/r', 'https://***@host/o/r'],
    ['clone https://u:pw0rd@h/x failed', 'clone https://***@h/x failed'],
    ['https://host/o/r?token=abc123&x=1', 'https://host/o/r?token=***&x=1'],
    ['https://host/o?access_token=abc123', 'https://host/o?access_token=***'],
    ['AUTHORIZATION: basic dXNlcjpwdw==', 'AUTHORIZATION: ***'],
    ['< Authorization: Bearer abcdef', '< Authorization: ***'],
    ['using Bearer abc.def-ghi', 'using Bearer ***'],
    ['token ghp_abcdefghijklmnopqrstuvwxyz0123456789 here', 'token *** here'],
    ['github_pat_11ABCDEFG0abcdefghijklmnop_qrstuvwxyz', '***'],
    ['glpat-abcdefghijklmnopqrstuv', '***'],
  ])('redacts %s', (input, expected) => {
    expect(redactCredentials(input)).toBe(expected);
  });

  it.each([
    'https://github.com/o/r.git',
    'git@github.com:o/r.git',
    'plain text with no secrets',
    'ssh://git@github.com/o/r.git'.replace('git@', ''),
  ])('leaves %s unchanged', (input) => {
    expect(redactCredentials(input)).toBe(input);
  });
});

describe('redactSecrets', () => {
  it.each([
    ['as it is', SECRET],
    ['percent-encoded', encodeURIComponent(SECRET)],
    ['form-encoded', new URLSearchParams({ s: SECRET }).toString().slice(2)],
    ['JSON-escaped', String.raw`a\/b+c=d e`],
  ])('removes the secret %s', (_form, echoed) => {
    expect(redactSecrets(`bad ?token=${echoed}&x`, [SECRET])).toBe(
      'bad ?token=[redacted]&x',
    );
  });

  it('removes every secret and every occurrence', () => {
    expect(redactSecrets('a b a c', ['a', 'c'])).toBe(
      '[redacted] b [redacted] [redacted]',
    );
  });

  it('ignores empty secrets', () => {
    expect(redactSecrets('text', [''])).toBe('text');
  });
});

describe('redactCredentials user information scan', () => {
  // Built from strings on purpose: this is the slow pattern the code used to hold.
  const oldPattern = (...parts: string[]): RegExp =>
    new RegExp(parts.join(''), 'gi');
  const scheme = String.raw`([a-z][a-z0-9+.-]*:\/\/)`;
  const withPassword = String.raw`[^\s/@:]*:\S*@`;
  const token = String.raw`[^\s/@:]+@`;
  const reference = (text: string): string =>
    text
      .replaceAll(oldPattern(scheme, withPassword), '$1***@')
      .replaceAll(oldPattern(scheme, token), '$1***@');
  const pieces = [
    'http',
    'git+ssh',
    'S',
    'a',
    '1',
    '+',
    '.',
    '-',
    ':',
    '://',
    '/',
    '@',
    ' ',
    '\n',
    '\u00A0',
    'é',
    '*',
  ];

  it('gives the same result as the regular expressions it replaced', () => {
    let seed = 12_345;
    const below = (limit: number): number => {
      seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
      return seed % limit;
    };
    for (let round = 0; round < 20_000; round++) {
      const input = Array.from(
        { length: 1 + below(14) },
        () => pieces[below(pieces.length)],
      ).join('');
      expect([input, redactCredentials(input)]).toEqual([
        input,
        reference(input),
      ]);
    }
  });

  it.each([
    'https://:pw@host',
    'https://u:@host',
    '1http://u:p@h',
    '+.-a://u:p@h',
    '1+2://u:p@h',
    'a://b://u:p@h',
    'a://u:p@b@c d://x@y',
    'https://u:p@h\nhttps://v@h',
    'https://u:p h@x',
    'x:// ://u:p@h',
  ])('matches the old behaviour on %j', (input) => {
    expect(redactCredentials(input)).toBe(reference(input));
  });

  it('stays fast on a very long run of scheme characters', () => {
    const input = 'a'.repeat(200_000);
    const started = Date.now();

    expect(redactCredentials(input)).toBe(input);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('stays fast on a very long run of candidate URLs without an at sign', () => {
    const input = 'a://:'.repeat(40_000);
    const started = Date.now();

    expect(redactCredentials(input)).toBe(input);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('stays fast on a very long password, and keeps the last at sign', () => {
    const input = `https://u:${'p@'.repeat(100_000)}host/x`;
    const started = Date.now();

    expect(redactCredentials(input)).toBe('https://***@host/x');
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
