import { STATUS_CODES } from 'node:http';
import SemanticReleaseError from '@semantic-release/error';
import { Agent, RetryAgent, fetch, type Dispatcher } from 'undici';
import type { PackagistCredentials } from './plugin-config.js';
import { isRecord, numberAt } from './utils/object.js';

const UPDATE_PACKAGE_URL = 'https://packagist.org/api/update-package';

const TIMEOUT_MS = 30000;

/**
 * Options for building a {@link PackagistClient}. All of them exist so that
 * tests can run without the network.
 */
export interface PackagistClientOptions {
  /** The `fetch` to call. Defaults to undici's. */
  readonly fetcher?: typeof fetch;
  /** The dispatcher that is wrapped in the retrying agent. */
  readonly agent?: Dispatcher;
  /** The first back-off in milliseconds, then doubled up to `maxTimeout`. */
  readonly minTimeout?: number;
}

/**
 * The outcome of one call to the update endpoint, with the response body
 * already read.
 */
type Reply =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly status: number;
      readonly statusText: string;
      readonly body: string;
    };

/**
 * The HTTP status that made undici give up retrying. After the last retry
 * undici rejects with a `fetch failed` error whose `cause` carries the status
 * of the final response.
 *
 * @param error A caught value.
 * @returns The status code, or undefined when the failure was something else.
 */
function retriedStatusOf(error: unknown): number | undefined {
  return isRecord(error) && isRecord(error.cause)
    ? numberAt(error.cause, 'statusCode')
    : undefined;
}

/**
 * The error that describes a failed reply.
 *
 * @param reply The failed reply.
 * @param repositoryUrl The repository that was announced.
 * @returns The error to throw.
 */
function errorFor(
  reply: Extract<Reply, { ok: false }>,
  repositoryUrl: string,
): SemanticReleaseError {
  switch (reply.status) {
    case 401:
    case 403:
      return new SemanticReleaseError(
        'Invalid Packagist credentials.',
        'EINVALIDPACKAGISTTOKEN',
        `The Packagist API returned a ${reply.status} status. Please check that the configured \`username\` and \`apiToken\` are correct and have permissions to update the package.`,
      );
    case 404:
      return new SemanticReleaseError(
        'Packagist package not found.',
        'EPACKAGISTNOTFOUND',
        `The Packagist API returned a 404 Not Found error. Please check that the package linked to the repository \`${repositoryUrl}\` exists on Packagist.`,
      );
    default:
      return new SemanticReleaseError(
        `Failed to notify Packagist: ${reply.statusText}`,
        'EPACKAGISTAPI',
        `The Packagist API returned an unexpected ${reply.status} status. Response: ${reply.body}`,
      );
  }
}

/**
 * A client for the Packagist API. Calls time out after 30 seconds and are
 * retried by undici's `RetryAgent` on throttling (429), server errors and
 * dropped connections, honouring `Retry-After`.
 */
export class PackagistClient {
  private readonly credentials: PackagistCredentials;

  private readonly fetcher: typeof fetch;

  private readonly dispatcher: Dispatcher;

  /**
   * @param credentials The Packagist account to act as.
   * @param options Test seams for the `fetch`, the agent and the back-off.
   */
  constructor(
    credentials: PackagistCredentials,
    options: PackagistClientOptions = {},
  ) {
    this.credentials = credentials;
    this.fetcher = options.fetcher ?? fetch;
    this.dispatcher = new RetryAgent(
      options.agent ??
        new Agent({
          connect: { timeout: TIMEOUT_MS },
          headersTimeout: TIMEOUT_MS,
          bodyTimeout: TIMEOUT_MS,
        }),
      {
        maxRetries: 3,
        minTimeout: options.minTimeout ?? 1000,
        maxTimeout: 15000,
        // The only call is a POST, which undici does not retry by default.
        // It asks Packagist to sync the repository, so repeating it only
        // triggers another sync and is safe.
        methods: ['POST'],
      },
    );
  }

  /**
   * Ask Packagist to re-read a repository so that the new release shows up.
   *
   * @param repositoryUrl The repository that Packagist tracks.
   * @throws {SemanticReleaseError} If Packagist rejects the credentials, does
   * not know the package, or keeps failing after the retries.
   * @throws If the network fails after the retries. The error never contains
   * the API token.
   */
  async updatePackage(repositoryUrl: string): Promise<void> {
    const url = new URL(UPDATE_PACKAGE_URL);
    url.searchParams.set('username', this.credentials.username);
    url.searchParams.set('apiToken', this.credentials.apiToken);
    const reply = await this.post(url, repositoryUrl).catch(
      (error: unknown): Reply => {
        const status = retriedStatusOf(error);
        if (status === undefined) {
          throw error;
        }
        return {
          ok: false,
          status,
          statusText: STATUS_CODES[status] ?? '',
          body: '',
        };
      },
    );
    if (!reply.ok) {
      throw errorFor(reply, repositoryUrl);
    }
  }

  /**
   * Send the request and read the reply.
   *
   * @param url The endpoint, including the credentials in its query.
   * @param repositoryUrl The repository to announce.
   * @returns The status and, for a failure, the body.
   */
  private async post(url: URL, repositoryUrl: string): Promise<Reply> {
    const response = await this.fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repository: { url: repositoryUrl } }),
      dispatcher: this.dispatcher,
    });
    return response.ok
      ? { ok: true }
      : {
          ok: false,
          status: response.status,
          statusText: response.statusText,
          body: await response.text(),
        };
  }
}
