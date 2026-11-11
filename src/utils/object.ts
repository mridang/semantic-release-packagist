/**
 * Type guards and safe readers for values that come from untrusted sources.
 * @file
 */

/**
 * Whether a value is a plain object: not null and not an array.
 * @param value - Value to check.
 * @returns True for objects with string keys.
 * @example
 * isRecord({ a: 1 }); // true
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read an own string property of an untrusted object; inherited members are
 * ignored.
 * @param record - The object.
 * @param key - Property name.
 * @returns The value when it is a string, otherwise undefined.
 * @example
 * stringAt({ code: 'ENOENT' }, 'code'); // 'ENOENT'
 */
export function stringAt(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = Object.hasOwn(record, key) ? record[key] : undefined;
  return typeof value === 'string' ? value : undefined;
}

/**
 * Read an own number property of an untrusted object.
 * @param record - The object.
 * @param key - Property name.
 * @returns The value when it is a number, otherwise undefined.
 * @example
 * numberAt({ status: 2 }, 'status'); // 2
 */
export function numberAt(
  record: Readonly<Record<string, unknown>>,
  key: string,
): number | undefined {
  const value = Object.hasOwn(record, key) ? record[key] : undefined;
  return typeof value === 'number' ? value : undefined;
}
