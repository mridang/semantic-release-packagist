import * as fs from 'fs';
// @ts-expect-error since this is not typed
import { Context, PluginConfig } from 'semantic-release';
// @ts-expect-error since this is not typed
import SemanticReleaseError from '@semantic-release/error';
import { exec } from 'node:child_process';

/**
 * The configuration for the Packagist plugin.
 */
export interface PackagistPluginConfig extends PluginConfig {
  /**
   * Your Packagist username.
   * Can be provided via the PACKAGIST_USERNAME environment variable.
   */
  username?: string;
  /**
   * Your Packagist API Token.
   * Can be provided via the PACKAGIST_TOKEN environment variable.
   */
  apiToken?: string;
  /**
   * Optional. A custom function to validate composer.json.
   * If not provided, defaults to running `composer validate --strict`.
   * The function should throw an error if validation fails.
   * @param cwd The current working directory.
   * @param logger The semantic-release logger.
   * @returns {Promise<void>}
   */
  composerValidationCommand?: (
    cwd: string,
    logger: Context['logger'],
  ) => Promise<void>;
  /**
   * Optional. A custom function to update composer.lock.
   * If not provided, defaults to running `composer update --lock`.
   * This is only run if a composer.lock file exists.
   * The function should throw an error if the update fails.
   * @param cwd The current working directory.
   * @param logger The semantic-release logger.
   * @returns {Promise<void>}
   */
  composerLockUpdateCommand?: (
    cwd: string,
    logger: Context['logger'],
  ) => Promise<void>;
}

/**
 * The data structure of the `composer.json` file.
 */
interface ComposerJson {
  name: string;
  version?: string;
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
  context: Context,
): Promise<void> {
  const { logger, options, cwd } = context;

  const composerJsonPath = `${cwd}/composer.json`;
  if (fs.existsSync(composerJsonPath)) {
    logger.log('Validating composer.json...');

    const defaultValidateCommand = async (
      currentWorkingDir: string,
      log: Context['logger'],
    ): Promise<void> => {
      log.log('Executing default validation: composer validate --strict');
      await exec('composer validate --strict', { cwd: currentWorkingDir });
      log.log('composer.json is valid (default validation).');
    };

    const validateFn =
      pluginConfig.composerValidationCommand || defaultValidateCommand;

    try {
      await validateFn(cwd, logger);
    } catch {
      throw new SemanticReleaseError(
        '`composer.json` validation failed.',
        'EINVALIDCOMPOSERJSON',
        'The `composer.json` file is not valid. Please check its structure or the output of your custom validation command. If using default validation, run `composer validate --strict` locally.',
      );
    }
  } else {
    throw new SemanticReleaseError(
      'composer.json not found.',
      'EMISSINGCOMPOSERJSON',
      `A \`composer.json\` file is required by this plugin but was not found in ${cwd}.`,
    );
  }

  const username = pluginConfig.username || process.env.PACKAGIST_USERNAME;
  const apiToken = pluginConfig.apiToken || process.env.PACKAGIST_TOKEN;

  if (!username) {
    throw new SemanticReleaseError(
      'Packagist username is not set.',
      'ENOPACKAGISTUSERNAME',
      'Please provide your Packagist username in the plugin configuration or as a PACKAGIST_USERNAME environment variable.',
    );
  }

  if (!apiToken) {
    throw new SemanticReleaseError(
      'Packagist API token is not set.',
      'ENOPACKAGISTAPITOKEN',
      'Please provide your Packagist API token in the plugin configuration or as a PACKAGIST_TOKEN environment variable.',
    );
  }

  if (!options.repositoryUrl) {
    throw new SemanticReleaseError(
      'Repository URL could not be determined.',
      'ENOREPOSITORYURL',
      'The repository URL is required to notify Packagist, but it could not be found in the semantic-release context.',
    );
  }

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
  context: Context,
): Promise<void> {
  const {
    cwd,
    nextRelease: { version },
    logger,
  } = context;

  const composerJsonPath = `${cwd}/composer.json`;
  if (fs.existsSync(composerJsonPath)) {
    logger.log('Writing version %s to %s', version, composerJsonPath);

    const composerJsonContent = fs.readFileSync(composerJsonPath, 'utf8');
    const composerData: ComposerJson = JSON.parse(composerJsonContent);
    composerData.version = version;
    fs.writeFileSync(composerJsonPath, JSON.stringify(composerData, null, 4));

    logger.log('Prepared composer.json');

    const composerLockPath = `${cwd}/composer.lock`;
    if (fs.existsSync(composerLockPath)) {
      logger.log('Updating composer.lock...');

      const defaultLockUpdateCommand = async (
        currentWorkingDir: string,
        log: Context['logger'],
      ): Promise<void> => {
        log.log('Executing default lock update: composer update --lock');
        await exec('composer update --lock', { cwd: currentWorkingDir });
        log.log('composer.lock updated (default command).');
      };

      const updateLockFn =
        pluginConfig.composerLockUpdateCommand || defaultLockUpdateCommand;

      try {
        await updateLockFn(cwd, logger);
      } catch (error: unknown) {
        throw new SemanticReleaseError(
          '`composer.lock` update failed.',
          'ELOCKUPDATEFAILED',
          error instanceof Error
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
  context: Context,
): Promise<void> {
  const { logger, options } = context;

  try {
    const username = pluginConfig.username || process.env.PACKAGIST_USERNAME;
    const apiToken = pluginConfig.apiToken || process.env.PACKAGIST_TOKEN;
    const { repositoryUrl } = options;

    logger.log(`Notifying Packagist to update the package at ${repositoryUrl}`);

    const response: Response = await fetch(
      `https://packagist.org/api/update-package?username=${username}&apiToken=${apiToken}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repository: { url: repositoryUrl } }),
      },
    );

    if (!response.ok) {
      const responseBody = await response.text();
      switch (response.status) {
        case 401:
        case 403:
          // noinspection ExceptionCaughtLocallyJS
          throw new SemanticReleaseError(
            'Invalid Packagist credentials.',
            'EINVALIDPACKAGISTTOKEN',
            `The Packagist API returned a ${response.status} status. Please check that the configured \`username\` and \`apiToken\` are correct and have permissions to update the package.`,
          );
        case 404:
          // noinspection ExceptionCaughtLocallyJS
          throw new SemanticReleaseError(
            'Packagist package not found.',
            'EPACKAGISTNOTFOUND',
            `The Packagist API returned a 404 Not Found error. Please check that the package linked to the repository \`${repositoryUrl}\` exists on Packagist.`,
          );
        default:
          // noinspection ExceptionCaughtLocallyJS
          throw new SemanticReleaseError(
            `Failed to notify Packagist: ${response.statusText}`,
            'EPACKAGISTAPI',
            `The Packagist API returned an unexpected ${response.status} status. Response: ${responseBody}`,
          );
      }
    }

    logger.log('Successfully notified Packagist.');
  } catch (error: unknown) {
    if (error instanceof SemanticReleaseError) {
      throw error;
    } else {
      const err = error as Error;
      logger.error(
        'An unexpected error occurred while publishing to Packagist: %s',
        err.message,
      );
      throw new SemanticReleaseError(
        'An unexpected error occurred.',
        'EUNEXPECTED',
        err.message,
      );
    }
  }
}
