import * as fs from 'node:fs';
import SemanticReleaseError from '@semantic-release/error';
import type {
  PrepareContext,
  PublishContext,
  VerifyConditionsContext,
} from 'semantic-release';
import { updateLock, validate, type ComposerOptions } from './composer.js';
import { PackagistClient } from './packagist.js';
import {
  cwdOf,
  requireRepositoryUrl,
  resolveCredentials,
  secretsOf,
  type PackagistPluginConfig,
} from './plugin-config.js';
import { messageOf } from './utils/error.js';
import { isRecord } from './utils/object.js';
import { redactUrl } from './utils/url.js';

export type { PackagistPluginConfig } from './plugin-config.js';

/**
 * The options for the `composer` commands of a step.
 * @param pluginConfig - The plugin configuration.
 * @param context - The semantic-release context.
 * @returns The project that is being released and its commands.
 */
function composerOptions(
  pluginConfig: PackagistPluginConfig,
  context: VerifyConditionsContext | PrepareContext,
): ComposerOptions {
  const env = context.env ?? process.env;
  return {
    cwd: cwdOf(context),
    logger: context.logger,
    env,
    secrets: secretsOf(pluginConfig, env),
    validateCommand: pluginConfig.composerValidationCommand,
    updateLockCommand: pluginConfig.composerLockUpdateCommand,
  };
}

/**
 * Read and parse a `composer.json`.
 * @param path - The file.
 * @returns The parsed JSON, which is not necessarily an object.
 * @throws {SemanticReleaseError} If the file is not valid JSON.
 */
function parseComposerJson(path: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (error: unknown) {
    throw new SemanticReleaseError(
      '`composer.json` validation failed.',
      'EINVALIDCOMPOSERJSON',
      `The \`composer.json\` file could not be parsed: ${messageOf(error)}`,
    );
  }
}

/**
 * Verifies the conditions for the plugin to run. This includes checking for
 * `composer.json` and running `composer validate`, and ensuring Packagist
 * credentials and the repository URL are available.
 * @param pluginConfig - The plugin configuration.
 * @param context - The semantic-release context.
 * @throws {SemanticReleaseError} If `composer.json` is missing or invalid, or if required configuration is missing.
 */
export async function verifyConditions(
  pluginConfig: PackagistPluginConfig,
  context: VerifyConditionsContext,
): Promise<void> {
  const { logger, options } = context;
  const cwd = cwdOf(context);
  const env = context.env ?? process.env;

  const composerJsonPath = `${cwd}/composer.json`;
  if (fs.existsSync(composerJsonPath)) {
    logger.log('Validating composer.json...');

    await validate(composerOptions(pluginConfig, context));
  } else {
    throw new SemanticReleaseError(
      'composer.json not found.',
      'EMISSINGCOMPOSERJSON',
      `A \`composer.json\` file is required by this plugin but was not found in ${cwd}.`,
    );
  }

  resolveCredentials(pluginConfig, env);

  requireRepositoryUrl(options);

  logger.log('Packagist conditions verified.');
}

/**
 * Prepares the release by updating the `version` field in `composer.json`
 * and optionally updating `composer.lock`.
 * @param pluginConfig - The plugin configuration.
 * @param context - The semantic-release context.
 * @throws {SemanticReleaseError} If composer.json is not found or if lock file update fails.
 */
export async function prepare(
  pluginConfig: PackagistPluginConfig,
  context: PrepareContext,
): Promise<void> {
  const {
    nextRelease: { version },
    logger,
  } = context;
  const cwd = cwdOf(context);

  const composerJsonPath = `${cwd}/composer.json`;
  if (fs.existsSync(composerJsonPath)) {
    logger.log('Writing version %s to %s', version, composerJsonPath);

    const composerData = parseComposerJson(composerJsonPath);
    if (!isRecord(composerData)) {
      throw new SemanticReleaseError(
        '`composer.json` validation failed.',
        'EINVALIDCOMPOSERJSON',
        'The `composer.json` file must contain a JSON object.',
      );
    }
    fs.writeFileSync(
      composerJsonPath,
      JSON.stringify({ ...composerData, version }, null, 4),
    );

    logger.log('Prepared composer.json');

    const composerLockPath = `${cwd}/composer.lock`;
    if (fs.existsSync(composerLockPath)) {
      logger.log('Updating composer.lock...');

      await updateLock(composerOptions(pluginConfig, context));
    } else {
      logger.log('composer.lock not found, skipping lock file update.');
    }
  } else {
    throw new SemanticReleaseError(
      'composer.json not found during prepare step.',
      'EMISSINGCOMPOSERJSON',
      `The prepare step requires a \`composer.json\` file to update the version. The file was not found in ${cwd}.`,
    );
  }
}

/**
 * Publishes the package to Packagist by triggering a repository sync.
 * @param pluginConfig - The plugin configuration.
 * @param context - The semantic-release context.
 * @throws {SemanticReleaseError} If the API call to Packagist fails.
 */
export async function publish(
  pluginConfig: PackagistPluginConfig,
  context: PublishContext,
): Promise<void> {
  const { logger, options } = context;

  try {
    const repositoryUrl = requireRepositoryUrl(options);

    logger.log(
      `Notifying Packagist to update the package at ${redactUrl(repositoryUrl)}`,
    );

    await new PackagistClient(
      resolveCredentials(pluginConfig, context.env ?? process.env),
    ).updatePackage(repositoryUrl);

    logger.log('Successfully notified Packagist.');
  } catch (error: unknown) {
    if (error instanceof SemanticReleaseError) {
      throw error;
    }
    logger.error(
      'An unexpected error occurred while publishing to Packagist: %s',
      messageOf(error),
    );
    throw new SemanticReleaseError(
      'An unexpected error occurred.',
      'EUNEXPECTED',
      messageOf(error),
    );
  }
}

export default { verifyConditions, prepare, publish } as const;
