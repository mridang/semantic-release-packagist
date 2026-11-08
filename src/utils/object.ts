/**
 * Whether a value is a plain object: not null and not an array.
 *
 * @param value Value to check.
 * @returns True for objects with string keys.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read a number property of an untrusted object.
 *
 * @param record The object.
 * @param key Property name.
 * @returns The value when it is a number, otherwise undefined.
 */
export function numberAt(
  record: Readonly<Record<string, unknown>>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === 'number' ? value : undefined;
}
