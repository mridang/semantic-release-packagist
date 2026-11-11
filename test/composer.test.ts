/**
 * Unit tests for `validate` and `updateLock`: the default commands, the
 * custom commands, the environment handed to composer and the errors raised.
 * @file
 */
import { describe, expect, it, jest } from '@jest/globals';
import {
  updateLock,
  validate,
  type ComposerOptions,
  type CustomCommand,
} from '../src/composer.js';
import { ExecError, type Runner } from '../src/utils/exec.js';
import { recordingLogger } from './utils/logger.js';

const CWD = '/work/project';

/**
 * Options for the module, with a fake runner.
 * @param run - The fake runner that stands in for the program.
 * @param options - Options to add or override.
 * @returns The options for the module and the lines logged through them.
 * @example
 * const { options, lines } = make(jest.fn<Runner>().mockResolvedValue(''));
 */
function make(
  run: Runner,
  options: Partial<ComposerOptions> = {},
): { options: ComposerOptions; lines: string[] } {
  const { logger, lines } = recordingLogger();
  return {
    lines,
    options: { cwd: CWD, logger, env: {}, secrets: [], run, ...options },
  };
}

/**
 * An error like the one the runner raises for a command that failed.
 * @param stderr - What the failed command wrote to stderr.
 * @param code - The system error code, when there is one; otherwise exit status 2.
 * @returns The error the runner would raise.
 * @example
 * const error = failed('composer: not found', 'ENOENT');
 */
function failed(stderr: string, code?: string): ExecError {
  const cause = code === undefined ? { status: 2 } : { code };
  return new ExecError('Command failed: composer', {
    ...cause,
    stdout: '',
    stderr,
  });
}

describe('validate', () => {
  it('runs composer validate in the project without a shell', async () => {
    const run = jest.fn<Runner>().mockResolvedValue('');
    const { options, lines } = make(run);
    await validate(options);
    expect(run).toHaveBeenCalledWith(
      'composer',
      ['validate', '--strict', '--no-check-version'],
      expect.objectContaining({ cwd: CWD }),
    );
    expect(lines).toStrictEqual([
      'Executing default validation: composer validate --strict --no-check-version',
      'composer.json is valid (default validation).',
    ]);
  });

  it('gives composer the release environment with the Packagist variables emptied', async () => {
    const run = jest.fn<Runner>().mockResolvedValue('');
    const { options } = make(run, {
      env: {
        PATH: '/bin',
        UNSET: process.env['PACKAGIST_UNSET_FOR_TEST'],
        PACKAGIST_TOKEN: 'secret-token',
        PACKAGIST_OTHER: 'x',
      },
    });
    await validate(options);
    expect(run.mock.calls[0]?.[2]?.env).toMatchObject({
      PATH: '/bin',
      PACKAGIST_USERNAME: '',
      PACKAGIST_TOKEN: '',
      PACKAGIST_OTHER: '',
    });
    expect(run.mock.calls[0]?.[2]?.env).not.toHaveProperty('UNSET');
  });

  it('runs a custom command instead, as it is', async () => {
    const run = jest.fn<Runner>();
    const custom = jest.fn<CustomCommand>().mockResolvedValue();
    const { options, lines } = make(run, { validateCommand: custom });
    await validate(options);
    expect(custom).toHaveBeenCalledWith(CWD, expect.anything());
    expect(run).not.toHaveBeenCalled();
    expect(lines).toStrictEqual([]);
  });

  it('reports what composer said, scrubbed and shortened', async () => {
    const run = jest
      .fn<Runner>()
      .mockRejectedValue(failed(`bad ${'x'.repeat(5000)} tok3n`));
    const { options } = make(run, { secrets: ['tok3n'] });
    const failure = await validate(options).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: 'EINVALIDCOMPOSERJSON',
      message: '`composer.json` validation failed.',
      details: expect.stringContaining('Output: bad xxx'),
    });
    expect(JSON.stringify(failure)).toContain('(truncated)');
    expect(JSON.stringify(failure).length).toBeLessThan(2600);
  });

  it('scrubs secrets in what composer said', async () => {
    const run = jest.fn<Runner>().mockRejectedValue(failed('token is tok3n'));
    const { options } = make(run, { secrets: ['tok3n'] });
    await expect(validate(options)).rejects.toMatchObject({
      details: expect.stringContaining('token is [redacted]'),
    });
  });

  it('reports a missing composer apart from an invalid composer.json', async () => {
    const run = jest.fn<Runner>().mockRejectedValue(failed('', 'ENOENT'));
    const { options } = make(run);
    await expect(validate(options)).rejects.toMatchObject({
      code: 'ECOMPOSERNOTFOUND',
      message: '`composer` could not be run.',
    });
  });

  it('does not blame composer when a custom command fails with ENOENT', async () => {
    const custom = jest
      .fn<CustomCommand>()
      .mockRejectedValue(
        Object.assign(new Error('no schema'), { code: 'ENOENT' }),
      );
    const { options } = make(jest.fn<Runner>(), { validateCommand: custom });
    await expect(validate(options)).rejects.toMatchObject({
      code: 'EINVALIDCOMPOSERJSON',
      details: expect.stringContaining('Output: no schema'),
    });
  });

  it('does not blame composer when it exits 127 for one of its scripts', async () => {
    const run = jest.fn<Runner>().mockRejectedValue(
      new ExecError('x', {
        status: 127,
        stdout: '',
        stderr: 'hook.sh: command not found',
      }),
    );
    const { options } = make(run);
    await expect(validate(options)).rejects.toMatchObject({
      code: 'EINVALIDCOMPOSERJSON',
    });
  });
});

