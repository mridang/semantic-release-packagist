import { describe, expect, it } from '@jest/globals';
// noinspection ES6PreferShortImport
import { messageOf } from '../../src/utils/error.js';

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
      messageOf(Object.assign(new Error(''), { code: 'ECONNREFUSED' })),
    ).toBe('ECONNREFUSED');
  });

  it('describes an empty aggregate error by its first inner error', () => {
    const inner = Object.assign(new Error('connect ECONNREFUSED ::1:443'), {
      code: 'ECONNREFUSED',
    });
    expect(messageOf(new AggregateError([inner, new Error('other')], ''))).toBe(
      'connect ECONNREFUSED ::1:443',
    );
  });

  it('prefers the code of an aggregate error over its inner errors', () => {
    const error = Object.assign(new AggregateError([new Error('inner')], ''), {
      code: 'ECONNREFUSED',
    });
    expect(messageOf(error)).toBe('ECONNREFUSED');
  });

  it('falls back to the name of an error with nothing else to say', () => {
    expect(messageOf(new AggregateError([], ''))).toBe('AggregateError');
    expect(messageOf(new TypeError(''))).toBe('TypeError');
  });

  it('recognises an error from another realm by its shape', () => {
    expect(messageOf({ message: 'boom' })).toBe('boom');
    expect(messageOf({ message: '', name: 'AggregateError' })).toBe(
      'AggregateError',
    );
    expect(messageOf({ message: '' })).toBe('Error');
  });
});
