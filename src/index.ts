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
  composerEnv,
  cwdOf,
  requireRepositoryUrl,
  resolveCredentials,
  secretsOf,
  type PackagistPluginConfig,
  type StepLogger,
} from './plugin-config.js';
import { codeOf, messageOf } from './utils/error.js';
import { isRecord } from './utils/object.js';
import { redactCredentials } from './utils/redact.js';
import { truncate } from './utils/text.js';
import { redactUrl } from './utils/url.js';

export type { PackagistPluginConfig } from './plugin-config.js';

/**
 * The most of a command's output that is repeated in an error message.
 */
const MAX_OUTPUT_CHARS = 2000;

/**
 * What a command that failed said, safe to show: its standard error (or else
 * the error's message) without secrets and cut short.
 *
 * @param error The caught value, typically from `execSync`.
 * @param secrets Secrets to remove from the output.
 * @returns The output.
 */
function outputOf(error: unknown, secrets: readonly string[]): string {
  const stderr = isRecord(error) ? String(error.stderr ?? '').trim() : '';
  return truncate(
    redactCredentials(stderr || messageOf(error), secrets),
    MAX_OUTPUT_CHARS,
  );
}

/**
 * Run the default `composer` command. A `composer` that is not installed is
 * reported as such; this is decided only here, where the executable is run, so
 * that a custom command that fails with `ENOENT` is not blamed on Composer.
 *
 * @param args Arguments for `composer`.
 * @param cwd Directory to run in.
 * @param env Environment variables of the release.
 * @param secrets Secrets to remove from the output.
 * @throws {SemanticReleaseError} With code `ECOMPOSERNOTFOUND` if `composer`
 * is missing; otherwise the error of the command.
 */
function runComposer(
  args: string,
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
  secrets: readonly string[],
): void {
  try {
    execSync(`composer ${args}`, {
      cwd,
      stdio: 'pipe',
      env: composerEnv(env),
    });
  } catch (error: unknown) {
    const stderr = isRecord(error) ? String(error.stderr ?? '') : '';
    const missing =
      codeOf(error) === 'ENOENT' ||
      (isRecord(error) &&
        error.status === 127 &&
        /\bcomposer: (command )?not found/i.test(stderr));
    if (missing) {
      throw new SemanticReleaseError(
        '`composer` could not be run.',
        'ECOMPOSERNOTFOUND',
        `The \`composer\` executable was not found. Install Composer, or provide a custom command in the plugin configuration. Output: ${outputOf(error, secrets)}`,
      );
    }
    throw error;
  }
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
  const env = context.env ?? process.env;
  const secrets = secretsOf(pluginConfig, env);

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
      runComposer(
        'validate --strict --no-check-version',
        currentWorkingDir,
        env,
        secrets,
      );
      log.log('composer.json is valid (default validation).');
    };

    const validateFn: (cwd: string, logger: StepLogger) => Promise<void> =
      pluginConfig.composerValidationCommand ||
      (async (currentWorkingDir, log) =>
        defaultValidateCommandSync(currentWorkingDir, log));

    try {
      await validateFn(cwd, logger);
    } catch (error: unknown) {
      if (codeOf(error) === 'ECOMPOSERNOTFOUND') {
        throw error;
      }
      throw new SemanticReleaseError(
        '`composer.json` validation failed.',
        'EINVALIDCOMPOSERJSON',
        `The \`composer.json\` file is not valid. Please check its structure or the output of your custom validation command. If using default validation, run \`composer validate --strict --no-check-version\` locally. Output: ${outputOf(error, secrets)}`,
      );
    }
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
  const env = context.env ?? process.env;
  const secrets = secretsOf(pluginConfig, env);

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
        runComposer('update --lock', currentWorkingDir, env, secrets);
        log.log('composer.lock updated (default command).');
      };

      const updateLockFn: (cwd: string, logger: StepLogger) => Promise<void> =
        pluginConfig.composerLockUpdateCommand ||
        (async (currentWorkingDir, log) =>
          defaultLockUpdateCommandSync(currentWorkingDir, log));

      try {
        await updateLockFn(cwd, logger);
      } catch (error: unknown) {
        if (codeOf(error) === 'ECOMPOSERNOTFOUND') {
          throw error;
        }
        throw new SemanticReleaseError(
          '`composer.lock` update failed.',
          'ELOCKUPDATEFAILED',
          // By shape, not `instanceof`: errors from child processes can come
          // from another realm.
          isRecord(error) && typeof error.message === 'string'
            ? outputOf(error, secrets)
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
