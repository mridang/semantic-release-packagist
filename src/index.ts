import * as fs from 'fs';
// @ts-expect-error since this is not typed
import { Context, PluginConfig } from 'semantic-release';
// @ts-expect-error since this is not typed
import SemanticReleaseError from '@semantic-release/error';

/**
 * The configuration for the Packagist plugin.
 */
export interface PackagistPluginConfig extends PluginConfig {
  /**
   * Your Packagist username.
   */
  username: string;
  /**
   * Your Packagist API Token.
   */
  apiToken: string;
}

/**
 * The data structure of the `composer.json` file.
 */
interface ComposerJson {
  name: string;
  version?: string;
}

/**
 * Verifies the conditions for the plugin to run.
 * @param pluginConfig The plugin configuration.
 * @param context The semantic-release context.
 * @throws {SemanticReleaseError} If required configuration or context is missing.
 */
export async function verifyConditions(
  pluginConfig: PackagistPluginConfig,
  context: Context,
): Promise<void> {
  const { logger, options } = context;

  if (!pluginConfig.username) {
    throw new SemanticReleaseError(
      'Packagist username is not set.',
      'ENOPACKAGISTUSERNAME',
      'Please provide your Packagist username in the plugin configuration.',
    );
  }

  if (!pluginConfig.apiToken) {
    throw new SemanticReleaseError(
      'Packagist API token is not set.',
      'ENOPACKAGISTAPITOKEN',
      'Please provide your Packagist API token in the plugin configuration.',
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
 * Prepares the release by updating the `composer.json` file with the new version.
 * @param _pluginConfig The plugin configuration (not used in this step).
 * @param context The semantic-release context.
 * @throws {SemanticReleaseError} If composer.json is not found.
 */
export async function prepare(
  _pluginConfig: PackagistPluginConfig,
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
    const { username, apiToken } = pluginConfig;
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
          throw new SemanticReleaseError(
            'Invalid Packagist credentials.',
            'EINVALIDPACKAGISTTOKEN',
            `The Packagist API returned a ${response.status} status. Please check that the configured \`username\` and \`apiToken\` are correct and have permissions to update the package.`,
          );
        case 404:
          throw new SemanticReleaseError(
            'Packagist package not found.',
            'EPACKAGISTNOTFOUND',
            `The Packagist API returned a 404 Not Found error. Please check that the package linked to the repository \`${repositoryUrl}\` exists on Packagist.`,
          );
        default:
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
