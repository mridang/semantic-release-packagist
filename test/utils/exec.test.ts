/**
 * Unit tests for the command runner: arguments, environment, input, timeouts,
 * and the shape of the errors it raises.
 * @file
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { promisify } from 'node:util';

type Callback = (error: unknown, stdout: unknown, stderr: unknown) => void;

const stdin = { on: jest.fn(), end: jest.fn() };
const execFileMock =
  jest.fn<
    (
      file: string,
      args: readonly string[],
      options: Record<string, unknown>,
      callback: Callback,
    ) => { stdin: typeof stdin }
  >();

/**
 * Stands in for `execFile`'s promisified form, which the runner uses. It
 * settles from the same callback the mock is driven with.
 * @param file - Program to run.
 * @param args - Its arguments.
 * @param options - The options the runner passed.
 * @returns A promise of the output, carrying the fake child process.
 * @example
 * const pending = asPromisedExecFile('git', ['status'], {});
 */
function asPromisedExecFile(
  file: string,
  args: readonly string[],
  options: Record<string, unknown>,
): Promise<{ stdout: string; stderr: string }> & { child: unknown } {
  let child: unknown;
  const promise = new Promise<{ stdout: string; stderr: string }>(
    (resolve, reject) => {
      // eslint-disable-next-line promise/prefer-await-to-callbacks -- the fake must call back the way execFile does
      child = execFileMock(file, args, options, (error, stdout, stderr) => {
        if (error === null) {
          resolve({ stdout: stdout as string, stderr: stderr as string });
          return;
        }
        reject(Object.assign(error as object, { stdout, stderr }));
      });
    },
  );
  return Object.assign(promise, { child });
}

Object.assign(execFileMock, { [promisify.custom]: asPromisedExecFile });

jest.unstable_mockModule('node:child_process', () => ({
  execFile: execFileMock,
}));

const { ExecError, run } = await import('../../src/utils/exec.js');

/**
 * Make the next command finish by calling its callback.
 * @param error - The error the command reports, or null for success.
 * @param stdout - The standard output the command reports.
 * @param stderr - The standard error the command reports.
 * @example
 * finishWith(null, 'out', '');
 */
function finishWith(error: unknown, stdout: unknown, stderr: unknown): void {
  // eslint-disable-next-line promise/prefer-await-to-callbacks -- the fake must call back the way execFile does
  execFileMock.mockImplementation((_file, _args, _options, callback) => {
    // eslint-disable-next-line promise/prefer-await-to-callbacks -- the fake must call back the way execFile does
    callback(error, stdout, stderr);
    return { stdin };
  });
}

/**
 * The error a failed command rejects with.
 * @param promise - The pending run of a command.
 * @returns The error it rejected with, or undefined when it resolved.
 * @example
 * const error = await rejection(run('git', ['pull']));
 */
async function rejection(promise: Promise<string>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error: unknown) {
    return error;
  }
}

beforeEach(() => {
  execFileMock.mockReset();
  stdin.on.mockReset();
  stdin.end.mockReset();
  finishWith(null, 'out', '');
});

describe('run', () => {
  it('runs the program with the args as an argv array and returns stdout', async () => {
    expect(await run('docker', ['build', 'a b; c'])).toBe('out');
    expect(execFileMock.mock.calls[0][0]).toBe('docker');
    expect(execFileMock.mock.calls[0][1]).toEqual(['build', 'a b; c']);
    expect(execFileMock.mock.calls[0][2]).not.toHaveProperty('shell');
  });

  it('passes the directory, the environment added to this one, and the timeout', async () => {
    await run('docker', ['login'], {
      cwd: '/work',
      env: { A: 'b' },
      timeout: 1234,
    });

    expect(execFileMock.mock.calls[0][2]).toEqual(
      expect.objectContaining({
        cwd: '/work',
        env: expect.objectContaining({ A: 'b', PATH: process.env['PATH'] }),
        timeout: 1234,
        encoding: 'utf8',
      }),
    );
  });

  it('allows far more output than the default 1 MiB buffer', async () => {
    await run('docker', ['build']);

    expect(execFileMock.mock.calls[0][2]).toEqual(
      expect.objectContaining({ maxBuffer: 64 * 1024 * 1024 }),
    );
  });

  it('writes the input to stdin and closes it', async () => {
    await run('docker', ['login'], { input: 'secret' });

    expect(stdin.end).toHaveBeenCalledWith('secret');
  });

  it('closes stdin when there is no input, so the command never waits', async () => {
    await run('docker', ['build']);

    expect(stdin.end).toHaveBeenCalledWith(undefined);
  });

  it('ignores a broken pipe when the command exits before reading its input', async () => {
    await run('docker', ['login'], { input: 'secret' });

    const [event, handler] = stdin.on.mock.calls[0] as [string, () => void];
    expect(event).toBe('error');
    expect(handler()).toBeUndefined();
  });

  it('rejects with an ExecError that keeps code, status and signal', async () => {
    finishWith(
      Object.assign(new Error('Command failed: docker pull'), {
        code: 'EFAIL',
        signal: 'SIGTERM',
        status: 3,
      }),
      'partial',
      'denied for https://user:pw0rd@host/x',
    );

    const error = await rejection(run('docker', ['pull']));

    expect(error).toBeInstanceOf(ExecError);
    expect(error).toEqual(
      expect.objectContaining({
        name: 'ExecError',
        code: 'EFAIL',
        status: 3,
        signal: 'SIGTERM',
        stdout: 'partial',
        stderr: 'denied for https://***@host/x',
      }),
    );
  });

  it('takes a numeric code as the exit status', async () => {
    finishWith(Object.assign(new Error('failed'), { code: 2 }), '', '');

    const error = await rejection(run('docker', ['pull']));
    expect(error).toEqual(expect.objectContaining({ status: 2 }));
    expect(error).toHaveProperty('code', undefined);
  });

  it('reports a command killed after the timeout as ETIMEDOUT', async () => {
    finishWith(
      Object.assign(new Error('timed out'), {
        killed: true,
        signal: 'SIGTERM',
      }),
      '',
      '',
    );

    expect(await rejection(run('docker', ['build'], { timeout: 10 }))).toEqual(
      expect.objectContaining({ code: 'ETIMEDOUT', signal: 'SIGTERM' }),
    );
  });

  it('does not call a killed command timed out when it had no timeout', async () => {
    finishWith(
      Object.assign(new Error('killed'), { killed: true, signal: 'SIGKILL' }),
      '',
      '',
    );

    const error = await rejection(run('docker', ['build']));
    expect(error).toEqual(expect.objectContaining({ signal: 'SIGKILL' }));
    expect(error).toHaveProperty('code', undefined);
  });

  it('redacts credentials in the message of the error', async () => {
    finishWith(
      new Error('Command failed: git clone https://user:pw0rd@host/x'),
      '',
      '',
    );

    expect(await rejection(run('git', ['clone']))).toEqual(
      expect.objectContaining({
        message: 'Command failed: git clone https://***@host/x',
      }),
    );
  });

  it('describes output that is not text as empty', async () => {
    finishWith(new Error('failed'), Buffer.from('x'), undefined);

    expect(await rejection(run('docker', ['pull']))).toEqual(
      expect.objectContaining({ stdout: '', stderr: '' }),
    );
  });
});
