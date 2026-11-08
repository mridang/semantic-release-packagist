import { describe, expect, it } from '@jest/globals';
// noinspection ES6PreferShortImport
import { ExecError, run } from '../../src/utils/exec.js';

const node = process.execPath;

describe('run', () => {
  it('resolves with standard output and passes arguments without a shell', async () => {
    const out = await run(node, [
      '-e',
      'console.log(process.argv[1])',
      '$(id) a;b',
    ]);
    expect(out).toBe('$(id) a;b\n');
  });

  it('uses the working directory and adds the given environment', async () => {
    const out = await run(
      node,
      [
        '-e',
        'console.log(process.cwd(), process.env.EXTRA, !!process.env.PATH)',
      ],
      { cwd: process.cwd(), env: { EXTRA: 'x y' } },
    );
    expect(out.trim()).toBe(`${process.cwd()} x y true`);
  });

  it('raises an ExecError with status and captured output on a non-zero exit', async () => {
    const failure = await run(node, [
      '-e',
      'console.log("out"); console.error("err"); process.exit(7)',
    ]).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(ExecError);
    expect(failure).toMatchObject({
      status: 7,
      stdout: 'out\n',
      stderr: 'err\n',
    });
  });

  it('reports a program that cannot be started by its code', async () => {
    const failure = await run('definitely-not-a-program-xyz', []).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure).toMatchObject({ code: 'ENOENT', status: undefined });
  });

  it('reports the signal that ended the program', async () => {
    const failure = await run(node, [
      '-e',
      'process.kill(process.pid, "SIGKILL")',
    ]).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure).toMatchObject({ signal: 'SIGKILL' });
  });

  it('removes credentials from the message and the output', async () => {
    const url = 'https://user:tok3n@example.test/x';
    const failure = await run(node, [
      '-e',
      `console.log(${JSON.stringify(url)}); console.error(${JSON.stringify(url)}); process.exit(2)`,
      url,
    ]).then(
      () => undefined,
      (e: unknown) => e,
    );
    const text = JSON.stringify(failure, Object.getOwnPropertyNames(failure));
    expect(text).not.toContain('tok3n');
    expect(text).toContain('https://***@example.test/x');
  });

  it('accepts output larger than the default pipe buffer', async () => {
    const out = await run(node, [
      '-e',
      'process.stdout.write("x".repeat(3e6))',
    ]);
    expect(out).toHaveLength(3e6);
  });
});
