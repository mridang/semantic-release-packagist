import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import plugin, { prepare, publish, verifyConditions } from '../src/index.js';
import type { StepLogger } from '../src/plugin-config.js';
import { PackagistClient } from '../src/packagist.js';
import {
  REPOSITORY_URL,
  prepareContext,
  publishContext,
  verifyContext,
} from './utils/context.js';
import { withComposer } from './utils/composer.js';
import { withTmp } from './utils/tmpdir.js';

afterEach(() => {
  jest.restoreAllMocks();
});

const CONFIG = { username: 'test-user', apiToken: 'test-token' };
const COMPOSER = JSON.stringify({ name: 'test/pkg', version: '1.0.0' });
type CustomCommand = (cwd: string, logger: StepLogger) => Promise<void>;
const passes = async (): Promise<void> => undefined;

/**
 * Remove the Packagist variables from the environment for one test.
 */
function withoutPackagistEnv(): void {
  const { PACKAGIST_USERNAME, PACKAGIST_TOKEN, ...rest } = process.env;
  void PACKAGIST_USERNAME;
  void PACKAGIST_TOKEN;
  jest.replaceProperty(process, 'env', rest);
}

describe('the plugin', () => {
  it('exposes every step as a default export too', () => {
    expect(plugin).toStrictEqual({ verifyConditions, prepare, publish });
  });
});

