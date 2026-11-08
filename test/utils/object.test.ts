import { describe, expect, it } from '@jest/globals';
// noinspection ES6PreferShortImport
import { isRecord, numberAt } from '../../src/utils/object.js';

describe('isRecord', () => {
  it('accepts plain objects', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });

  it.each([null, undefined, [], [1], 'x', 1, true])('rejects %s', (value) => {
    expect(isRecord(value)).toBe(false);
  });
});

describe('numberAt', () => {
  const record = { n: 0, s: 'x', other: null };

  it('reads a number property', () => {
    expect(numberAt(record, 'n')).toBe(0);
  });

  it('gives undefined for a missing property or the wrong type', () => {
    expect(numberAt(record, 's')).toBeUndefined();
    expect(numberAt(record, 'other')).toBeUndefined();
    expect(numberAt(record, 'missing')).toBeUndefined();
  });
});
