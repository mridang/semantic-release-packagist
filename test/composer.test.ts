import { describe, expect, it, jest } from '@jest/globals';
import { ComposerClient, type CustomCommand } from '../src/composer.js';
import { ExecError, type Runner } from '../src/utils/exec.js';
import { recordingLogger } from './utils/logger.js';

const CWD = '/work/project';

/**
 * A client whose runner is a fake.
 */
function make(
  run: Runner,
  options: Partial<ConstructorParameters<typeof ComposerClient>[0]> = {},
): { client: ComposerClient; lines: string[] } {
  const { logger, lines } = recordingLogger();
  return {
    lines,
    client: new ComposerClient({
      cwd: CWD,
      logger,
      env: {},
      secrets: [],
      run,
      ...options,
    }),
  };
}

/**
 * An error like the one the runner raises for a command that failed.
 */
function failed(stderr: string, code?: string): ExecError {
  return new ExecError('Command failed: composer', {
    code,
    status: code === undefined ? 2 : undefined,
    signal: undefined,
    stdout: '',
    stderr,
  });
}

describe('ComposerClient.validate', () => {
  it('runs composer validate in the project without a shell', async () => {
    const run = jest.fn<Runner>().mockResolvedValue('');
    const { client, lines } = make(run);
    await client.validate();
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
    const { client } = make(run, {
      env: {
        PATH: '/bin',
        UNSET: undefined,
        PACKAGIST_TOKEN: 'secret-token',
        PACKAGIST_OTHER: 'x',
      },
    });
    await client.validate();
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
    const { client, lines } = make(run, { validateCommand: custom });
    await client.validate();
    expect(custom).toHaveBeenCalledWith(CWD, expect.anything());
    expect(run).not.toHaveBeenCalled();
    expect(lines).toStrictEqual([]);
  });

  it('reports what composer said, scrubbed and shortened', async () => {
    const run = jest
      .fn<Runner>()
      .mockRejectedValue(failed(`bad ${'x'.repeat(5000)} tok3n`));
    const { client } = make(run, { secrets: ['tok3n'] });
    const failure = await client.validate().catch((e: unknown) => e);
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
    const { client } = make(run, { secrets: ['tok3n'] });
    await expect(client.validate()).rejects.toMatchObject({
      details: expect.stringContaining('token is [redacted]'),
    });
  });

  it('reports a missing composer apart from an invalid composer.json', async () => {
    const run = jest.fn<Runner>().mockRejectedValue(failed('', 'ENOENT'));
    const { client } = make(run);
    await expect(client.validate()).rejects.toMatchObject({
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
    const { client } = make(jest.fn<Runner>(), { validateCommand: custom });
    await expect(client.validate()).rejects.toMatchObject({
      code: 'EINVALIDCOMPOSERJSON',
      details: expect.stringContaining('Output: no schema'),
    });
  });

  it('does not blame composer when it exits 127 for one of its scripts', async () => {
    const run = jest.fn<Runner>().mockRejectedValue(
      new ExecError('x', {
        code: undefined,
        status: 127,
        signal: undefined,
        stdout: '',
        stderr: 'hook.sh: command not found',
      }),
    );
    const { client } = make(run);
    await expect(client.validate()).rejects.toMatchObject({
      code: 'EINVALIDCOMPOSERJSON',
    });
  });
});

describe('ComposerClient.updateLock', () => {
  it('runs composer update --lock in the project without a shell', async () => {
    const run = jest.fn<Runner>().mockResolvedValue('');
    const { client, lines } = make(run);
    await client.updateLock();
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
    const { client } = make(run, { updateLockCommand: custom });
    await client.updateLock();
    expect(custom).toHaveBeenCalledWith(CWD, expect.anything());
    expect(run).not.toHaveBeenCalled();
  });

  it('reports what composer said', async () => {
    const run = jest.fn<Runner>().mockRejectedValue(failed('conflict'));
    const { client } = make(run);
    await expect(client.updateLock()).rejects.toMatchObject({
      code: 'ELOCKUPDATEFAILED',
      message: '`composer.lock` update failed.',
      details: 'conflict',
    });
  });

  it('gives a hint when a custom command throws something that is not an error', async () => {
    const custom = jest.fn<CustomCommand>().mockRejectedValue('nope');
    const { client } = make(jest.fn<Runner>(), { updateLockCommand: custom });
    await expect(client.updateLock()).rejects.toMatchObject({
      code: 'ELOCKUPDATEFAILED',
      details: expect.stringContaining('composer update --lock'),
    });
  });

  it('reports a missing composer', async () => {
    const run = jest.fn<Runner>().mockRejectedValue(failed('', 'ENOENT'));
    const { client } = make(run);
    await expect(client.updateLock()).rejects.toMatchObject({
      code: 'ECOMPOSERNOTFOUND',
    });
  });

  it('does not blame composer when a custom command fails with ENOENT', async () => {
    const custom = jest
      .fn<CustomCommand>()
      .mockRejectedValue(Object.assign(new Error('x'), { code: 'ENOENT' }));
    const { client } = make(jest.fn<Runner>(), { updateLockCommand: custom });
    await expect(client.updateLock()).rejects.toMatchObject({
      code: 'ELOCKUPDATEFAILED',
    });
  });
});
