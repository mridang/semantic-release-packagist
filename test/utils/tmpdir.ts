import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Create a temporary directory populated with files, run a function in it and
 * remove it afterwards.
 * @param files - Map of relative path to file contents.
 * @param fn - Function receiving the directory path.
 * @returns Whatever the function returns.
 */
export async function withTmp<T>(
  files: Record<string, string>,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'packagist-test-'));
  try {
    await Promise.all(
      Object.entries(files).map(async ([name, contents]) => {
        await mkdir(dirname(join(dir, name)), { recursive: true });
        await writeFile(join(dir, name), contents);
      }),
    );
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
