import { describe, expect, it } from '@jest/globals';
import { resolveCredentials } from '../src/plugin-config.js';

describe('resolveCredentials', () => {
  it('reads the plugin configuration', () => {
    expect(
      resolveCredentials({ username: 'u', apiToken: 't' }, {}),
    ).toStrictEqual({ username: 'u', apiToken: 't' });
  });

  it('falls back to the environment variables', () => {
    expect(
      resolveCredentials(
        {},
        { PACKAGIST_USERNAME: 'env-u', PACKAGIST_TOKEN: 'env-t' },
      ),
    ).toStrictEqual({ username: 'env-u', apiToken: 'env-t' });
  });

  it('prefers the configuration over the environment', () => {
    expect(
      resolveCredentials(
        { username: 'u', apiToken: 't' },
        { PACKAGIST_USERNAME: 'env-u', PACKAGIST_TOKEN: 'env-t' },
      ),
    ).toStrictEqual({ username: 'u', apiToken: 't' });
  });

  it('refuses a missing username', () => {
    expect(() =>
      resolveCredentials({ username: '', apiToken: 't' }, {}),
    ).toThrow(
      expect.objectContaining({
        code: 'ENOPACKAGISTUSERNAME',
        message: 'Packagist username is not set.',
      }),
    );
  });

  it('refuses a missing token', () => {
    expect(() =>
      resolveCredentials({ username: 'u', apiToken: '' }, {}),
    ).toThrow(
      expect.objectContaining({
        code: 'ENOPACKAGISTAPITOKEN',
        message: 'Packagist API token is not set.',
      }),
    );
  });
});
