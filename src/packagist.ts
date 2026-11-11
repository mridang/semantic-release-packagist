/**
 * The HTTP transport and the Packagist API client: retries, deadlines,
 * redirects and the translation of responses into semantic-release errors.
 * @file
 */
import SemanticReleaseError from '@semantic-release/error';
import {
  EnvHttpProxyAgent,
  RetryAgent,
  request as send,
  type Dispatcher,
} from 'undici';
import { STATUS_CODES } from 'node:http';
import type { PackagistCredentials } from './plugin-config.js';
import { codeOf, messageOf } from './utils/error.js';
import { isRecord, numberAt, stringAt } from './utils/object.js';
import { redactSecrets } from './utils/redact.js';
import { truncate } from './utils/text.js';
import { redactUrl, userInfoSecrets } from './utils/url.js';

/**
 * What a call to the store came back with, with the body already read.
 */
export interface HttpResult {
  /** The HTTP status. */
  readonly status: number;
  /** Whether the status is in the 2xx range. */
  readonly ok: boolean;
  /** The body: parsed JSON, else the first 500 characters of the text. */
  readonly body: unknown;

  /**
   * Where a redirect points, without its query string, which can hold a
   * secret. A redirect is never followed.
   */
  readonly location?: string;
}

// transport: shared word for word across the plugins

/**
 * Sent with every request so that the service can tell who is calling.
 */
const USER_AGENT = 'semantic-release-packagist';

/**
 * The longest a whole call may take, retries and back-off included, unless
 * the call says otherwise.
 */
const DEADLINE_MS = 120_000;

/**
 * The longest a single attempt may wait for the response headers or the body,
 * unless the call says otherwise. An attempt that stalls is abandoned and
 * retried.
 */
const ATTEMPT_TIMEOUT_MS = 30_000;

/**
 * The longest wait between two attempts, which also caps a `Retry-After`
 * header. It is never more than a quarter of the deadline. A wait in progress
 * when the deadline passes is cancelled.
 */
const MAX_BACKOFF_MS = 15_000;

/**
 * Methods that are safe to repeat. A POST is only retried when the call says
 * `retryPost`, because only the caller knows that repeating it is harmless.
 */
const IDEMPOTENT_METHODS = ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE'];

/**
 * The statuses that are worth another attempt: throttling and server errors.
 */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/**
 * How many redirects are followed when the call asks for it.
 */
const MAX_REDIRECTIONS = 3;

/**
 * The most of a response body that is read. Undici stops a larger body, which
 * is then reported as a failure and not repeated.
 */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

/**
 * Failures worth another attempt. Naming them replaces undici's own list, so
 * it is repeated here with the resolver and timeout codes added.
 */
const RETRYABLE_ERROR_CODES = new Set([
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
]);

/**
 * The code of the error that stands for a connection lost after the response
 * headers arrived.
 */
const BODY_PHASE_CODE = 'UND_ERR_BODY_PHASE';

/**
 * A connection that failed while the response body was being read. Undici
 * would resume such a response with a `Range` request, which these APIs
 * ignore; this error is not retried by the retrying agent, so that the whole
 * request is sent again instead.
 */
class BodyPhaseError extends Error {
  readonly code = BODY_PHASE_CODE;

  /**
   * Wraps the error that undici reported for a lost body.
   * @param cause - The error that undici reported.
   * @example
   * throw new BodyPhaseError(new Error('socket hang up'));
   */
  constructor(cause: unknown) {
    super('the connection was lost while reading the response', { cause });
    this.name = 'BodyPhaseError';
  }
}

/**
 * The connections to the service, from the installed `undici` (the runtime's
 * bundled undici cannot be wrapped by `RetryAgent`). They honour the
 * `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` environment variables, which are
 * read when this is called.
 * @param attemptTimeoutMs - How long one attempt may wait for the response.
 * @returns A dispatcher with connection and response timeouts and a cap on
 * the size of a response.
 * @throws SemanticReleaseError when a proxy variable is not a valid proxy.
 * The message names the variables and never their value, which can hold a
 * password.
 * @example
 * const agent = connections(30_000);
 */
function connections(attemptTimeoutMs: number): Dispatcher {
  try {
    return new EnvHttpProxyAgent({
      connect: { timeout: 10_000 },
      headersTimeout: attemptTimeoutMs,
      bodyTimeout: attemptTimeoutMs,
      maxResponseSize: MAX_BODY_BYTES,
      // Measured against a server that advertises a long keep-alive: without
      // this a script that has made one call stays alive for as long as the
      // server's keep-alive (about 3 seconds against Node's own server). A
      // one-shot client has no use for an idle connection.
      keepAliveTimeout: 1,
      keepAliveMaxTimeout: 1,
    });
  } catch {
    throw new SemanticReleaseError(
      'HTTP_PROXY, HTTPS_PROXY or NO_PROXY is not a valid proxy setting.',
      'EPROXY',
    );
  }
}

