/**
 * Readers for the message, code, exit status and signal of anything that was
 * thrown.
 * @file
 */
import { isRecord, stringAt } from './object.js';

/**
 * The message of anything that was thrown. Errors with an empty message, such
 * as the `AggregateError` Node raises when every address of a host refuses
 * the connection, are described by their `code`, then by their first inner
 * error, then by their name.
 *
 * Errors are recognised by shape rather than by `instanceof`, because errors
 * raised by Node itself can come from another realm (a test sandbox, for one).
 * @param error - A caught value, which is not necessarily an `Error`.
 * @returns Its message, or its string form when it is not an `Error`.
 * @example
 * messageOf(new Error('boom')); // 'boom'
 */
export function messageOf(error: unknown): string {
  if (!isRecord(error) || typeof error.message !== 'string') {
    return String(error);
  }
  if (error.message) {
    return error.message;
  }
  if (typeof error.code === 'string' && error.code) {
    return error.code;
  }
  const [first] = Array.isArray(error.errors) ? error.errors : [];
  return first === undefined ? String(error.name ?? 'Error') : messageOf(first);
}

/**
 * The `code` of anything that was thrown, such as a `SemanticReleaseError`
 * or a Node system error (`ENOENT`).
 * @param error - A caught value.
 * @returns Its string `code`, or undefined when it has none.
 * @example
 * codeOf(Object.assign(new Error('missing'), { code: 'ENOENT' })); // 'ENOENT'
 */
export function codeOf(error: unknown): string | undefined {
  return isRecord(error) ? stringAt(error, 'code') : undefined;
}

/**
 * The exit `status` of anything that was thrown by a child process.
 * @param error - A caught value.
 * @returns Its numeric `status`, or undefined when it has none.
 * @example
 * statusOf(Object.assign(new Error('failed'), { status: 2 })); // 2
 */
export function statusOf(error: unknown): number | undefined {
  return isRecord(error) && typeof error.status === 'number'
    ? error.status
    : undefined;
}

/**
 * The terminating `signal` of anything that was thrown by a child process.
 * @param error - A caught value.
 * @returns Its string `signal`, or undefined when it has none.
 * @example
 * signalOf(Object.assign(new Error('killed'), { signal: 'SIGTERM' })); // 'SIGTERM'
 */
export function signalOf(error: unknown): string | undefined {
  return isRecord(error) ? stringAt(error, 'signal') : undefined;
}