describe('updateLock', () => {
  it('runs composer update --lock in the project without a shell', async () => {
    const run = jest.fn<Runner>().mockResolvedValue('');
    const { options, lines } = make(run);
    await updateLock(options);
    expect(run).toHaveBeenCalledWith(
      'composer',
      ['update', '--lock'],
      expect.objectContaining({ cwd: CWD }),
    );
    expect(lines).toStrictEqual([
      'Executing default lock update: composer update --lock',
      'composer.lock updated (default command).',
    ]);
  });

  it('runs a custom command instead, as it is', async () => {
    const run = jest.fn<Runner>();
    const custom = jest.fn<CustomCommand>().mockResolvedValue();
    const { options } = make(run, { updateLockCommand: custom });
    await updateLock(options);
    expect(custom).toHaveBeenCalledWith(CWD, expect.anything());
    expect(run).not.toHaveBeenCalled();
  });

  it('reports what composer said', async () => {
    const run = jest.fn<Runner>().mockRejectedValue(failed('conflict'));
    const { options } = make(run);
    await expect(updateLock(options)).rejects.toMatchObject({
      code: 'ELOCKUPDATEFAILED',
      message: '`composer.lock` update failed.',
      details: 'conflict',
    });
  });

  it('gives a hint when a custom command throws something that is not an error', async () => {
    const custom = jest.fn<CustomCommand>().mockRejectedValue('nope');
    const { options } = make(jest.fn<Runner>(), { updateLockCommand: custom });
    await expect(updateLock(options)).rejects.toMatchObject({
      code: 'ELOCKUPDATEFAILED',
      details: expect.stringContaining('composer update --lock'),
    });
  });

  it('reports a missing composer', async () => {
    const run = jest.fn<Runner>().mockRejectedValue(failed('', 'ENOENT'));
    const { options } = make(run);
    await expect(updateLock(options)).rejects.toMatchObject({
      code: 'ECOMPOSERNOTFOUND',
    });
  });

  it('does not blame composer when a custom command fails with ENOENT', async () => {
    const custom = jest
      .fn<CustomCommand>()
      .mockRejectedValue(Object.assign(new Error('x'), { code: 'ENOENT' }));
    const { options } = make(jest.fn<Runner>(), { updateLockCommand: custom });
    await expect(updateLock(options)).rejects.toMatchObject({
      code: 'ELOCKUPDATEFAILED',
    });
  });
});
