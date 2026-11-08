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
    ['JSON-escaped', 'a\\/b+c=d e'],
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
