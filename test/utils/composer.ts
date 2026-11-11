/**
 * Test helper that puts a stand-in `composer` executable on the `PATH`.
 * @file
 */
import { chmod, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { jest } from '@jest/globals';
import { withTmp } from './tmpdir.js';

/**
 * Run a function with a stand-in for `composer` as the only thing on the
 * `PATH`, so the default commands run without Composer installed. The plugin
 * hands `process.env` to the command, which is what makes this work.
 * @template T - The value that the function returns.
 * @param script - Shell script that becomes `composer`, or undefined for no
 * `composer` at all.
 * @param fn - Function to run.
 * @returns Whatever the function returns.
 * @example
 * await withComposer('echo ok', async () => runCommand());
 */
export async function withComposer<T>(
  script: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return withTmp({}, async (bin) => {
    if (script !== undefined) {
      const file = path.join(bin, 'composer');
      await writeFile(file, `#!/bin/sh\n${script}\n`);
      await chmod(file, 0o755);
    }
    jest.replaceProperty(process, 'env', {
      ...process.env,
      PATH: bin,
    });
    return fn();
  });
}
