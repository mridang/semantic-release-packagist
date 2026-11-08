import { describe, expect, it } from '@jest/globals';
// noinspection ES6PreferShortImport
import { truncate } from '../../src/utils/text.js';

describe('truncate', () => {
  it('leaves short text alone', () => {
    expect(truncate('abc', 3)).toBe('abc');
  });

  it('cuts long text and says so', () => {
    expect(truncate('abcdef', 3)).toBe('abc... (truncated)');
  });
});