describe('verifyConditions', () => {
  it('passes with a valid composer.json, credentials and repository URL', async () => {
    await withTmp({ 'composer.json': COMPOSER }, async (cwd) => {
      const command = jest.fn<CustomCommand>().mockResolvedValue();
      const { context, lines } = verifyContext({ cwd });
      await expect(
        verifyConditions(
          { ...CONFIG, composerValidationCommand: command },
          context,
        ),
      ).resolves.toBeUndefined();
      expect(command).toHaveBeenCalledWith(cwd, context.logger);
      expect(lines).toContain('Packagist conditions verified.');
    });
  });

  it('runs composer validate by default', async () => {
    await withTmp({ 'composer.json': COMPOSER }, async (cwd) => {
      const { context, lines } = verifyContext({ cwd });
      await withComposer('echo "$@" > args.txt', () =>
        verifyConditions(CONFIG, context),
      );
      expect(lines).toContain('composer.json is valid (default validation).');
      expect(await readFile(join(cwd, 'args.txt'), 'utf8')).toBe(
        'validate --strict --no-check-version\n',
      );
    });
  });

  it('reports what composer said when the default validation fails', async () => {
    await withTmp({ 'composer.json': COMPOSER }, async (cwd) => {
      const { context } = verifyContext({ cwd });
      await expect(
        withComposer('echo "name is invalid" >&2; exit 2', () =>
          verifyConditions(CONFIG, context),
        ),
      ).rejects.toMatchObject({
        code: 'EINVALIDCOMPOSERJSON',
        message: '`composer.json` validation failed.',
        details: expect.stringContaining('Output: name is invalid'),
      });
    });
  });

  it('reports a missing composer apart from an invalid composer.json', async () => {
    await withTmp({ 'composer.json': COMPOSER }, async (cwd) => {
      const { context } = verifyContext({ cwd });
      await expect(
        withComposer(undefined, () => verifyConditions(CONFIG, context)),
      ).rejects.toMatchObject({
        code: 'ECOMPOSERNOTFOUND',
        message: '`composer` could not be run.',
        details: expect.stringContaining('not found'),
      });
    });
  });

  it('does not blame composer when a custom validation command fails with ENOENT', async () => {
    await withTmp({ 'composer.json': COMPOSER }, async (cwd) => {
      const command = jest
        .fn<CustomCommand>()
        .mockRejectedValue(
          Object.assign(new Error('no schema.json'), { code: 'ENOENT' }),
        );
      await expect(
        verifyConditions(
          { ...CONFIG, composerValidationCommand: command },
          verifyContext({ cwd }).context,
        ),
      ).rejects.toMatchObject({ code: 'EINVALIDCOMPOSERJSON' });
    });
  });

  it('does not blame composer when one of its scripts exits 127', async () => {
    await withTmp({ 'composer.json': COMPOSER }, async (cwd) => {
      await expect(
        withComposer('echo "hook.sh: command not found" >&2; exit 127', () =>
          verifyConditions(CONFIG, verifyContext({ cwd }).context),
        ),
      ).rejects.toMatchObject({ code: 'EINVALIDCOMPOSERJSON' });
    });
  });

  it('shortens a long output of composer in verifyConditions and in prepare', async () => {
    const noisy =
      'i=0; while [ $i -lt 3000 ]; do printf "%1000s" x >&2; i=$((i+1)); done; exit 2';
    await withTmp(
      { 'composer.json': COMPOSER, 'composer.lock': '{}' },
      async (cwd) => {
        const verify = await withComposer(noisy, () =>
          verifyConditions(CONFIG, verifyContext({ cwd }).context).catch(
            (e: unknown) => e,
          ),
        );
        const prepared = await withComposer(noisy, () =>
          prepare(CONFIG, prepareContext({ cwd }).context).catch(
            (e: unknown) => e,
          ),
        );
        for (const failure of [verify, prepared]) {
          expect(JSON.stringify(failure).length).toBeLessThan(2500);
          expect(JSON.stringify(failure)).toContain('(truncated)');
        }
      },
    );
  });

  it('keeps the Packagist credentials away from composer and out of what it prints', async () => {
    await withTmp({ 'composer.json': COMPOSER }, async (cwd) => {
      const failure = await withComposer(
        'echo "env=[$PACKAGIST_TOKEN$PACKAGIST_USERNAME] config=[config-token]" >&2; exit 2',
        () =>
          verifyConditions(
            { apiToken: 'config-token' },
            verifyContext({
              cwd,
              env: {
                ...process.env,
                PACKAGIST_TOKEN: 'env-token',
                PACKAGIST_USERNAME: 'env-user',
              },
            }).context,
          ).catch((e: unknown) => e),
      );
      expect(JSON.stringify(failure)).toContain('env=[]');
      expect(JSON.stringify(failure)).toContain('config=[[redacted]]');
    });
  });

  it('reads the credentials from the environment of the release', async () => {
    withoutPackagistEnv();
    await withTmp({ 'composer.json': COMPOSER }, async (cwd) => {
      const { context } = verifyContext({
        cwd,
        env: { PACKAGIST_TOKEN: 't', PACKAGIST_USERNAME: 'u' },
      });
      await expect(
        verifyConditions({ composerValidationCommand: passes }, context),
      ).resolves.toBeUndefined();
    });
  });

  it('puts the output of a failing custom validation in the details', async () => {
    await withTmp({ 'composer.json': COMPOSER }, async (cwd) => {
      const command = jest
        .fn<CustomCommand>()
        .mockRejectedValue(new Error('bad schema'));
      await expect(
        verifyConditions(
          { ...CONFIG, composerValidationCommand: command },
          verifyContext({ cwd }).context,
        ),
      ).rejects.toMatchObject({
        details: expect.stringContaining('Output: bad schema'),
      });
    });
  });

  it('wraps a failing custom validation command', async () => {
    await withTmp({ 'composer.json': COMPOSER }, async (cwd) => {
      const command = jest
        .fn<() => Promise<void>>()
        .mockRejectedValue(new Error('bad'));
      const { context } = verifyContext({ cwd });
      await expect(
        verifyConditions(
          { ...CONFIG, composerValidationCommand: command },
          context,
        ),
      ).rejects.toMatchObject({
        code: 'EINVALIDCOMPOSERJSON',
        message: '`composer.json` validation failed.',
      });
    });
  });

  it('refuses a missing composer.json', async () => {
    await withTmp({}, async (cwd) => {
      const { context } = verifyContext({ cwd });
      await expect(verifyConditions(CONFIG, context)).rejects.toMatchObject({
        code: 'EMISSINGCOMPOSERJSON',
        message: 'composer.json not found.',
      });
    });
  });

  it('refuses missing credentials', async () => {
    withoutPackagistEnv();
    await withTmp({ 'composer.json': COMPOSER }, async (cwd) => {
      const { context } = verifyContext({ cwd });
      const config = { composerValidationCommand: passes };
      await expect(verifyConditions(config, context)).rejects.toMatchObject({
        code: 'ENOPACKAGISTUSERNAME',
      });
      await expect(
        verifyConditions({ ...config, username: 'u' }, context),
      ).rejects.toMatchObject({ code: 'ENOPACKAGISTAPITOKEN' });
    });
  });

  it('refuses a missing repository URL', async () => {
    await withTmp({ 'composer.json': COMPOSER }, async (cwd) => {
      const { context } = verifyContext({ cwd, options: {} });
      await expect(
        verifyConditions(
          { ...CONFIG, composerValidationCommand: passes },
          context,
        ),
      ).rejects.toMatchObject({
        code: 'ENOREPOSITORYURL',
        message: 'Repository URL could not be determined.',
      });
    });
  });

  it('looks in the current directory when the context has none', async () => {
    const { context } = verifyContext();
    jest.spyOn(process, 'cwd').mockReturnValue('/nonexistent-packagist-dir');
    await expect(verifyConditions(CONFIG, context)).rejects.toMatchObject({
      code: 'EMISSINGCOMPOSERJSON',
      details: expect.stringContaining('/nonexistent-packagist-dir'),
    });
  });
});

