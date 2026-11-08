import SemanticReleaseError from '@semantic-release/error';
import {
  EnvHttpProxyAgent,
  RetryAgent,
  request,
  type Dispatcher,
} from 'undici';
import { STATUS_CODES } from 'node:http';
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
 * The connections to Packagist, from the installed `undici` (the runtime's
 * bundled undici cannot be wrapped by `RetryAgent`). They honour the
 * `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` environment variables, as Node's
 * own `fetch` does under `NODE_USE_ENV_PROXY`; the variables are read when a
 * client is built.
 *
 * @returns A dispatcher with connection and response timeouts.
 */
function connections(): Dispatcher {
  return new EnvHttpProxyAgent({
    connect: { timeout: 10000 },
    headersTimeout: 30000,
    bodyTimeout: 30000,
    // One notification per release: do not keep the socket (and so the
    // process) alive afterwards.
    keepAliveTimeout: 1,
    keepAliveMaxTimeout: 1,
  });
}

/**
 * Options for building a {@link PackagistClient}. All of them exist so that
 * tests can run without the network.
 */
export interface PackagistClientOptions {
  /** The first back-off in milliseconds, doubled for each retry. */
  readonly minTimeout?: number;
  /** The update endpoint. Defaults to Packagist's. */
  readonly endpoint?: string;
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
 * total. Requests go through undici's `request` and `RetryAgent`, which
 * retries up to three times on throttling (429), server errors and dropped or
 * timed out connections, honouring `Retry-After` up to 15 seconds. The update
 * call is a POST, and it is retried because repeating it is safe: it only
 * asks Packagist to crawl the repository again. Once the retries run out the
 * last response is reported.
 */
export class PackagistClient {
  private readonly credentials: PackagistCredentials;

  private readonly dispatcher: Dispatcher;

  private readonly endpoint: string;

  /**
   * @param credentials The Packagist account to act as.
   * @param options Test seams for the endpoint, the back-off and the dispatcher.
   */
  constructor(
    credentials: PackagistCredentials,
    options: PackagistClientOptions = {},
  ) {
    this.credentials = credentials;
    this.endpoint = options.endpoint ?? UPDATE_PACKAGE_URL;
    this.dispatcher = new RetryAgent(options.agent ?? connections(), {
      maxRetries: 3,
      minTimeout: options.minTimeout ?? 1000,
      maxTimeout: MAX_BACKOFF_MS,
      errorCodes: RETRYABLE_ERROR_CODES,
      // Hand back the last response once the retries run out, so that its
      // status is mapped like any other.
      throwOnError: false,
      // The update call is a POST, which undici does not retry by default. It
      // only asks Packagist to crawl the repository again, so repeating it is
      // safe. The body is a string, which undici can replay.
      methods: ['POST'],
    });
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
    const url = new URL(this.endpoint);
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
    const { statusCode, body } = await request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repository: { url: repositoryUrl } }),
      signal: AbortSignal.timeout(TOTAL_TIMEOUT_MS),
      dispatcher: this.dispatcher,
    });
    // Always read the body, so that the connection is released.
    const text = await body.text();
    return statusCode >= 200 && statusCode < 300
      ? { ok: true }
      : {
          ok: false,
          status: statusCode,
          statusText: STATUS_CODES[statusCode] ?? '',
          body: text,
        };
  }
}