/**
 * Describe a failed request that got no response. The message names the host
 * and the reason, and never the URL, which can hold a secret.
 * @param error - A caught value.
 * @param host - The host that was called.
 * @returns An error with the reason in its message.
 * @example
 * networkErrorFor(new Error('timeout'), 'packagist.org'); // Network error calling packagist.org: timeout
 */
function networkErrorFor(error: unknown, host: string): Error {
  const reason =
    isRecord(error) && error.cause !== undefined
      ? `${messageOf(error)}: ${messageOf(error.cause)}`
      : messageOf(error);
  return new Error(`Network error calling ${host}: ${reason}`);
}

/**
 * Mark a connection that fails after the response headers arrived, so that
 * the retrying agent leaves it alone (see {@link BodyPhaseError}).
 * @param dispatch - The dispatch function to wrap.
 * @returns A dispatch function that wraps the handler.
 * @example
 * const agent = base.compose(markBodyFailures);
 */
function markBodyFailures(
  dispatch: Dispatcher['dispatch'],
): Dispatcher['dispatch'] {
  return (options, handler) => {
    const started = new AbortController();
    return dispatch(options, {
      onRequestStart: (controller, context) =>
        handler.onRequestStart?.(controller, context),
      onRequestUpgrade: (controller, status, headers, socket) =>
        handler.onRequestUpgrade?.(controller, status, headers, socket),
      onResponseStart: (controller, status, headers, message) => {
        started.abort();
        handler.onResponseStart?.(controller, status, headers, message);
      },
      onResponseData: (controller, chunk) =>
        handler.onResponseData?.(controller, chunk),
      onResponseEnd: (controller, trailers) =>
        handler.onResponseEnd?.(controller, trailers),
      onResponseError: (controller, error) =>
        handler.onResponseError?.(
          controller,
          started.signal.aborted &&
            RETRYABLE_ERROR_CODES.has(codeOf(error) ?? '')
            ? new BodyPhaseError(error)
            : error,
        ),
    });
  };
}

/**
 * Decode a response body.
 * @param text - The body as text.
 * @returns The parsed JSON, undefined for an empty body, else the first 500
 * characters of the text.
 * @example
 * decodeBody('{"ok":true}'); // { ok: true }
 */
function decodeBody(text: string): unknown {
  if (text === '') {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 500);
  }
}

/**
 * Where a redirect points, without the query (which can hold a secret), the
 * fragment or any user info.
 * @param location - The `Location` header.
 * @param base - The URL that was called, for a relative `Location`.
 * @returns A URL that is safe to show, or undefined without a usable header.
 * @example
 * placeOf('/moved?token=x', new URL('https://packagist.org/a')); // 'https://packagist.org/moved'
 */
function placeOf(location: unknown, base: URL): string | undefined {
  if (typeof location !== 'string' || !URL.canParse(location, base.href)) {
    return undefined;
  }
  const target = new URL(location, base.href);
  return `${target.origin}${target.pathname}`;
}

/**
 * Where a redirect may be followed to. Only a GET or HEAD request is
 * followed, and only to the same origin, which rules out a change from https
 * to http and keeps the credentials from leaving for another host.
 * @param from - The URL that was called.
 * @param method - The method of the request.
 * @param status - The status of the response.
 * @param location - The `Location` header.
 * @returns The URL to call next, or undefined when the redirect is not to be
 * followed.
 * @example
 * sameOriginRedirect(new URL('https://a.test/x'), 'GET', 301, '/y'); // https://a.test/y
 */
function sameOriginRedirect(
  from: URL,
  method: string,
  status: number,
  location: unknown,
): URL | undefined {
  if (
    !['GET', 'HEAD'].includes(method) ||
    ![301, 302, 303, 307, 308].includes(status) ||
    typeof location !== 'string' ||
    !URL.canParse(location, from.href)
  ) {
    return undefined;
  }
  const next = new URL(location, from.href);
  return next.origin === from.origin ? next : undefined;
}

/**
 * Whether a failed attempt is worth another one.
 * @param error - The error undici reports for the failed attempt.
 * @param method - The method of the request.
 * @param methods - The methods that may be repeated.
 * @param attempt - Which retry this would be, starting at 1.
 * @param retries - How many retries are allowed.
 * @returns True to try again.
 * @example
 * isRetryable(new Error('x'), 'GET', ['GET'], 1, 2); // true
 */
