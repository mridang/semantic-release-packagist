import { describe, expect, it } from '@jest/globals';
import {
  cwdOf,
  requireRepositoryUrl,
  resolveCredentials,
} from '../src/plugin-config.js';

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

  it('treats null from a config file like a missing value', () => {
    const fromFile = JSON.parse('{"username":null,"apiToken":null}');
    expect(
      resolveCredentials(fromFile, {
        PACKAGIST_USERNAME: 'env-u',
        PACKAGIST_TOKEN: 'env-t',
      }),
    ).toStrictEqual({ username: 'env-u', apiToken: 'env-t' });
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

describe('cwdOf', () => {
  it('uses the directory of the context', () => {
    expect(cwdOf({ cwd: '/work' })).toBe('/work');
  });

  it('falls back to the current directory', () => {
    expect(cwdOf({})).toBe(process.cwd());
  });
});

describe('requireRepositoryUrl', () => {
  it('returns the repository URL', () => {
    expect(requireRepositoryUrl({ repositoryUrl: 'https://x/y.git' })).toBe(
      'https://x/y.git',
    );
  });

  it('refuses a missing one', () => {
    expect(() => requireRepositoryUrl({})).toThrow(
      expect.objectContaining({
        code: 'ENOREPOSITORYURL',
        message: 'Repository URL could not be determined.',
      }),
    );
  });
});
