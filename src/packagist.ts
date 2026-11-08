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
import { isRecord } from './utils/object.js';
import { redactCredentials } from './utils/redact.js';
import { truncate } from './utils/text.js';
import { redactUrl, userInfoSecrets } from './utils/url.js';

/**
 * The endpoint that makes Packagist crawl a repository again.
 */
const UPDATE_PACKAGE_URL = 'https://packagist.org/api/update-package';

/**
 * Sent with every request so that the service can tell who is calling.
 */
const USER_AGENT = 'semantic-release-packagist';

// The transport section below is shared, word for word, by the
// semantic-release plugins that call a remote API. Only the names of the
// service differ.

/**
 * The longest a whole call may take, retries and back-off included.
 */
const DEADLINE_MS = 120000;

/**
 * The longest a single attempt may wait for the response headers or the body.
 * An attempt that stalls is abandoned and retried.
 */
const ATTEMPT_TIMEOUT_MS = 30000;

/**
 * The longest wait between two attempts, which also caps a `Retry-After`
 * header. It is never more than a quarter of the deadline, so the waits of
 * three retries fit in the time budget. A wait that is in progress when the
 * deadline passes can still keep the process alive for up to this long.
 */
const MAX_BACKOFF_MS = 15000;

/**
 * Methods that are safe to repeat. A method that is not on this list is only
 * retried when the client names it in `methods`, as it does for the update call.
 */
const IDEMPOTENT_METHODS = ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE'];

/**
 * The most of a response body that is read. The API answers with a few hundred
 * bytes; undici stops a larger body, including the body of a response that is
 * about to be retried.
 */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * The most of a response body that is repeated in an error message.
 */
const MAX_DETAIL_CHARS = 2000;

/**
 * Failures worth another attempt, for the methods that may be retried. Naming
 * them replaces undici's own list, so it is repeated here with the resolver
 * and timeout codes added.
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
  'EAI_AGAIN',
  'ETIMEDOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
];

/**
 * The connections to the service, from the installed `undici` (the runtime's
 * bundled undici cannot be wrapped by `RetryAgent`). They honour the
 * `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` environment variables, which are
 * read when a client is built.
 *
 * @param attemptTimeoutMs How long one attempt may wait for the response.
 * @returns A dispatcher with connection and response timeouts and a cap on the
 * size of a response.
 */
function connections(attemptTimeoutMs: number): Dispatcher {
  return new EnvHttpProxyAgent({
    connect: { timeout: 10000 },
    headersTimeout: attemptTimeoutMs,
    bodyTimeout: attemptTimeoutMs,
    maxResponseSize: MAX_BODY_BYTES,
    // Measured against a server that advertises a long keep-alive: without
    // this a script that has made one call stays alive for as long as the
    // server's keep-alive (about 3 seconds against Node's own server, 58
    // seconds against one that advertises 60). A one-shot client has no use
    // for an idle connection.
    keepAliveTimeout: 1,
    keepAliveMaxTimeout: 1,
  });
}

/**
 * Describe a failed request that got no response. The message names the host
 * and the reason, and never the URL, which can hold a secret.
 *
 * @param error A caught value.
 * @param host The host that was called.
 * @returns An error with the reason in its message.
 */
function networkErrorFor(error: unknown, host: string): Error {
  const reason =
    isRecord(error) && error.cause !== undefined
      ? `${messageOf(error)}: ${messageOf(error.cause)}`
      : messageOf(error);
  return new Error(`Network error calling ${host}: ${reason}`);
}

/**
 * Options for building a {@link PackagistClient}. All of them exist so that
 * tests can run without the network.
 */
export interface PackagistClientOptions {
  /** How long one attempt may wait for the response, in milliseconds. */
  readonly attemptTimeoutMs?: number;
  /** How long the whole call may take, in milliseconds. */
  readonly deadlineMs?: number;
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
      readonly location: string | undefined;
    };

/**
 * Where a redirect points, without the query (which holds the API token when
 * the server copies the request's), the fragment or any user info.
 *
 * @param location The `Location` header.
 * @param base The URL that was called, for a relative `Location`.
 * @returns A URL that is safe to show.
 */
function placeOf(location: string, base: string): string {
  if (!URL.canParse(location, base)) {
    return '(not a valid URL)';
  }
  const target = new URL(location, base);
  return `${target.origin}${target.pathname}`;
}

/**
 * The error that describes a failed reply.
 *
 * @param reply The failed reply, whose body has been scrubbed of secrets.
 * @param repositoryUrl The repository that was announced.
 * @param endpoint The URL that was called.
 * @returns The error to throw.
 */
