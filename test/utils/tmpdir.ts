/**
 * Test helper that creates a temporary directory for the length of a callback.
 * @file
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Create a temporary directory populated with files, run a function in it and
 * remove it afterwards.
 * @template T - The value that the function returns.
 * @param files - Map of relative path to file contents.
 * @param fn - Function receiving the directory path.
 * @returns Whatever the function returns.
 * @example
 * await withTmp({ 'a/b.txt': 'x' }, async (dir) => readdir(dir));
 */
export async function withTmp<T>(
  files: Record<string, string>,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'packagist-test-'));
  try {
    await Promise.all(
      Object.entries(files).map(async ([name, contents]) => {
        await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
        await writeFile(path.join(dir, name), contents);
      }),
    );
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
