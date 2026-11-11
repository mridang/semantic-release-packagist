/**
 * Unit tests for the readers of thrown values.
 * @file
 */
import { describe, expect, it } from '@jest/globals';
// noinspection ES6PreferShortImport
import {
  codeOf,
  messageOf,
  signalOf,
  statusOf,
} from '../../src/utils/error.js';

/**
 * Clear the message of an error, for the cases that need it empty.
 * @param error - The error to change.
 * @returns The same error, with an empty message.
 * @example
 * const error = withoutMessage(new TypeError('x')); // error.message === ''
 */
function withoutMessage<T extends Error>(error: T): T {
  return Object.assign(error, { message: '' });
}

describe('messageOf', () => {
  it('reads the message of an Error', () => {
    expect(messageOf(new Error('boom'))).toBe('boom');
  });

  it('uses the string form of anything else', () => {
    expect(messageOf('plain')).toBe('plain');
    expect(messageOf(42)).toBe('42');
    expect(messageOf(undefined)).toBe('undefined');
  });

  it('describes an error without a message by its code', () => {
    expect(
      messageOf(
        Object.assign(withoutMessage(new Error('x')), { code: 'ECONNREFUSED' }),
      ),
    ).toBe('ECONNREFUSED');
  });

  it('describes an empty aggregate error by its first inner error', () => {
    const inner = Object.assign(new Error('connect ECONNREFUSED ::1:443'), {
      code: 'ECONNREFUSED',
    });
    expect(
      messageOf(
        withoutMessage(new AggregateError([inner, new Error('other')], 'x')),
      ),
    ).toBe('connect ECONNREFUSED ::1:443');
  });

  it('prefers the code of an aggregate error over its inner errors', () => {
    const error = Object.assign(
      withoutMessage(new AggregateError([new Error('inner')], 'x')),
      {
        code: 'ECONNREFUSED',
      },
    );
    expect(messageOf(error)).toBe('ECONNREFUSED');
  });

  it('falls back to the name of an error with nothing else to say', () => {
    expect(messageOf(withoutMessage(new AggregateError([], 'x')))).toBe(
      'AggregateError',
    );
    expect(messageOf(withoutMessage(new TypeError('x')))).toBe('TypeError');
  });

  it('recognises an error from another realm by its shape', () => {
    expect(messageOf({ message: 'boom' })).toBe('boom');
    expect(messageOf({ message: '', name: 'AggregateError' })).toBe(
      'AggregateError',
    );
    expect(messageOf({ message: '' })).toBe('Error');
  });
});

describe('codeOf', () => {
  it('reads the code of a coded error', () => {
    expect(codeOf(Object.assign(new Error('x'), { code: 'EBOOM' }))).toBe(
      'EBOOM',
    );
  });

  it('is undefined for an error without a code, a non-string code or a non-object', () => {
    expect(codeOf(new Error('x'))).toBeUndefined();
    expect(codeOf(Object.assign(new Error('x'), { code: 5 }))).toBeUndefined();
    expect(codeOf('E1')).toBeUndefined();
    expect(codeOf(undefined)).toBeUndefined();
  });
});

describe('statusOf and signalOf', () => {
  it('read the exit status and the signal of a child-process error', () => {
    const error = Object.assign(new Error('x'), {
      status: 3,
      signal: 'SIGTERM',
    });
    expect(statusOf(error)).toBe(3);
    expect(signalOf(error)).toBe('SIGTERM');
  });

  it('are undefined when absent or of the wrong type', () => {
    expect(
      statusOf(Object.assign(new Error('x'), { status: '3' })),
    ).toBeUndefined();
    expect(
      signalOf(Object.assign(new Error('x'), { signal: 9 })),
    ).toBeUndefined();
    expect(statusOf('x')).toBeUndefined();
    expect(signalOf(undefined)).toBeUndefined();
  });
});
