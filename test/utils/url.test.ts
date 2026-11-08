import { describe, expect, it } from '@jest/globals';
// noinspection ES6PreferShortImport
import { redactUrl } from '../../src/utils/url.js';

describe('redactUrl', () => {
  it('removes a user name and password', () => {
    expect(redactUrl('https://user:s3cret@github.com/o/r.git')).toBe(
      'https://github.com/o/r.git',
    );
  });

  it('removes a token used as the user name', () => {
    expect(redactUrl('https://ghp_abc@github.com/o/r.git')).toBe(
      'https://github.com/o/r.git',
    );
  });

  it.each([
    'https://github.com/o/r.git',
    'git@github.com:o/r.git',
    'not a url',
  ])('leaves %s as it is', (url) => {
    expect(redactUrl(url)).toBe(url);
  });
});
