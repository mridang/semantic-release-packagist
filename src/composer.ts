import SemanticReleaseError from '@semantic-release/error';
import { codeOf, messageOf } from './utils/error.js';
import { run, type ExecOptions, type Runner } from './utils/exec.js';
import { isRecord } from './utils/object.js';
import { redactSecrets } from './utils/redact.js';
import { truncate } from './utils/text.js';
import type { StepLogger } from './plugin-config.js';

/**
 * A custom command from the plugin configuration: a function the user wrote,
 * which is run as it is.
 */
export type CustomCommand = (cwd: string, logger: StepLogger) => Promise<void>;

/**
 * The most of a command's output that is repeated in an error message.
 */
const MAX_OUTPUT_CHARS = 2000;

/**
 * Options for building a {@link ComposerClient}.
 */
export interface ComposerClientOptions {
  /** The directory that holds `composer.json`. */
  readonly cwd: string;
  /** The logger of the semantic-release step. */
  readonly logger: StepLogger;
  /** The environment of the release, which `composer` inherits. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Secrets to remove from any output of `composer` that is shown. */
  readonly secrets: readonly string[];
  /** Replaces the default `composer validate`. */
  readonly validateCommand?: CustomCommand | undefined;
  /** Replaces the default `composer update --lock`. */
  readonly updateLockCommand?: CustomCommand | undefined;
  /** Runs a program without a shell. Tests pass a fake. */
  readonly run?: Runner;
}

/**
 * A handle on the `composer` command for one project. The default commands run
 * `composer` without a shell, in the project directory, with an environment
 * that has no `PACKAGIST_*` values, and what they print is scrubbed of secrets
 * and shortened before it enters an error. A custom command from the
 * configuration replaces a default one and is run as it is.
 */
export class ComposerClient {
  private readonly options: ComposerClientOptions;

  private readonly runner: Runner;

  /**
   * @param options The project, the release environment and the commands.
   */
  constructor(options: ComposerClientOptions) {
    this.options = options;
    this.runner = options.run ?? run;
  }

  /**
   * Check that `composer.json` is valid, with `composer validate --strict
   * --no-check-version` unless a custom command was configured.
   *
   * @throws {SemanticReleaseError} `EINVALIDCOMPOSERJSON` if the check fails,
   * with what the command printed; `ECOMPOSERNOTFOUND` if the default command
   * could not be started because `composer` is not installed.
   */
  async validate(): Promise<void> {
    const { cwd, logger, validateCommand } = this.options;
    try {
      if (validateCommand) {
        await validateCommand(cwd, logger);
        return;
      }
      logger.log(
        'Executing default validation: composer validate --strict --no-check-version',
      );
      await this.composer(['validate', '--strict', '--no-check-version']);
      logger.log('composer.json is valid (default validation).');
    } catch (error: unknown) {
      if (codeOf(error) === 'ECOMPOSERNOTFOUND') {
        throw error;
      }
      throw new SemanticReleaseError(
        '`composer.json` validation failed.',
        'EINVALIDCOMPOSERJSON',
        `The \`composer.json\` file is not valid. Please check its structure or the output of your custom validation command. If using default validation, run \`composer validate --strict --no-check-version\` locally. Output: ${this.outputOf(error)}`,
      );
    }
  }

  /**
   * Bring `composer.lock` up to date with `composer update --lock` unless a
   * custom command was configured.
   *
   * @throws {SemanticReleaseError} `ELOCKUPDATEFAILED` if the update fails,
   * with what the command printed; `ECOMPOSERNOTFOUND` if the default command
   * could not be started because `composer` is not installed.
   */
  async updateLock(): Promise<void> {
    const { cwd, logger, updateLockCommand } = this.options;
    try {
      if (updateLockCommand) {
        await updateLockCommand(cwd, logger);
        return;
      }
      logger.log('Executing default lock update: composer update --lock');
      await this.composer(['update', '--lock']);
      logger.log('composer.lock updated (default command).');
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
          ? this.outputOf(error)
          : 'Please check your custom lock update command or run `composer update --lock` locally to see more details.',
      );
    }
  }

  /**
   * Run `composer` with the given arguments.
   *
   * @param args Arguments for `composer`.
   * @throws {SemanticReleaseError} `ECOMPOSERNOTFOUND` if `composer` is not
   * installed; otherwise the error of the failed command.
   */
  private async composer(args: readonly string[]): Promise<void> {
    const { cwd, env } = this.options;
    await this.runner('composer', args, {
      cwd,
      env: withoutPackagist(env),
    }).catch((error: unknown): never => {
      if (codeOf(error) === 'ENOENT') {
        throw new SemanticReleaseError(
          '`composer` could not be run.',
          'ECOMPOSERNOTFOUND',
          `The \`composer\` executable was not found. Install Composer, or provide a custom command in the plugin configuration. Output: ${this.outputOf(error)}`,
        );
      }
      throw error;
    });
  }

  /**
   * What a failed command said, safe to show: its standard error (or else the
   * error's message) without secrets and cut short.
   *
   * @param error The caught value.
   * @returns The output.
   */
  private outputOf(error: unknown): string {
    const stderr = isRecord(error) ? String(error.stderr ?? '').trim() : '';
    return truncate(
      redactSecrets(stderr || messageOf(error), this.options.secrets),
      MAX_OUTPUT_CHARS,
    );
  }
}

/**
 * The environment for `composer`: the release's own, with every `PACKAGIST_*`
 * variable emptied, because `composer`, its scripts and its plugins have no
 * use for the Packagist credentials and could print them. The runner adds
 * these values to the current environment, so a value is emptied rather than
 * left out.
 *
 * @param env The environment of the release.
 * @returns The variables to give `composer`.
 */
function withoutPackagist(
  env: Readonly<Record<string, string | undefined>>,
): NonNullable<ExecOptions['env']> {
  const names = [
    ...Object.keys(env),
    ...Object.keys(process.env),
    'PACKAGIST_USERNAME',
    'PACKAGIST_TOKEN',
  ].filter((name) => name.startsWith('PACKAGIST_'));
  return {
    ...Object.fromEntries(
      Object.entries(env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    ...Object.fromEntries(names.map((name) => [name, ''])),
  };
}
