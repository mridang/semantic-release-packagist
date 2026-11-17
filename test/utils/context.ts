/**
 * Test helpers that build semantic-release step contexts.
 * @file
 */
import { recordingLogger } from './logger.js';
import type { VerifyReleaseContext } from 'semantic-release';

export const REPOSITORY_URL = 'https://github.com/test-user/test-repo.git';

type Parts = Record<string, unknown>;

/**
 * Build a step context. The tests leave out what a step does not read, such
 * as `env` (which the plugin falls back from) and the streams, so the context
 * is declared once here to be the library's type, which every step accepts.
 * @param extra - Properties to add or override.
 * @returns The context and the lines logged through it.
 * @example
 * const { context, lines } = parts({ cwd: '/project' });
 */
function parts(extra: Parts) {
  const { logger, lines } = recordingLogger();
  return {
    lines,
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the logger is a recording stand-in and the overrides are of any type, so this is the one place the fixture is declared to be the library's context type
    context: {
      logger,
      options: { repositoryUrl: REPOSITORY_URL },
      nextRelease: {
        version: '2.0.0',
        type: 'major',
        channel: 'latest',
        gitTag: 'v2.0.0',
        gitHead: 'abc1234',
        name: 'v2.0.0',
      },
      env: process.env,
      stdout: process.stdout,
      stderr: process.stderr,
      envCi: { isCi: false, commit: 'abc1234', branch: 'main' },
      branch: { name: 'main' },
      branches: [],
      commits: [],
      releases: [],
      lastRelease: {
        version: '1.9.9',
        gitTag: 'v1.9.9',
        channels: [],
        gitHead: 'abc1233',
        name: 'v1.9.9',
      },
      ...extra,
    } as VerifyReleaseContext,
  };
}

/**
 * A `verifyConditions` context.
 * @param extra - Properties to add or override.
 * @returns The context and the lines logged through it.
 * @example
 * const { context } = verifyContext({ cwd: '/project' });
 */
export function verifyContext(extra: Parts = {}) {
  return parts(extra);
}

/**
 * A `prepare` context.
 * @param extra - Properties to add or override.
 * @returns The context and the lines logged through it.
 * @example
 * const { context } = prepareContext({ nextRelease: { version: '1.0.0' } });
 */
export function prepareContext(extra: Parts = {}) {
  return parts(extra);
}

/**
 * A `publish` context.
 * @param extra - Properties to add or override.
 * @returns The context and the lines logged through it.
 * @example
 * const { context } = publishContext({ env: {} });
 */
export function publishContext(extra: Parts = {}) {
  return parts(extra);
}