function isRetryable(
  error: unknown,
  method: string,
  methods: readonly string[],
  attempt: number,
  retries: number,
): boolean {
  if (attempt > retries || !methods.includes(method)) {
    return false;
  }
  const code = codeOf(error);
  if (
    code !== undefined &&
    code !== 'UND_ERR_REQ_RETRY' &&
    !RETRYABLE_ERROR_CODES.has(code)
  ) {
    return false;
  }
  const status = isRecord(error) ? numberAt(error, 'statusCode') : undefined;
  return status === undefined || RETRYABLE_STATUSES.has(status);
}

/**
 * How long to wait before the next attempt: what `Retry-After` asks for, else
 * exponential back-off, never more than `capMs`.
 * @param error - The error undici reports for the failed attempt.
 * @param attempt - Which retry this is, starting at 1.
 * @param minTimeoutMs - The first back-off.
 * @param capMs - The longest wait.
 * @returns The wait in milliseconds.
 * @example
 * waitBeforeRetry(new Error('x'), 2, 500, 15_000); // 1000
 */
function waitBeforeRetry(
  error: unknown,
  attempt: number,
  minTimeoutMs: number,
  capMs: number,
): number {
  const backoffMs = minTimeoutMs * 2 ** (attempt - 1);
  const header =
    isRecord(error) && isRecord(error.headers)
      ? stringAt(error.headers, 'retry-after')
      : undefined;
  if (header === undefined) {
    return Math.min(backoffMs, capMs);
  }
  const seconds = Number(header);
  const advisedMs = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(header) - Date.now();
  if (advisedMs > 0) {
    return Math.min(advisedMs, capMs);
  }
  return Math.min(backoffMs, capMs);
}

/**
 * The HTTP methods that {@link request} can send.
 */
export type HttpMethod = 'GET' | 'HEAD' | 'OPTIONS' | 'PUT' | 'DELETE' | 'POST';

/**
 * What the caller of {@link request} can ask for.
 */
export interface HttpRequest {
  /** The HTTP method. Defaults to `GET`. */
  readonly method?: HttpMethod;
  /** Extra headers, which replace the defaults of the same name in any case. */
  readonly headers?: Readonly<Record<string, string>>;
  /** A text or binary body, which can be sent again if the call is retried. */
  readonly body?: string | Uint8Array;
}

/**
 * How {@link request} treats time and failure.
 */
export interface RequestOptions {
  /** The connections to use; tests pass undici's `MockAgent`. */
  readonly agent?: Dispatcher;
  /** How long one attempt may wait for the headers, then the body. */
  readonly attemptTimeoutMs?: number;
  /** How long the whole call may take, retries and back-off included. */
  readonly deadlineMs?: number;
  /** How many more attempts a retryable request gets. Zero by default. */
  readonly retries?: number;
  /** The first back-off in milliseconds, doubled for each retry. */
  readonly minTimeout?: number;

  /**
   * Allow a POST to be retried. Only for a POST that is safe to repeat, such
   * as the token exchange; an upload or a publish never sets it, and without
   * it a POST gets no retries whatever `retries` says.
   */
  readonly retryPost?: boolean;

  /**
   * Follow the redirects of a GET or HEAD request, up to three, but only to
   * the same origin. Off by default. A redirect that is not followed is
   * returned with its `location`.
   */
  readonly followRedirects?: boolean;
}


/**
 * Perform a request and decode a JSON (or fall back to text) response.
 *
 * When the request may be retried (`retries` above zero, and for a POST only
 * with `retryPost`) it goes through undici's `RetryAgent`, which retries
 * throttling (429), server errors and connection failures with exponential
 * back-off, honouring `Retry-After`; once the attempts run out the last
 * response is returned. If the connection drops while the body is being read,
 * the whole request is sent again, and each such replay gets the retries that
 * are left. Redirects are only followed when `followRedirects` is set, and
 * `Content-Encoding` is not decoded: the endpoints used here do not use it.
 *
 * The call is bounded by `deadlineMs`. When it passes, a wait for the next
 * attempt is cancelled and the connections this call created are destroyed,
 * which also stops a proxy tunnel that is still being set up.
 *
 * Undici's `request` is used rather than `fetch` because `fetch` turns a body
 * into a one-shot stream, which undici cannot send a second time.
 * @param url - Absolute URL to call.
 * @param init - Method, headers and body.
 * @param options - Timeouts, retries and, for tests, the connections.
 * @returns The status and decoded body.
 * @throws When the network call fails after the allowed attempts. The message
 * names the host and never contains the URL, headers or body.
 * @rejects When the network call fails after the allowed attempts. The message
 * names the host and never contains the URL, headers or body.
 * @example
 * const result = await request('https://packagist.org/api/', { method: 'GET' });
 */
