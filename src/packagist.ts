import SemanticReleaseError from '@semantic-release/error';
import {
  EnvHttpProxyAgent,
  RetryAgent,
  interceptors,
  request,
  type Dispatcher,
} from 'undici';
import { STATUS_CODES } from 'node:http';
import type { PackagistCredentials } from './plugin-config.js';
import { messageOf } from './utils/error.js';
import { redactUrl } from './utils/url.js';
import type { Readable } from 'node:stream';

const UPDATE_PACKAGE_URL = 'https://packagist.org/api/update-package';

/**
 * The longest a whole notification may take, retries and back-off included.
 */
const DEADLINE_MS = 120000;

/**
 * The longest a single attempt may wait for the response headers or the body.
 * An attempt that stalls is abandoned and retried.
 */
const ATTEMPT_TIMEOUT_MS = 30000;

/**
 * The longest wait between two attempts, which also caps a `Retry-After`
 * header from Packagist. It is never more than a quarter of the deadline, so
 * the waits of three retries always fit in the time budget and no timer is
 * left running once the call has failed.
 */
const MAX_BACKOFF_MS = 15000;

/**
 * Methods that are safe to repeat.
 */
const IDEMPOTENT_METHODS = ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE'];

/**
 * How many redirects are followed, as `fetch` did before.
 */
const MAX_REDIRECTIONS = 3;

/**
 * The most of a response that is read. The API answers with a few hundred
 * bytes; anything larger is not worth holding in memory.
 */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * The most of a response that is repeated in an error message.
 */
const MAX_DETAIL_CHARS = 2000;

const USER_AGENT = 'semantic-release-packagist';

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
 * @param attemptTimeoutMs How long one attempt may wait for the response.
 * @returns A dispatcher with connection and response timeouts.
 */
function connections(attemptTimeoutMs: number): Dispatcher {
  return new EnvHttpProxyAgent({
    connect: { timeout: 10000 },
    headersTimeout: attemptTimeoutMs,
    bodyTimeout: attemptTimeoutMs,
    // Measured on Node 22 and 24 against a server that keeps connections
    // open: with undici's default keep-alive a script that has made the call
    // stays alive for about 3 seconds after it. A one-shot client has no use
    // for an idle connection.
    keepAliveTimeout: 1,
    keepAliveMaxTimeout: 1,
  });
}

/**
 * Read the start of a response body, at most {@link MAX_BODY_BYTES}, and
 * release the connection. A body that fails halfway yields what arrived.
 *
 * @param body The response body.
 * @returns The text read so far.
 */
async function readCapped(body: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  const size = (): number =>
    chunks.reduce((total, chunk) => total + chunk.length, 0);
  body.on('error', () => undefined);
  try {
    for await (const chunk of body) {
      chunks.push(Buffer.from(chunk));
      if (size() >= MAX_BODY_BYTES) {
        break;
      }
    }
  } catch {
    // The body only explains the failure; losing the rest must not change it.
  }
  body.destroy();
  return Buffer.concat(chunks).subarray(0, MAX_BODY_BYTES).toString('utf8');
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
 * Shorten text for an error message.
 *
 * @param text Text of any length.
 * @returns At most {@link MAX_DETAIL_CHARS} characters, marked when cut.
 */
function truncated(text: string): string {
  return text.length > MAX_DETAIL_CHARS
    ? `${text.slice(0, MAX_DETAIL_CHARS)}... (truncated)`
    : text;
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
        `The Packagist API returned a 404 Not Found error. Please check that the package linked to the repository \`${redactUrl(repositoryUrl)}\` exists on Packagist.`,
      );
    default:
      return new SemanticReleaseError(
        `Failed to notify Packagist: ${reply.statusText}`,
        'EPACKAGISTAPI',
        `The Packagist API returned an unexpected ${reply.status} status. Response: ${truncated(reply.body)}`,
      );
  }
}

/**
 * A client for the Packagist API. A call is given up after two minutes in
 * total, and an attempt that stalls for 30 seconds is abandoned and retried. Requests go through undici's `request` and `RetryAgent`, which
 * retries up to three times on throttling (429), server errors and dropped or
 * timed out connections, honouring `Retry-After` up to 15 seconds, and
 * redirects are followed up to three times. The update
 * call is a POST, and it is retried because repeating it is safe: it only
 * asks Packagist to crawl the repository again. Once the retries run out the
 * last response is reported.
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
        minTimeout: options.minTimeout ?? 1000,
        maxTimeout: Math.min(MAX_BACKOFF_MS, Math.floor(this.deadlineMs / 4)),
        errorCodes: RETRYABLE_ERROR_CODES,
        // Hand back the last response once the retries run out, so that its
        // status is mapped like any other.
        throwOnError: false,
        // Only methods that are safe to repeat, plus the update call: it is a
        // POST that only asks Packagist to crawl the repository again, so
        // repeating it is safe. Its body is a string, which undici can
        // replay.
        methods: [...IDEMPOTENT_METHODS, 'POST'],
      },
    ).compose(interceptors.redirect({ maxRedirections: MAX_REDIRECTIONS }));
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
        const failure = networkErrorFor(error);
        throw new Error(this.scrub(failure.message));
      },
    );
    if (!reply.ok) {
      throw errorFor({ ...reply, body: this.scrub(reply.body) }, repositoryUrl);
    }
  }

  /**
   * Remove the API token from text that is about to be shown. A server may
   * echo the request URL, which carries the token in its query.
   *
   * @param text Text that came from the network.
   * @returns The text with every form of the token replaced.
   */
  private scrub(text: string): string {
    const { apiToken } = this.credentials;
    const forms = [
      apiToken,
      encodeURIComponent(apiToken),
      new URLSearchParams({ t: apiToken }).toString().slice(2),
    ];
    return forms.reduce(
      (out, form) => out.replaceAll(form, '[redacted]'),
      text,
    );
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
      statusText: STATUS_CODES[statusCode] ?? '',
      body: await readCapped(body),
    };
  }
}
