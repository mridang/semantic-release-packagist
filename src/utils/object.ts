/**
 * Whether a value is a plain object: not null and not an array.
 *
 * @param value Value to check.
 * @returns True for objects with string keys.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