function errorFor(
  reply: Extract<Reply, { ok: false }>,
  repositoryUrl: string,
  endpoint: string,
): SemanticReleaseError {
  if (reply.status >= 300 && reply.status < 400) {
    return new SemanticReleaseError(
      `Failed to notify Packagist: ${reply.statusText}`,
      'EPACKAGISTAPI',
      `The Packagist API answered ${reply.status} and sent the request to ${reply.location === undefined ? 'no location' : placeOf(reply.location, endpoint)}. Redirects are never followed for this call, because a redirect would change the request.`,
    );
  }
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
        `The Packagist API returned a 404 Not Found error. Please check that the package linked to the repository \`${redactUrl(repositoryUrl)}\` exists on Packagist.`,
      );
    default:
      return new SemanticReleaseError(
        `Failed to notify Packagist: ${reply.statusText}`,
        'EPACKAGISTAPI',
        `The Packagist API returned an unexpected ${reply.status} status. Response: ${truncate(reply.body, MAX_DETAIL_CHARS)}`,
      );
  }
}

/**
 * A client for the Packagist API. A call is given up after two minutes in
 * total, and an attempt that stalls for 30 seconds is abandoned and retried.
 * Requests go through undici's `request` and `RetryAgent`, which retries up
 * to three times on throttling (429), server errors and dropped or timed out
 * connections, honouring `Retry-After` up to 15 seconds. The update call is a
 * POST and it is retried, because repeating it is safe: it only asks
 * Packagist to crawl the repository again. Once the retries run out the last
 * response is reported. A redirect is never followed, because a redirect
 * would turn the POST into another request, and is reported as an error.
 */
export class PackagistClient {
  private readonly credentials: PackagistCredentials;

  private readonly dispatcher: Dispatcher;

  private readonly endpoint: string;

  private readonly deadlineMs: number;

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
    this.deadlineMs = options.deadlineMs ?? DEADLINE_MS;
    this.dispatcher = new RetryAgent(
      options.agent ??
        connections(options.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS),
      {
        maxRetries: 3,
        minTimeout: options.minTimeout ?? 500,
        timeoutFactor: 2,
        maxTimeout: Math.min(MAX_BACKOFF_MS, Math.floor(this.deadlineMs / 4)),
        errorCodes: RETRYABLE_ERROR_CODES,
        // Hand back the last response once the retries run out, so that its
        // status is mapped like any other.
        throwOnError: false,
        // The idempotent methods, and POST for the update call: it only asks
        // Packagist to crawl the repository again, so repeating it is safe.
        // Its body is a string, which undici can replay.
        methods: [...IDEMPOTENT_METHODS, 'POST'],
      },
    );
  }

  /**
   * Ask Packagist to re-read a repository so that the new release shows up.
   *
   * @param repositoryUrl The repository that Packagist tracks.
   * @throws {SemanticReleaseError} If Packagist rejects the credentials, does
   * not know the package, redirects the request, or keeps failing after the
   * retries.
   * @throws If the network fails after the retries. The error names the host
   * and never contains the API token.
   */
  async updatePackage(repositoryUrl: string): Promise<void> {
    const url = new URL(this.endpoint);
    url.searchParams.set('username', this.credentials.username);
    url.searchParams.set('apiToken', this.credentials.apiToken);
    const secrets = [
      this.credentials.apiToken,
      ...userInfoSecrets(repositoryUrl),
    ];
    const reply = await this.post(url, repositoryUrl).catch(
      (error: unknown): never => {
        const failure = networkErrorFor(error, url.host);
        throw new Error(redactCredentials(failure.message, secrets));
      },
    );
    if (!reply.ok) {
      throw errorFor(
        { ...reply, body: redactCredentials(reply.body, secrets) },
        repositoryUrl,
        this.endpoint,
      );
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
    const { statusCode, headers, body } = await request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': USER_AGENT,
      },
      body: JSON.stringify({ repository: { url: repositoryUrl } }),
      signal: AbortSignal.timeout(this.deadlineMs),
      dispatcher: this.dispatcher,
    });
    if (statusCode >= 200 && statusCode < 300) {
      // The status is the answer. Dropping the body releases the socket, and
      // a connection that fails after the headers cannot make undici resume
      // the POST with a Range request.
      body.on('error', () => undefined);
      body.destroy();
      return { ok: true };
    }
    return {
      ok: false,
      status: statusCode,
      statusText: STATUS_CODES[statusCode] ?? `HTTP ${statusCode}`,
      // The body only explains the failure: one that is too large or breaks
      // off must not change it.
      body: await body.text().catch(() => ''),
      location:
        typeof headers.location === 'string' ? headers.location : undefined,
    };
  }
}
