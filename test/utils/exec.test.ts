/**
 * Unit tests for the command runner: arguments, environment, input, timeouts,
 * and the shape of the errors it raises.
 * @file
 */
import { promisify } from 'node:util';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

type Child = { stdin: typeof stdin };

const stdin = { on: jest.fn(), end: jest.fn() };
const execFileMock =
  jest.fn<
    (
      file: string,
      args: readonly string[],
      options: Record<string, unknown>,
    ) => Promise<{ stdout: unknown; stderr: unknown }> & { child: Child }
  >();
const actual =
  jest.requireActual<typeof import('node:child_process')>('node:child_process');

// run() promisifies execFile, so the mock stands in for the promisified form.
jest.unstable_mockModule('node:child_process', () => ({
  execFile: Object.assign(jest.fn(), { [promisify.custom]: execFileMock }),
}));

const { ExecError, run } = await import('../../src/utils/exec.js');

/**
 * Make the next command finish the way the promisified `execFile` does: it
 * resolves with `{ stdout, stderr }`, or rejects with the error carrying
 * `stdout` and `stderr` properties.
 * @param error - The error the command finishes with, or null on success.
 * @param stdout - The standard output the command reports.
 * @param stderr - The standard error the command reports.
 * @example
 * finishWith(null, 'out', ''); // the next run() resolves with 'out'
 */
function finishWith(error: unknown, stdout: unknown, stderr: unknown): void {
  execFileMock.mockImplementation(() =>
    Object.assign(outcome(error, stdout, stderr), { child: { stdin } }),
  );
}

/**
 * The promise a promisified `execFile` returns for a command.
 * @param failure - The error the command finishes with, or null on success.
 * @param stdout - The standard output the command reports.
 * @param stderr - The standard error the command reports.
 * @returns A promise that resolves with the output or rejects with the error.
 * @example
 * await outcome(null, 'out', ''); // { stdout: 'out', stderr: '' }
 */
function outcome(
  failure: unknown,
  stdout: unknown,
  stderr: unknown,
): Promise<{ stdout: unknown; stderr: unknown }> {
  return failure === null
    ? Promise.resolve({ stdout, stderr })
    : Promise.reject(Object.assign(failure as object, { stdout, stderr }));
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

  it('describes a missing stdout and stderr as empty', async () => {
    execFileMock.mockImplementation(() =>
      Object.assign(Promise.reject(new Error('failed')), {
        child: { stdin },
      }),
    );

    expect(await rejection(run('docker', ['pull']))).toEqual(
      expect.objectContaining({ stdout: '', stderr: '' }),
    );
  });

  describe('with the real execFile', () => {
    beforeEach(() => {
      execFileMock.mockImplementation((file, args, options) =>
        promisify(actual.execFile)(file, [...args], {
          ...options,
          encoding: 'utf8',
        }),
      );
    });

    const script = (code: string): string[] => ['-e', code];

    it('resolves with the standard output', async () => {
      expect(
        await run(process.execPath, script("process.stdout.write('hi')")),
      ).toBe('hi');
    });

    it('feeds the input to the command', async () => {
      expect(
        await run(
          process.execPath,
          script('process.stdin.pipe(process.stdout)'),
          { input: 'piped' },
        ),
      ).toBe('piped');
    });

    it('rejects with the exit status and the redacted output', async () => {
      const error = await rejection(
        run(
          process.execPath,
          script(
            "process.stdout.write('out');process.stderr.write('see https://u:pw0rd@h/x');process.exit(3)",
          ),
        ),
      );

      expect(error).toBeInstanceOf(ExecError);
      expect(error).toEqual(
        expect.objectContaining({
          status: 3,
          stdout: 'out',
          stderr: 'see https://***@h/x',
        }),
      );
      expect((error as InstanceType<typeof ExecError>).signal).toBeUndefined();
    });

    it('rejects with the system code when the program does not exist', async () => {
      const error = await rejection(run('no-such-program-here', []));

      expect(error).toEqual(
        expect.objectContaining({ code: 'ENOENT', stdout: '', stderr: '' }),
      );
      expect((error as InstanceType<typeof ExecError>).status).toBeUndefined();
    });

    it('reports a command killed after the timeout as ETIMEDOUT', async () => {
      expect(
        await rejection(
          run(process.execPath, script('setTimeout(() => {}, 60000)'), {
            timeout: 100,
          }),
        ),
      ).toEqual(
        expect.objectContaining({ code: 'ETIMEDOUT', signal: 'SIGTERM' }),
      );
    });
  });
});
