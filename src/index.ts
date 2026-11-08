import * as fs from 'fs';
import { execSync } from 'node:child_process';
import SemanticReleaseError from '@semantic-release/error';
import type {
  PrepareContext,
  PublishContext,
  VerifyConditionsContext,
} from 'semantic-release';
import { PackagistClient } from './packagist.js';
import {
  cwdOf,
  requireRepositoryUrl,
  resolveCredentials,
  type PackagistPluginConfig,
  type StepLogger,
} from './plugin-config.js';
import { messageOf } from './utils/error.js';
import { isRecord } from './utils/object.js';
import { redactUrl } from './utils/url.js';

export type { PackagistPluginConfig } from './plugin-config.js';

/**
 * What went wrong when a command could not complete.
 *
 * @param error The caught value, typically from `execSync`.
 * @returns Whether the executable is missing, and the command's own output
 * (its standard error, or else the error's message).
 */
function failureOf(error: unknown): {
  readonly missing: boolean;
  readonly output: string;
} {
  const record = isRecord(error) ? error : {};
  const stderr = String(record.stderr ?? '').trim();
  return {
    missing: record.code === 'ENOENT' || record.status === 127,
    output: stderr || messageOf(error),
  };
}

/**
 * The error for a `composer` executable that is not installed.
 *
 * @param output What the shell reported.
 * @returns The error to throw.
 */
function composerMissing(output: string): SemanticReleaseError {
  return new SemanticReleaseError(
    '`composer` could not be run.',
    'ECOMPOSERNOTFOUND',
    `The \`composer\` executable was not found. Install Composer, or provide a custom command in the plugin configuration. Output: ${output}`,
  );
}

/**
 * Read and parse a `composer.json`.
 *
 * @param path The file.
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
 * @param pluginConfig The plugin configuration.
 * @param context The semantic-release context.
 * @throws {SemanticReleaseError} If `composer.json` is missing or invalid, or if required configuration is missing.
 */
export async function verifyConditions(
  pluginConfig: PackagistPluginConfig,
  context: VerifyConditionsContext,
): Promise<void> {
  const { logger, options } = context;
  const cwd = cwdOf(context);

  const composerJsonPath = `${cwd}/composer.json`;
  if (fs.existsSync(composerJsonPath)) {
    logger.log('Validating composer.json...');

    const defaultValidateCommandSync = (
      currentWorkingDir: string,
      log: StepLogger,
    ): void => {
      log.log(
        'Executing default validation: composer validate --strict --no-check-version',
      );
      execSync('composer validate --strict --no-check-version', {
        cwd: currentWorkingDir,
        stdio: 'pipe',
        env: process.env,
      });
      log.log('composer.json is valid (default validation).');
    };

    const validateFn: (cwd: string, logger: StepLogger) => Promise<void> =
      pluginConfig.composerValidationCommand ||
      (async (currentWorkingDir, log) =>
        defaultValidateCommandSync(currentWorkingDir, log));

    try {
      await validateFn(cwd, logger);
    } catch (error: unknown) {
      const { missing, output } = failureOf(error);
      throw missing
        ? composerMissing(output)
        : new SemanticReleaseError(
            '`composer.json` validation failed.',
            'EINVALIDCOMPOSERJSON',
            `The \`composer.json\` file is not valid. Please check its structure or the output of your custom validation command. If using default validation, run \`composer validate --strict --no-check-version\` locally. Output: ${output}`,
          );
    }
  } else {
    throw new SemanticReleaseError(
      'composer.json not found.',
      'EMISSINGCOMPOSERJSON',
      `A \`composer.json\` file is required by this plugin but was not found in ${cwd}.`,
    );
  }

  resolveCredentials(pluginConfig);

  requireRepositoryUrl(options);

  logger.log('Packagist conditions verified.');
}

/**
 * Prepares the release by updating the `version` field in `composer.json`
 * and optionally updating `composer.lock`.
 * @param pluginConfig The plugin configuration.
 * @param context The semantic-release context.
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

      const defaultLockUpdateCommandSync = (
        currentWorkingDir: string,
        log: StepLogger,
      ): void => {
        log.log('Executing default lock update: composer update --lock');
        // execSync will throw an error if the command fails
        execSync('composer update --lock', {
          cwd: currentWorkingDir,
          stdio: 'pipe',
          env: process.env,
        });
        log.log('composer.lock updated (default command).');
      };

      const updateLockFn: (cwd: string, logger: StepLogger) => Promise<void> =
        pluginConfig.composerLockUpdateCommand ||
        (async (currentWorkingDir, log) =>
          defaultLockUpdateCommandSync(currentWorkingDir, log));

      try {
        await updateLockFn(cwd, logger);
      } catch (error: unknown) {
        const { missing, output } = failureOf(error);
        if (missing) {
          throw composerMissing(output);
        }
        throw new SemanticReleaseError(
          '`composer.lock` update failed.',
          'ELOCKUPDATEFAILED',
          // By shape, not `instanceof`: errors from child processes can come
          // from another realm.
          isRecord(error) && typeof error.message === 'string'
            ? error.message
            : 'Please check your custom lock update command or run `composer update --lock` locally to see more details.',
        );
      }
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
 * @param pluginConfig The plugin configuration.
 * @param context The semantic-release context.
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

    await new PackagistClient(resolveCredentials(pluginConfig)).updatePackage(
      repositoryUrl,
    );

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
