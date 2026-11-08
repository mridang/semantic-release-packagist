import { describe, expect, it } from '@jest/globals';
// noinspection ES6PreferShortImport
import { redactUrl, userInfoSecrets } from '../../src/utils/url.js';

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

  it('keeps the user name of a non-web URL but removes its password', () => {
    expect(redactUrl('ssh://git:pw@github.com/o/r.git')).toBe(
      'ssh://git@github.com/o/r.git',
    );
    expect(redactUrl('ssh://git@github.com/o/r.git')).toBe(
      'ssh://git@github.com/o/r.git',
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

describe('userInfoSecrets', () => {
  it('lists the password and the user name of a web URL', () => {
    expect(userInfoSecrets('https://u:p@github.com/o/r.git')).toStrictEqual([
      'p',
      'u',
    ]);
  });

  it('lists only the password of other URLs', () => {
    expect(userInfoSecrets('ssh://git:p@github.com/o/r.git')).toStrictEqual([
      'p',
    ]);
    expect(userInfoSecrets('ssh://git@github.com/o/r.git')).toStrictEqual([]);
  });

  it('is empty for something that is not a URL', () => {
    expect(userInfoSecrets('git@github.com:o/r.git')).toStrictEqual([]);
  });
});