describe('prepare', () => {
  it('writes the next version to composer.json', async () => {
    await withTmp({ 'composer.json': COMPOSER }, async (cwd) => {
      const { context, lines } = prepareContext({ cwd });
      await prepare(CONFIG, context);
      const written: unknown = JSON.parse(
        await readFile(join(cwd, 'composer.json'), 'utf8'),
      );
      expect(written).toStrictEqual({ name: 'test/pkg', version: '2.0.0' });
      expect(lines).toContain(
        'composer.lock not found, skipping lock file update.',
      );
    });
  });

  it('adds the version when composer.json has none, indented by four spaces', async () => {
    await withTmp({ 'composer.json': '{"name":"test/pkg"}' }, async (cwd) => {
      await prepare(CONFIG, prepareContext({ cwd }).context);
      expect(await readFile(join(cwd, 'composer.json'), 'utf8')).toBe(
        '{\n    "name": "test/pkg",\n    "version": "2.0.0"\n}',
      );
    });
  });

  it('refuses a composer.json that is not an object', async () => {
    await withTmp({ 'composer.json': '[]' }, async (cwd) => {
      await expect(
        prepare(CONFIG, prepareContext({ cwd }).context),
      ).rejects.toMatchObject({
        code: 'EINVALIDCOMPOSERJSON',
      });
    });
  });

  it('refuses a missing composer.json', async () => {
    await withTmp({}, async (cwd) => {
      await expect(
        prepare(CONFIG, prepareContext({ cwd }).context),
      ).rejects.toMatchObject({
        code: 'EMISSINGCOMPOSERJSON',
        message: 'composer.json not found during prepare step.',
      });
    });
  });

  it('updates composer.lock with a custom command', async () => {
    await withTmp(
      { 'composer.json': COMPOSER, 'composer.lock': '{}' },
      async (cwd) => {
        const command = jest.fn<CustomCommand>().mockResolvedValue();
        const { context } = prepareContext({ cwd });
        await prepare(
          { ...CONFIG, composerLockUpdateCommand: command },
          context,
        );
        expect(command).toHaveBeenCalledWith(cwd, context.logger);
      },
    );
  });

  it('updates composer.lock with composer by default', async () => {
    await withTmp(
      { 'composer.json': COMPOSER, 'composer.lock': '{}' },
      async (cwd) => {
        const { context, lines } = prepareContext({ cwd });
        await withComposer('echo "$@" > args.txt', () =>
          prepare(CONFIG, context),
        );
        expect(lines).toContain('composer.lock updated (default command).');
        expect(await readFile(join(cwd, 'args.txt'), 'utf8')).toBe(
          'update --lock\n',
        );
      },
    );
  });

  it('reports a failing default lock update with composer output', async () => {
    await withTmp(
      { 'composer.json': COMPOSER, 'composer.lock': '{}' },
      async (cwd) => {
        await expect(
          withComposer('echo "conflict" >&2; exit 2', () =>
            prepare(CONFIG, prepareContext({ cwd }).context),
          ),
        ).rejects.toMatchObject({
          code: 'ELOCKUPDATEFAILED',
          details: expect.stringContaining('conflict'),
        });
      },
    );
  });

  it('reports a missing composer when updating the lock file', async () => {
    await withTmp(
      { 'composer.json': COMPOSER, 'composer.lock': '{}' },
      async (cwd) => {
        await expect(
          withComposer(undefined, () =>
            prepare(CONFIG, prepareContext({ cwd }).context),
          ),
        ).rejects.toMatchObject({ code: 'ECOMPOSERNOTFOUND' });
      },
    );
  });

  it('turns an unparsable composer.json into a coded error', async () => {
    await withTmp({ 'composer.json': '{ nope' }, async (cwd) => {
      await expect(
        prepare(CONFIG, prepareContext({ cwd }).context),
      ).rejects.toMatchObject({
        code: 'EINVALIDCOMPOSERJSON',
        details: expect.stringContaining('could not be parsed'),
      });
    });
  });

  it('reports a failing lock update with the error message', async () => {
    await withTmp(
      { 'composer.json': COMPOSER, 'composer.lock': '{}' },
      async (cwd) => {
        const command = jest
          .fn<() => Promise<void>>()
          .mockRejectedValue(new Error('conflict'));
        await expect(
          prepare(
            { ...CONFIG, composerLockUpdateCommand: command },
            prepareContext({ cwd }).context,
          ),
        ).rejects.toMatchObject({
          code: 'ELOCKUPDATEFAILED',
          message: '`composer.lock` update failed.',
          details: 'conflict',
        });
      },
    );
  });

  it('reports a lock update that throws a non-error with the fix hint', async () => {
    await withTmp(
      { 'composer.json': COMPOSER, 'composer.lock': '{}' },
      async (cwd) => {
        const command = jest
          .fn<() => Promise<void>>()
          .mockRejectedValue('nope');
        await expect(
          prepare(
            { ...CONFIG, composerLockUpdateCommand: command },
            prepareContext({ cwd }).context,
          ),
        ).rejects.toMatchObject({
          code: 'ELOCKUPDATEFAILED',
          details: expect.stringContaining('composer update --lock'),
        });
      },
    );
  });

  it('looks in the current directory when the context has none', async () => {
    jest.spyOn(process, 'cwd').mockReturnValue('/nonexistent-packagist-dir');
    await expect(
      prepare(CONFIG, prepareContext().context),
    ).rejects.toMatchObject({
      code: 'EMISSINGCOMPOSERJSON',
      details: expect.stringContaining('/nonexistent-packagist-dir'),
    });
  });
});

