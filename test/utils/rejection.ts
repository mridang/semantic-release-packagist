/**
 * Wait for a promise that must reject and return the rejection as the given
 * error type, so a test reads its properties without a cast.
 * @param promise - The promise that is expected to reject.
 * @param type - The error class the rejection must be an instance of.
 * @returns The rejection.
 * @throws When the promise resolves or rejects with something else.
 */
export async function rejectionOf<T extends Error>(
  promise: Promise<unknown>,
  type: abstract new (...args: never[]) => T,
): Promise<T> {
  let failure: unknown;
  try {
    await promise;
  } catch (error) {
    failure = error;
  }
  if (failure instanceof type) {
    return failure;
  }
  throw new TypeError(`Expected a rejection with ${type.name}`, {
    cause: failure,
  });
}
