import { describe, expect, it } from '@jest/globals';
// noinspection ES6PreferShortImport
import { redactCredentials } from '../../src/utils/redact.js';

const SECRET = 'a/b+c=d e';

describe('redactCredentials', () => {
  it.each([
    ['as it is', SECRET],
    ['percent-encoded', encodeURIComponent(SECRET)],
    ['form-encoded', new URLSearchParams({ s: SECRET }).toString().slice(2)],
    ['JSON-escaped', 'a\\/b+c=d e'],
  ])('removes the secret %s', (_form, echoed) => {
    expect(redactCredentials(`bad ?token=${echoed}&x`, [SECRET])).toBe(
      'bad ?token=[redacted]&x',
    );
  });

  it('removes every secret and every occurrence', () => {
    expect(redactCredentials('a b a c', ['a', 'c'])).toBe(
      '[redacted] b [redacted] [redacted]',
    );
  });

  it('ignores empty secrets', () => {
    expect(redactCredentials('text', [''])).toBe('text');
  });
});
