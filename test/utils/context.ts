import type {
  PrepareContext,
  PublishContext,
  VerifyConditionsContext,
} from 'semantic-release';
import { recordingLogger } from './logger.js';

export const REPOSITORY_URL = 'https://github.com/test-user/test-repo.git';

type Parts = Record<string, unknown>;

/**
 * Build the pieces every step context shares.
 * @param extra - Properties to add or override.
 * @returns The context pieces and the lines logged through them.
 */
function parts(extra: Parts): { context: Parts; lines: string[] } {
  const { logger, lines } = recordingLogger();
  return {
    lines,
    context: {
      logger,
      options: { repositoryUrl: REPOSITORY_URL },
      nextRelease: { version: '2.0.0' },
      ...extra,
    },
  };
}

/**
 * A `verifyConditions` context.
 * @param extra - Properties to add or override.
 * @returns The context and the lines logged through it.
 */
export function verifyContext(extra: Parts = {}): {
  context: VerifyConditionsContext;
  lines: string[];
} {
  const built = parts(extra);
  return {
    ...built,
    context: built.context as unknown as VerifyConditionsContext,
  };
}

/**
 * A `prepare` context.
 * @param extra - Properties to add or override.
 * @returns The context and the lines logged through it.
 */
export function prepareContext(extra: Parts = {}): {
  context: PrepareContext;
  lines: string[];
} {
  const built = parts(extra);
  return { ...built, context: built.context as unknown as PrepareContext };
}

/**
 * A `publish` context.
 * @param extra - Properties to add or override.
 * @returns The context and the lines logged through it.
 */
export function publishContext(extra: Parts = {}): {
  context: PublishContext;
  lines: string[];
} {
  const built = parts(extra);
  return { ...built, context: built.context as unknown as PublishContext };
}
