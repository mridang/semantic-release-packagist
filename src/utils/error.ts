/**
 * The message of anything that was thrown.
 *
 * @param error A caught value, which is not necessarily an `Error`.
 * @returns Its message, or its string form when it is not an `Error`.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
