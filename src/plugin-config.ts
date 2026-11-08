import type { VerifyConditionsContext } from 'semantic-release';
import SemanticReleaseError from '@semantic-release/error';

/**
 * The logger semantic-release hands to every step.
 */
export type StepLogger = VerifyConditionsContext['logger'];

/**
 * The configuration for the Packagist plugin.
 */
export interface PackagistPluginConfig {
  /**
   * Your Packagist username.
   * Can be provided via the PACKAGIST_USERNAME environment variable.
   */
  readonly username?: string;
  /**
   * Your Packagist API Token.
   * Can be provided via the PACKAGIST_TOKEN environment variable.
   */
  readonly apiToken?: string;
  /**
   * Optional. A custom function to validate composer.json.
   * If not provided, defaults to running `composer validate --strict --no-check-version`.
   * The function should throw an error if validation fails.
   * @param cwd The current working directory.
   * @param logger The semantic-release logger.
   * @returns {Promise<void>}
   */
  readonly composerValidationCommand?: (
    cwd: string,
    logger: StepLogger,
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
  readonly composerLockUpdateCommand?: (
    cwd: string,
    logger: StepLogger,
  ) => Promise<void>;
}

/**
 * The Packagist account that is notified of a release.
 */
export interface PackagistCredentials {
  readonly username: string;
  readonly apiToken: string;
}

/**
 * Find the Packagist credentials: the plugin configuration wins over the
 * `PACKAGIST_USERNAME` and `PACKAGIST_TOKEN` environment variables.
 *
 * @param config Plugin configuration from the semantic-release config.
 * @param env Environment variables.
 * @returns The username and API token.
 * @throws {SemanticReleaseError} If the username or the token is missing.
 */
export function resolveCredentials(
  config: PackagistPluginConfig,
  env: Readonly<Record<string, string | undefined>> = process.env,
): PackagistCredentials {
  const username = config.username || env.PACKAGIST_USERNAME;
  const apiToken = config.apiToken || env.PACKAGIST_TOKEN;
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
  return { username, apiToken };
}
