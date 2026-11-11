/**
 * Global Jest teardown, which stops nothing because the suite starts no services.
 * @file
 */

/**
 * Runs once after the whole suite. There are no external services to stop.
 * @returns Resolves once the teardown has finished.
 * @example
 * await teardown();
 */
export default async function teardown(): Promise<void> {
  // No external services to tear down.
}