export async function request(
  url: string,
  init: HttpRequest,
  options: RequestOptions = {},
): Promise<HttpResult> {
  const {
    attemptTimeoutMs = ATTEMPT_TIMEOUT_MS,
    deadlineMs = DEADLINE_MS,
    minTimeout = 500,
    retryPost = false,
    followRedirects = false,
    agent,
    retries: allowedRetries = 0,
  } = options;
  const target = new URL(url);
  const method = init.method ?? 'GET';
  const retries =
    method === 'POST' && !retryPost ? 0 : Math.max(0, allowedRetries);
  const methods = retryPost
    ? [...IDEMPOTENT_METHODS, 'POST']
    : IDEMPOTENT_METHODS;
  const capMs = Math.min(MAX_BACKOFF_MS, Math.floor(deadlineMs / 4));
  const own = agent === undefined ? connections(attemptTimeoutMs) : undefined;
  const base = agent ?? own;
  const deadline = AbortSignal.timeout(deadlineMs);
  const finished = new AbortController();
  const headers = Object.fromEntries(
    [
      ['accept', 'application/json'],
      ['user-agent', USER_AGENT],
      ...Object.entries(init.headers ?? {}),
    ].map(([name, value]) => [name.toLowerCase(), value]),
  );
  const exchange = async (
    left: number,
    where: URL,
    hops: number,
  ): Promise<HttpResult> => {
    const dispatcher =
      left > 0 && base !== undefined
        ? new RetryAgent(base.compose(markBodyFailures), {
            maxRetries: left,
            throwOnError: false,
            // eslint-disable-next-line promise/prefer-await-to-callbacks -- undici RetryAgent retry option is callback based
            retry: (error, { state, opts }, callback) => {
              // Cancel the wait when the deadline passes, so that it cannot
              // hold the process after the call has given up.
              if (
                !isRetryable(error, opts.method, methods, state.counter, left)
              ) {
                // eslint-disable-next-line promise/prefer-await-to-callbacks -- undici RetryAgent retry callback
                callback(error);
                return;
              }
              const timer = setTimeout(
                callback,
                waitBeforeRetry(error, state.counter, minTimeout, capMs),
                null,
              );
              deadline.addEventListener('abort', () => clearTimeout(timer), {
                once: true,
                signal: finished.signal,
              });
            },
          })
        : base;
    const response = await send(where, {
      dispatcher,
      method,
      headers,
      body: init.body,
      signal: deadline,
    });
    const text = await response.body.text().catch((error: unknown) => {
      if (codeOf(error) === BODY_PHASE_CODE && left > 0) {
        return undefined;
      }
      throw error;
    });
    if (text === undefined) {
      return exchange(left - 1, where, hops);
    }
    const next = followRedirects
      ? sameOriginRedirect(
          where,
          method,
          response.statusCode,
          response.headers.location,
        )
      : undefined;
    if (next !== undefined && hops > 0) {
      return exchange(left, next, hops - 1);
    }
    const location = placeOf(response.headers.location, where);
    return {
      status: response.statusCode,
      ok: response.statusCode >= 200 && response.statusCode < 300,
      body: decodeBody(text),
      ...(location === undefined ? {} : { location }),
    };
  };
  const expired = new Promise<never>((_resolve, reject) =>
    deadline.addEventListener(
      'abort',
      () => {
        // undici does not honour the signal while a proxy tunnel is being
        // set up, so the connections are torn down as well.
        void own?.destroy();
        reject(deadline.reason);
      },
      { once: true, signal: finished.signal },
    ),
  );
  const attempt = exchange(retries, target, MAX_REDIRECTIONS);
  attempt.catch(() => undefined);
  try {
    return await Promise.race([attempt, expired]);
  } catch (error) {
    throw networkErrorFor(error, target.host);
  } finally {
    finished.abort();
    await own?.destroy().catch(() => undefined);
  }
}

/**
 * The endpoint that makes Packagist crawl a repository again.
 */
const UPDATE_PACKAGE_URL = 'https://packagist.org/api/update-package';

/**
 * How many more attempts the update call gets after the first.
 */
const UPDATE_RETRIES = 3;

/**
 * The most of a response body that is repeated in an error message.
 */
const MAX_DETAIL_CHARS = 2000;

/**
 * Options for building a {@link PackagistClient}.
 */
