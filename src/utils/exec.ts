/**
 * Runs child processes without a shell and turns their failures into an
 * `ExecError` with credentials removed.
 * @file
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { codeOf, messageOf, signalOf, statusOf } from './error.js';
import { isRecord } from './object.js';
import { redactCredentials } from './redact.js';

/**
 * Largest output captured from a command: 64 MiB, so a long listing is not
 * mistaken for a failure.
 */
const MAX_BUFFER = 64 * 1024 * 1024;

const execFileAsync = promisify(execFile);

/**
 * Options for running a command.
 */
export interface ExecOptions {
  /** Working directory of the command. */
  readonly cwd?: string;
  /** Variables added to the current environment for the command. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Text written to the command's standard input, which is then closed. */
  readonly input?: string;
  /** Milliseconds after which the command is killed (code `ETIMEDOUT`). */
  readonly timeout?: number;
  /** Largest stdout or stderr captured, in bytes. */
  readonly maxBuffer?: number;
}

/**
 * Runs a program without a shell and resolves with its standard output.
 */
export type Runner = (
  file: string,
  args: readonly string[],
  options?: ExecOptions,
) => Promise<string>;

/**
 * The error raised when a command cannot be started or exits unsuccessfully.
 * It carries the same shape in every plugin: `code` (a system error such as
 * `ENOENT`), `status` (the exit code), `signal`, and the captured output.
 * Credentials are removed from the message and the output.
 */
export class ExecError extends Error {
  /** The system error code, such as `ENOENT` or `ETIMEDOUT`. */
  readonly code: string | undefined;

  /** The exit code of a command that ran and failed. */
  readonly status: number | undefined;

  /** The signal that killed the command. */
  readonly signal: string | undefined;

  /** What the command wrote to stdout, with credentials removed. */
  readonly stdout: string;

  /** What the command wrote to stderr, with credentials removed. */
  readonly stderr: string;

  /**
   * Creates the error for a command that could not be run or failed.
   * @param message - Description of the failure, already free of credentials.
   * @param details - The code, exit status, signal and captured output.
   * @param details.code - The system error code, or undefined when there is none.
   * @param details.status - The exit code, or undefined when the command did not exit.
   * @param details.signal - The signal that killed the command, or undefined.
   * @param details.stdout - What the command wrote to stdout.
   * @param details.stderr - What the command wrote to stderr.
   * @example
   * new ExecError('git failed', {
   *   code: undefined,
   *   status: 128,
   *   signal: undefined,
   *   stdout: '',
   *   stderr: 'fatal: not a git repository',
   * });
   */
  constructor(
    message: string,
    details: {
      readonly code?: string;
      readonly status?: number;
      readonly signal?: string;
      readonly stdout: string;
      readonly stderr: string;
    },
  ) {
    super(message);
    this.name = 'ExecError';
    this.code = details.code;
    this.status = details.status;
    this.signal = details.signal;
    this.stdout = details.stdout;
    this.stderr = details.stderr;
  }
}

/**
 * Run a program without a shell. Arguments are passed as an array, so nothing
 * in them is interpreted; the environment is the current one plus
 * `options.env`. The standard input is always closed, after `options.input`
 * has been written, so a command never waits for input.
 * @param file - Program to run.
 * @param args - Its arguments.
 * @param options - Working directory, extra environment, input, timeout and
 * output limit.
 * @returns The standard output as a string.
 * @throws ExecError when the program cannot be started, fails or times out;
 * its message and output have credentials redacted.
 * @rejects ExecError when the program cannot be started, fails or times out;
 * its message and output have credentials redacted.
 * @example
 * const version = await run('git', ['--version'], { cwd: process.cwd() });
 */
export const run: Runner = async (file, args, options = {}) => {
  const pending = execFileAsync(file, [...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    maxBuffer: options.maxBuffer ?? MAX_BUFFER,
    timeout: options.timeout,
    encoding: 'utf8',
  });
  // The command may exit before it has read its input (EPIPE).
  pending.child.stdin?.on('error', () => undefined);
  pending.child.stdin?.end(options.input);
  try {
    const { stdout } = await pending;
    return stdout;
  } catch (error: unknown) {
    const text = (value: unknown): string =>
      redactCredentials(typeof value === 'string' ? value : '');
    const timedOut =
      isRecord(error) && error.killed === true && options.timeout !== undefined;
    throw new ExecError(redactCredentials(messageOf(error)), {
      code: timedOut ? 'ETIMEDOUT' : codeOf(error),
      status:
        statusOf(error) ??
        (isRecord(error) && typeof error.code === 'number'
          ? error.code
          : undefined),
      signal: signalOf(error),
      stdout: text(isRecord(error) ? error.stdout : undefined),
      stderr: text(isRecord(error) ? error.stderr : undefined),
    });
  }
};
