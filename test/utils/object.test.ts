import { describe, expect, it } from '@jest/globals';
// noinspection ES6PreferShortImport
import { isRecord, stringAt } from '../../src/utils/object.js';

describe('isRecord', () => {
  it('accepts plain objects', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });

  it.each([null, undefined, [], [1], 'x', 1, true])('rejects %s', (value) => {
    expect(isRecord(value)).toBe(false);
  });
});

describe('stringAt', () => {
  it('reads an own string property', () => {
    expect(stringAt({ s: 'x' }, 's')).toBe('x');
  });

  it('gives undefined for a missing, inherited or non-string property', () => {
    expect(stringAt({ n: 1 }, 'n')).toBeUndefined();
    expect(stringAt({}, 'missing')).toBeUndefined();
    expect(stringAt({}, 'toString')).toBeUndefined();
  });
});
