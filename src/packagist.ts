import SemanticReleaseError from '@semantic-release/error';
import {
  RetryAgent,
  fetch,
  getGlobalDispatcher,
  type Dispatcher,
} from 'undici';
import type { PackagistCredentials } from './plugin-config.js';
import { messageOf } from './utils/error.js';

const UPDATE_PACKAGE_URL = 'https://packagist.org/api/update-package';

/**
 * The longest a whole notification may take, retries and back-off included.
 */
const TOTAL_TIMEOUT_MS = 120000;

/**
 * The longest wait between two attempts, which also caps a `Retry-After`
 * header from Packagist.
 */
const MAX_BACKOFF_MS = 15000;

/**
 * Failures worth another attempt, for the methods that may be retried. Naming them replaces undici's own list, so
 * it is repeated here with the three timeout codes added.
 */
const RETRYABLE_ERROR_CODES = [
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'ENETDOWN',
  'ENETUNREACH',
  'EHOSTDOWN',
  'EHOSTUNREACH',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
];

/**
 * Options for building a {@link PackagistClient}. All of them exist so that
 * tests can run without the network.
 */
export interface PackagistClientOptions {
  /** The `fetch` to call. Defaults to undici's. */
  readonly fetcher?: typeof fetch;
  /** The dispatcher that is wrapped in the retrying agent. */
  readonly agent?: Dispatcher;
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
 * Describe a failed request without a response, with the reason undici puts
 * in `cause` (it reports only `fetch failed` itself). The message never holds
 * the request URL, so the API token stays out of it.
 *
 * @param error A caught value.
 * @returns An error with the reason in its message.
 */
function networkErrorFor(error: unknown): Error {
  return new Error(
    error instanceof Error && error.cause !== undefined
      ? `${error.message}: ${messageOf(error.cause)}`
      : messageOf(error),
  );
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
 * A client for the Packagist API. A call is given up after two minutes in
 * total. Requests go through undici's `RetryAgent`, which retries idempotent
 * methods up to three times on throttling (429), server errors and dropped or
 * timed out connections, honouring `Retry-After` up to 15 seconds. The update
 * call is a POST that triggers a sync, and undici cannot safely replay a
 * request body, so it is deliberately never retried: a retry could never
 * trigger a second update, and a failure is reported at once.
 */
export class PackagistClient {
  private readonly credentials: PackagistCredentials;

  private readonly fetcher: typeof fetch;

  private readonly dispatcher: Dispatcher | undefined;

  /**
   * @param credentials The Packagist account to act as.
   * @param options Test seams for the `fetch` and the agent.
   */
  constructor(
    credentials: PackagistCredentials,
    options: PackagistClientOptions = {},
  ) {
    this.credentials = credentials;
    this.fetcher = options.fetcher ?? fetch;
    // A fake fetch needs no dispatcher. Otherwise wrap the global one, so
    // process-wide proxy settings still apply. POST is not in the retried
    // methods (undici's default), see the class documentation.
    this.dispatcher =
      options.fetcher === undefined || options.agent !== undefined
        ? new RetryAgent(options.agent ?? getGlobalDispatcher(), {
            maxRetries: 3,
            minTimeout: 1000,
            maxTimeout: MAX_BACKOFF_MS,
            errorCodes: RETRYABLE_ERROR_CODES,
            // Hand back the last response once the retries run out, so that
            // its status is mapped like any other.
            throwOnError: false,
          })
        : undefined;
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
      (error: unknown): never => {
        throw networkErrorFor(error);
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
      signal: AbortSignal.timeout(TOTAL_TIMEOUT_MS),
      ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
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