export interface PackagistClientOptions {
  /** The connections to use; tests pass undici's `MockAgent`. */
  readonly agent?: Dispatcher;
}

/**
 * A decoded response body as text, for an error message.
 * @param body - The body, as {@link request} decoded it.
 * @returns The text, or the JSON of a parsed body, or nothing for no body.
 * @example
 * textOf({ error: 'nope' }); // '{"error":"nope"}'
 */
function textOf(body: unknown): string {
  if (typeof body === 'string') {
    return body;
  }
  return body === undefined ? '' : JSON.stringify(body);
}

/**
 * The error that describes a failed call.
 * @param result - What the call came back with, whose body has been scrubbed of
 * secrets.
 * @param repositoryUrl - The repository that was announced.
 * @returns The error to throw.
 * @example
 * errorFor({ status: 404, ok: false, body: undefined }, 'https://github.com/a/b.git');
 */
function errorFor(
  result: HttpResult,
  repositoryUrl: string,
): SemanticReleaseError {
  const phrase = STATUS_CODES[result.status] ?? `HTTP ${result.status}`;
  if (result.status >= 300 && result.status < 400) {
    return new SemanticReleaseError(
      `Failed to notify Packagist: ${phrase}`,
      'EPACKAGISTAPI',
      `The Packagist API answered ${result.status} and sent the request to ${result.location ?? 'no location'}. Redirects are never followed for this call, because a redirect would change the request.`,
    );
  }
  if (result.status === 401 || result.status === 403) {
    return new SemanticReleaseError(
      'Invalid Packagist credentials.',
      'EINVALIDPACKAGISTTOKEN',
      `The Packagist API returned a ${result.status} status. Please check that the configured \`username\` and \`apiToken\` are correct and have permissions to update the package.`,
    );
  }
  if (result.status === 404) {
    return new SemanticReleaseError(
      'Packagist package not found.',
      'EPACKAGISTNOTFOUND',
      `The Packagist API returned a 404 Not Found error. Please check that the package linked to the repository \`${redactUrl(repositoryUrl)}\` exists on Packagist.`,
    );
  }
  return new SemanticReleaseError(
    `Failed to notify Packagist: ${phrase}`,
    'EPACKAGISTAPI',
    `The Packagist API returned an unexpected ${result.status} status. Response: ${truncate(textOf(result.body), MAX_DETAIL_CHARS)}`,
  );
}

/**
 * A client for the Packagist API. The update call is a POST and it is
 * retried, because repeating it is safe: it only asks Packagist to crawl the
 * repository again. A redirect is never followed, because a redirect would
 * turn the POST into another request, and is reported as an error.
 */
export class PackagistClient {
  private readonly credentials: PackagistCredentials;

  private readonly agent: Dispatcher | undefined;

  /**
   * Creates a client that acts as the given Packagist account.
   * @param credentials - The Packagist account to act as.
   * @param options - Test seam for the connections.
   * @example
   * const client = new PackagistClient({ username: 'me', apiToken: 'token' });
   */
  constructor(
    credentials: PackagistCredentials,
    options: PackagistClientOptions = {},
  ) {
    this.credentials = credentials;
    this.agent = options.agent;
  }


  /**
   * Ask Packagist to re-read a repository so that the new release shows up.
   * @param repositoryUrl - The repository that Packagist tracks.
   * @throws SemanticReleaseError when Packagist rejects the credentials, does
   * not know the package, redirects the request, or keeps failing after the
   * retries.
   * @throws When the network fails after the retries. The error names the host
   * and never contains the API token.
   * @rejects SemanticReleaseError when Packagist rejects the credentials, does
   * not know the package, redirects the request, or keeps failing after the
   * retries.
   * @example
   * await client.updatePackage('https://github.com/acme/widget.git');
   */
  async updatePackage(repositoryUrl: string): Promise<void> {
    const url = new URL(UPDATE_PACKAGE_URL);
    url.searchParams.set('username', this.credentials.username);
    url.searchParams.set('apiToken', this.credentials.apiToken);
    const secrets = [
      this.credentials.apiToken,
      ...userInfoSecrets(repositoryUrl),
    ];
    const result = await request(
      url.href,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repository: { url: repositoryUrl } }),
      },
      {
        retries: UPDATE_RETRIES,
        retryPost: true,
        ...(this.agent === undefined ? {} : { agent: this.agent }),
      },
    ).catch((error: unknown): never => {
      throw new Error(redactSecrets(messageOf(error), secrets));
    });
    if (result.ok) {
      return;
    }
    const scrubbed = redactSecrets(textOf(result.body), secrets);
    throw errorFor({ ...result, body: scrubbed }, repositoryUrl);
  }
}