describe('publish', () => {
  it('notifies Packagist about the repository', async () => {
    const update = jest
      .spyOn(PackagistClient.prototype, 'updatePackage')
      .mockResolvedValue();
    const { context, lines } = publishContext();
    await publish(CONFIG, context);
    expect(update).toHaveBeenCalledWith(REPOSITORY_URL);
    expect(lines).toEqual([
      `Notifying Packagist to update the package at ${REPOSITORY_URL}`,
      'Successfully notified Packagist.',
    ]);
  });

  it('does not log credentials embedded in the repository URL', async () => {
    jest.spyOn(PackagistClient.prototype, 'updatePackage').mockResolvedValue();
    const { context, lines } = publishContext({
      options: { repositoryUrl: 'https://user:s3cret@github.com/o/r.git' },
    });
    await publish(CONFIG, context);
    expect(lines.join('\n')).not.toContain('s3cret');
    expect(lines[0]).toContain('https://github.com/o/r.git');
  });

  it('keeps the coded errors of the client', async () => {
    const { default: SemanticReleaseError } = await import(
      '@semantic-release/error'
    );
    const failure = new SemanticReleaseError(
      'Invalid Packagist credentials.',
      'EINVALIDPACKAGISTTOKEN',
    );
    jest
      .spyOn(PackagistClient.prototype, 'updatePackage')
      .mockRejectedValue(failure);
    await expect(publish(CONFIG, publishContext().context)).rejects.toBe(
      failure,
    );
  });

  it('logs and wraps an unexpected failure', async () => {
    jest
      .spyOn(PackagistClient.prototype, 'updatePackage')
      .mockRejectedValue(new TypeError('fetch failed'));
    const { context, lines } = publishContext();
    await expect(publish(CONFIG, context)).rejects.toMatchObject({
      code: 'EUNEXPECTED',
      message: 'An unexpected error occurred.',
      details: 'fetch failed',
    });
    expect(lines).toContain(
      'An unexpected error occurred while publishing to Packagist: %s fetch failed',
    );
  });

  it('refuses missing credentials', async () => {
    withoutPackagistEnv();
    await expect(publish({}, publishContext().context)).rejects.toMatchObject({
      code: 'ENOPACKAGISTUSERNAME',
    });
  });

  it('refuses a missing repository URL', async () => {
    await expect(
      publish(CONFIG, publishContext({ options: {} }).context),
    ).rejects.toMatchObject({ code: 'ENOREPOSITORYURL' });
  });
});
