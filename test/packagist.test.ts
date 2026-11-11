/**
 * Tests for `request` and `PackagistClient.updatePackage`: retries, deadlines,
 * redirects, proxies and the errors they raise, against mocked and local servers.
 * @file
 */
import { afterEach, describe, expect, it } from '@jest/globals';
import { createServer } from 'node:http';
import { inspect } from 'node:util';
import { MockAgent } from 'undici';
import {
  PackagistClient,
  request,
  type RequestOptions,
} from '../src/packagist.js';
import { failHttp, mockAgent, mockHttp } from './utils/http-mock.js';
import { startTunnelProxy } from './utils/proxy.js';
import { listen, startFaultyProxy } from './utils/server.js';

describe('request', () => {
  const GET = 'GET https://x.test/a';
  const URL_A = 'https://x.test/a';
  const via = (extra: RequestOptions = {}): RequestOptions => ({
    agent: mockAgent(),
    minTimeout: 1,
    ...extra,
  });

  it('decodes a JSON body', async () => {
    mockHttp({ [GET]: { json: { ok: 1 } } });
    expect(await request(URL_A, {}, via())).toEqual({
      status: 200,
      ok: true,
      body: { ok: 1 },
    });
  });

  it('falls back to text for a body that is not JSON', async () => {
    mockHttp({ [GET]: { status: 502, text: '<html>bad</html>' } });
    expect(await request(URL_A, {}, via())).toMatchObject({
      status: 502,
      ok: false,
      body: '<html>bad</html>',
    });
  });

  it('returns an undefined body for an empty response', async () => {
    mockHttp({ [GET]: {} });
    const result = await request(URL_A, {}, via());
    expect(result.body).toBeUndefined();
  });

  it('sends the default headers once, whatever the case of an override', async () => {
    const calls = mockHttp({ [GET]: {} });
    await request(
      URL_A,
      { headers: { Accept: 'text/plain', 'X-Extra': '1' } },
      via(),
    );
    expect(calls[0].headers).toEqual({
      accept: 'text/plain',
      'user-agent': 'semantic-release-packagist',
      'x-extra': '1',
    });
  });

  it('retries throttling and server errors when asked to', async () => {
    const calls = mockHttp({
      [GET]: [{ status: 429 }, { status: 503 }, { json: { ok: 1 } }],
    });
    const result = await request(URL_A, {}, via({ retries: 2 }));
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it('returns the last response once the retries are used up', async () => {
    const calls = mockHttp({ [GET]: { status: 503, text: 'down' } });
    const result = await request(URL_A, {}, via({ retries: 2 }));
    expect(result).toMatchObject({ status: 503, ok: false, body: 'down' });
    expect(calls).toHaveLength(3);
  });

  it('retries an idempotent method other than GET', async () => {
    const calls = mockHttp({
      'PUT https://x.test/a': [{ status: 500 }, { json: {} }],
    });
    await request(URL_A, { method: 'PUT' }, via({ retries: 1 }));
    expect(calls).toHaveLength(2);
  });

  it('retries a POST only when retryPost is set, as the token exchange does', async () => {
    const calls = mockHttp({
      'POST https://x.test/a': [{ status: 500 }, { json: { ok: 1 } }],
    });
    const result = await request(
      URL_A,
      { method: 'POST' },
      via({ retries: 1, retryPost: true }),
    );
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('never retries a POST without retryPost, whatever retries says', async () => {
    const calls = mockHttp({ 'POST https://x.test/a': { status: 503 } });
    const result = await request(
      URL_A,
      { method: 'POST' },
      via({ retries: 3 }),
    );
    expect(result.status).toBe(503);
    expect(calls).toHaveLength(1);
  });

  it('does not retry unless asked to', async () => {
    const calls = mockHttp({ [GET]: { status: 503 } });
    const result = await request(URL_A, {}, via());
    expect(result.status).toBe(503);
    expect(calls).toHaveLength(1);
  });

  it('does not retry a client error', async () => {
    const calls = mockHttp({ [GET]: { status: 404 } });
    await request(URL_A, {}, via({ retries: 3 }));
    expect(calls).toHaveLength(1);
  });

  it('retries a dropped connection, then gives up with a message free of secrets', async () => {
    const attempts = failHttp(
      'https://x.test',
      Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    );
    const error = await request(
      'https://x.test/a?token=secret',
      { headers: { Authorization: 'Bearer secret' } },
      via({ retries: 1 }),
    ).catch((error: unknown) => error);
    expect(String(error)).toBe(
      'Error: Network error calling x.test: socket hang up',
    );
    expect(attempts()).toBe(2);
  });

  it('does not retry an error code that is not a connection failure', async () => {
    const attempts = failHttp(
      'https://x.test',
      Object.assign(new Error('denied'), { code: 'EACCES' }),
    );
    await expect(request(URL_A, {}, via({ retries: 2 }))).rejects.toThrow(
      'Network error calling x.test: denied',
    );
    expect(attempts()).toBe(1);
  });

  it('names the code of a failure with an empty message, such as a dual-stack refusal', async () => {
    failHttp(
      'https://x.test',
      // eslint-disable-next-line unicorn/error-message -- the test needs an aggregate error with an empty message
      Object.assign(new AggregateError([new Error('v4'), new Error('v6')]), {
        code: 'ECONNREFUSED',
      }),
    );
    await expect(request(URL_A, {}, via())).rejects.toThrow(
      'Network error calling x.test: ECONNREFUSED',
    );
  });

  it('refuses a malformed proxy setting without printing it', async () => {
    const saved = { ...process.env };
    // eslint-disable-next-line sonarjs/no-clear-text-protocols -- the test uses a malformed proxy setting on purpose
    process.env.HTTPS_PROXY = 'http://user:PW-SECRET@bad host:3128';
    try {
      const error = await request(URL_A, {}).catch((error: unknown) => error);
      expect(error).toMatchObject({ code: 'EPROXY' });
      const shown = [
        String(error),
        inspect(error, { depth: 10, showHidden: true }),
        JSON.stringify(error, Object.getOwnPropertyNames(error)),
        JSON.stringify(Object.entries(error as object)),
      ].join('\n');
      expect(shown).not.toContain('PW-SECRET');
      expect(shown).toContain('HTTPS_PROXY');
    } finally {
      process.env = saved;
    }
  });
});

/**
 * Start a loopback server and register its stop function for the test.
 * @param stops - The stop functions to run after each test.
 * @param handler - Answers each request.
 * @returns The running server.
 * @example
 * const server = await serveOn(stops, (req, res) => res.end('ok'));
 */
async function serveOn(
  stops: (() => Promise<void>)[],
  handler: Parameters<typeof listen>[0],
): ReturnType<typeof listen> {
  const server = await listen(handler);
  stops.push(server.close);
  return server;
}

describe('request over a real socket', () => {
  const stops: (() => Promise<void>)[] = [];
  const saved = { ...process.env };

  afterEach(async () => {
    process.env = { ...saved };
    await Promise.all(stops.splice(0).map((stop) => stop()));
  });

  it('honours Retry-After before retrying', async () => {
    const { url, seen } = await serveOn(stops, (_req, res) => {
      const first = seen.length === 1;
      res.writeHead(first ? 503 : 200, first ? { 'Retry-After': '1' } : {});
      res.end(first ? 'busy' : '{"ok":1}');
    });
    const started = Date.now();
    const result = await request(`${url}/a`, {}, { retries: 1 });
    expect(result).toMatchObject({ status: 200, body: { ok: 1 } });
    expect(seen).toHaveLength(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it('caps a long Retry-After at a quarter of the deadline', async () => {
    const { url, seen } = await serveOn(stops, (_req, res) => {
      const first = seen.length === 1;
      res.writeHead(first ? 429 : 200, first ? { 'Retry-After': '20' } : {});
      res.end('{}');
    });
    const started = Date.now();
    await request(`${url}/a`, {}, { retries: 1, deadlineMs: 4000 });
    const took = Date.now() - started;
    expect(seen).toHaveLength(2);
    expect(took).toBeGreaterThanOrEqual(900);
    expect(took).toBeLessThan(3000);
  });

  it('sends a retried POST body again, intact', async () => {
    const bodies: string[] = [];
    const { url } = await serveOn(stops, (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        bodies.push(Buffer.concat(chunks).toString());
        res.writeHead(bodies.length === 1 ? 503 : 200);
        res.end('{}');
      });
    });
    const result = await request(
      `${url}/token`,
      { method: 'POST', body: 'grant_type=x' },
      { retries: 1, retryPost: true, minTimeout: 1 },
    );
    expect(result.ok).toBe(true);
    expect(bodies).toEqual(['grant_type=x', 'grant_type=x']);
  });

  it('sends an upload body with its content length', async () => {
    const lengths: (string | undefined)[] = [];
    const { url } = await serveOn(stops, (req, res) => {
      lengths.push(req.headers['content-length']);
      req.resume();
      req.on('end', () => res.end('{}'));
    });
    const zip = Buffer.from('zip-bytes');
    await request(`${url}/up`, {
      method: 'POST',
      headers: { 'Content-Length': String(zip.length) },
      body: zip,
    });
    expect(lengths).toEqual(['9']);
  });

  it('retries an attempt that stalls, as a dropped connection is', async () => {
    const { url, seen } = await serveOn(stops, (_req, res) => {
      if (seen.length > 1) {
        res.end('{"ok":1}');
      }
    });
    const result = await request(
      `${url}/a`,
      {},
      { retries: 1, attemptTimeoutMs: 1000, minTimeout: 1 },
    );
    expect(result).toMatchObject({ status: 200, body: { ok: 1 } });
    expect(seen).toHaveLength(2);
  }, 15_000);

  it('gives up with one request per attempt when every attempt stalls', async () => {
    const { url, seen } = await serveOn(stops, () => undefined);
    await expect(
      request(
        `${url}/a`,
        {},
        { retries: 1, attemptTimeoutMs: 1000, minTimeout: 1 },
      ),
    ).rejects.toThrow(/Network error calling 127\.0\.0\.1/);
    expect(seen).toHaveLength(2);
  }, 15_000);
});

describe('request over a real socket, deadlines and bodies', () => {
  const stops: (() => Promise<void>)[] = [];
  const saved = { ...process.env };

  afterEach(async () => {
    process.env = { ...saved };
    await Promise.all(stops.splice(0).map((stop) => stop()));
  });

  it('stops at the deadline, which does not include a back-off when nothing is retried', async () => {
    const { url } = await serveOn(stops, () => undefined);
    const started = Date.now();
    await expect(request(`${url}/a`, {}, { deadlineMs: 1000 })).rejects.toThrow(
      /aborted due to timeout/,
    );
    expect(Date.now() - started).toBeLessThan(2000);
  }, 15_000);

  it('sends exactly retries + 1 whole requests when the body is always cut short', async () => {
    const { url, seen } = await serveOn(stops, (_req, res) => {
      res.writeHead(200, { 'Content-Length': '100' });
      res.write('{"par');
      setTimeout(() => res.socket?.destroy(), 10);
    });
    await expect(
      request(
        `${url}/a`,
        { method: 'POST', body: 'a=1' },
        { retries: 2, retryPost: true, minTimeout: 1 },
      ),
    ).rejects.toThrow(/other side closed/);
    expect(seen).toEqual(['POST /a', 'POST /a', 'POST /a']);
  }, 15_000);

  it('sends the whole request again, never a Range resume, when the body is cut once', async () => {
    const { url, seen } = await serveOn(stops, (_req, res) => {
      if (seen.length === 1) {
        res.writeHead(200, { 'Content-Length': '100' });
        res.write('{"par');
        setTimeout(() => res.socket?.destroy(), 10);
        return;
      }
      res.end('{"ok":1}');
    });
    const result = await request(
      `${url}/a`,
      { method: 'POST', body: 'a=1' },
      { retries: 2, retryPost: true, minTimeout: 1 },
    );
    expect(result).toMatchObject({ status: 200, body: { ok: 1 } });
    expect(seen).toEqual(['POST /a', 'POST /a']);
  });

  it('reports a body that is cut short when the request may not be retried', async () => {
    const { url, seen } = await serveOn(stops, (_req, res) => {
      res.writeHead(200, { 'Content-Length': '100' });
      res.write('{"par');
      setTimeout(() => res.socket?.destroy(), 10);
    });
    await expect(
      request(`${url}/a`, { method: 'POST', body: 'a=1' }, { retries: 3 }),
    ).rejects.toThrow(/Network error calling 127\.0\.0\.1/);
    expect(seen).toHaveLength(1);
  });

  it('does not read, or repeat a request for, a body larger than the cap', async () => {
    const { url, seen } = await serveOn(stops, (_req, res) => {
      res.writeHead(200);
      res.end(Buffer.alloc(33 * 1024 * 1024, 97));
    });
    await expect(
      request(`${url}/a`, {}, { retries: 2, minTimeout: 1 }),
    ).rejects.toThrow(/Network error calling 127\.0\.0\.1/);
    expect(seen).toHaveLength(1);
  });

  it('never follows a redirect and reports where it pointed, without the query', async () => {
    const { url, seen } = await serveOn(stops, (_req, res) => {
      res.writeHead(302, { Location: '/elsewhere?token=SECRET' });
      res.end();
    });
    const result = await request(`${url}/a`, {
      method: 'POST',
      body: 'a=1',
    });
    expect(result).toMatchObject({
      status: 302,
      ok: false,
      location: `${url}/elsewhere`,
    });
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(seen).toEqual(['POST /a']);
  });

  it('names the code when a closed local port refuses the connection, without leaking the URL', async () => {
    const server = await listen(() => undefined);
    await server.close();
    const error = await request(
      `http://localhost:${server.port}/a?token=SECRET`,
      { headers: { Authorization: 'Bearer SECRET' } },
    ).catch((error: unknown) => error);
    expect(String(error)).toContain('ECONNREFUSED');
    expect(String(error)).not.toContain('SECRET');
  });

  it('goes through the proxy named by the environment', async () => {
    const target = await serveOn(stops, (_req, res) => res.end('{"direct":1}'));
    const proxy = await startTunnelProxy(target.port);
    stops.push(proxy.close);
    process.env.HTTP_PROXY = proxy.url;
    process.env.NO_PROXY = '';
    delete process.env.http_proxy;
    delete process.env.no_proxy;
    // eslint-disable-next-line sonarjs/no-clear-text-protocols, unicorn/prefer-https -- the test exercises a plain http request that bypasses the proxy
    const result = await request('http://something.invalid/a', {});
    expect(result.body).toEqual({ direct: 1 });
    expect(proxy.tunnelled).toEqual(['something.invalid:80']);
  });

  it('skips the proxy for hosts listed in NO_PROXY', async () => {
    const target = await serveOn(stops, (_req, res) => res.end('{"direct":1}'));
    const proxy = await startTunnelProxy(target.port);
    stops.push(proxy.close);
    process.env.HTTP_PROXY = proxy.url;
    process.env.NO_PROXY = '127.0.0.1';
    delete process.env.http_proxy;
    delete process.env.no_proxy;
    const result = await request(`${target.url}/a`, {});
    expect(result.body).toEqual({ direct: 1 });
    expect(proxy.tunnelled).toHaveLength(0);
  });

  it.each(['reset', 'stall'] as const)(
    'gives up at the deadline when the proxy accepts CONNECT and then %ss, and stays idle',
    async (mode) => {
      const proxy = await startFaultyProxy(mode);
      stops.push(proxy.close);
      process.env.HTTP_PROXY = proxy.url;
      process.env.NO_PROXY = '';
      delete process.env.http_proxy;
      delete process.env.no_proxy;
      const started = Date.now();
      await expect(
        request(
          // eslint-disable-next-line sonarjs/no-clear-text-protocols, unicorn/prefer-https -- the test exercises a plain http request that bypasses the proxy
          'http://something.invalid/a',
          {},
          { retries: 1, deadlineMs: 1500, minTimeout: 1 },
        ),
      ).rejects.toThrow(/Network error calling something\.invalid/);
      expect(Date.now() - started).toBeLessThan(4000);
      const connects = proxy.connects();
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(proxy.connects()).toBe(connects);
    },
    15_000,
  );
});

const CREDENTIALS = { username: 'test-user', apiToken: 'SECRET-TOKEN' };
const REPOSITORY = 'https://github.com/test-user/test-repo.git';
const UPDATE = 'POST https://packagist.org/api/update-package';

/**
 * A client for the test credentials, talking to the mock agent.
 * @param credentials - The Packagist account to act as.
 * @returns A client whose calls are mocked.
 * @example
 * const client = make();
 */
const make = (credentials = CREDENTIALS): PackagistClient =>
  new PackagistClient(credentials, { agent: mockAgent() });

/**
 * The error that an update call rejects with.
 * @param client - The client to call.
 * @param url - The repository to announce.
 * @returns The error it rejected with, or undefined when it resolved.
 * @example
 * const error = await failure(make());
 */
async function failure(
  client: PackagistClient,
  url = REPOSITORY,
): Promise<unknown> {
  try {
    await client.updatePackage(url);
    return undefined;
  } catch (error: unknown) {
    return error;
  }
}

describe('PackagistClient.updatePackage', () => {
  it('posts the repository with the credentials in the query', async () => {
    const calls = mockHttp({ [UPDATE]: { status: 202, json: {} } });
    await expect(make().updatePackage(REPOSITORY)).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    const sent = new URL(calls[0].url);
    expect(Object.fromEntries(sent.searchParams)).toStrictEqual({
      username: 'test-user',
      apiToken: 'SECRET-TOKEN',
    });
    expect(calls[0].body).toStrictEqual({ repository: { url: REPOSITORY } });
    expect(calls[0].headers).toMatchObject({
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': 'semantic-release-packagist',
    });
  });

  it.each([
    ['us er', 'tok/+=%?#é'],
    ['us&er=1', 'a b&c'],
  ])('encodes %s and %s in the query', async (username, apiToken) => {
    const calls = mockHttp({ [UPDATE]: {} });
    await make({ username, apiToken }).updatePackage(REPOSITORY);
    const sent = new URL(calls[0].url).searchParams;
    expect(Object.fromEntries(sent)).toStrictEqual({ username, apiToken });
    expect(calls[0].url).not.toMatch(/[ #é]/);
  });

  it.each([401, 403])(
    'maps %s to an invalid credentials error',
    async (status) => {
      mockHttp({ [UPDATE]: { status } });
      expect(await failure(make())).toMatchObject({
        code: 'EINVALIDPACKAGISTTOKEN',
        message: 'Invalid Packagist credentials.',
        details: expect.stringContaining(`returned a ${status} status`),
      });
    },
  );

  it('maps 404 to a package not found error naming the repository', async () => {
    mockHttp({ [UPDATE]: { status: 404 } });
    expect(await failure(make())).toMatchObject({
      code: 'EPACKAGISTNOTFOUND',
      message: 'Packagist package not found.',
      details: expect.stringContaining(REPOSITORY),
    });
  });

  it('maps any other status to an API error with the response body', async () => {
    mockHttp({ [UPDATE]: { status: 418, text: 'teapot body' } });
    expect(await failure(make())).toMatchObject({
      code: 'EPACKAGISTAPI',
      message: "Failed to notify Packagist: I'm a Teapot",
      details:
        'The Packagist API returned an unexpected 418 status. Response: teapot body',
    });
  });

  it('shows a JSON error body as text and cuts a long one', async () => {
    mockHttp({ [UPDATE]: { status: 400, json: { error: 'x'.repeat(5000) } } });
    const error = await failure(make());
    expect(error).toMatchObject({ code: 'EPACKAGISTAPI' });
    expect(JSON.stringify(error)).toContain('(truncated)');
    expect(JSON.stringify(error).length).toBeLessThan(2600);
  });

  it.each([
    [522, 'HTTP 522'],
    [599, 'HTTP 599'],
  ])('names a status that has no standard phrase: %s', async (status, text) => {
    mockHttp({ [UPDATE]: { status } });
    expect(await failure(make())).toMatchObject({
      message: `Failed to notify Packagist: ${text}`,
    });
  });

  it('has no body to show for an error without one', async () => {
    mockHttp({ [UPDATE]: { status: 500 } });
    const calls = await failure(make({ ...CREDENTIALS }));
    expect(calls).toMatchObject({
      details:
        'The Packagist API returned an unexpected 500 status. Response: ',
    });
  }, 15_000);

  it('retries a server error and then succeeds', async () => {
    const calls = mockHttp({ [UPDATE]: [{ status: 503 }, { status: 200 }] });
    await expect(make().updatePackage(REPOSITORY)).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
    expect(calls[1].body).toStrictEqual(calls[0].body);
  });

  it('gives up after three retries and reports the last response', async () => {
    const calls = mockHttp({ [UPDATE]: { status: 429, text: 'slow' } });
    expect(await failure(make())).toMatchObject({
      code: 'EPACKAGISTAPI',
      details:
        'The Packagist API returned an unexpected 429 status. Response: slow',
    });
    expect(calls).toHaveLength(4);
  }, 15_000);
});

describe('PackagistClient.updatePackage failures', () => {
  it('does not retry a rejection of the credentials', async () => {
    const calls = mockHttp({ [UPDATE]: { status: 401 } });
    await failure(make());
    expect(calls).toHaveLength(1);
  });

  it.each([301, 302, 303, 307, 308])(
    'does not follow a %s and reports where it pointed, without the query',
    async (status) => {
      const calls = mockHttp({
        [UPDATE]: {
          status,
          headers: {
            location: '/moved/update-package?apiToken=SECRET-TOKEN#f',
          },
        },
      });
      const error = await failure(make());
      expect(error).toMatchObject({
        code: 'EPACKAGISTAPI',
        details: expect.stringContaining(
          `answered ${status} and sent the request to https://packagist.org/moved/update-package.`,
        ),
      });
      expect(JSON.stringify(error)).not.toContain('SECRET-TOKEN');
      expect(calls).toHaveLength(1);
    },
  );

  it('does not follow a redirect to another origin or to http', async () => {
    const calls = mockHttp({
      [UPDATE]: {
        status: 308,
        // eslint-disable-next-line unicorn/prefer-https -- the test checks that a redirect to http is refused
        headers: { location: 'http://other.test/x?a=1' },
      },
    });
    expect(await failure(make())).toMatchObject({
      details: expect.stringContaining(
        // eslint-disable-next-line unicorn/prefer-https -- the test checks that a redirect to http is refused
        'sent the request to http://other.test/x.',
      ),
    });
    expect(calls).toHaveLength(1);
  });

  it('reports a redirect without a location', async () => {
    mockHttp({ [UPDATE]: { status: 302 } });
    expect(await failure(make())).toMatchObject({
      details: expect.stringContaining('sent the request to no location.'),
    });
  });

  it('names the host and the reason of a connection that keeps dropping', async () => {
    const attempts = failHttp(
      'https://packagist.org',
      Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
    );
    expect(String(await failure(make()))).toBe(
      'Error: Network error calling packagist.org: reset',
    );
    expect(attempts()).toBe(4);
  }, 15_000);

  it.each([
    ['as it is', 'tok/+= é'],
    ['percent-encoded', encodeURIComponent('tok/+= é')],
    [
      'form-encoded',
      new URLSearchParams({ t: 'tok/+= é' }).toString().slice(2),
    ],
  ])(
    'keeps a token with odd characters out of an error body, %s',
    async (_form, echoed) => {
      mockHttp({
        [UPDATE]: { status: 400, text: `bad ?apiToken=${echoed}&x` },
      });
      const error = await failure(
        make({ username: 'u', apiToken: 'tok/+= é' }),
      );
      expect(String(JSON.stringify(error))).toContain('[redacted]');
      expect(JSON.stringify(error)).not.toContain(echoed);
    },
  );

  it('keeps the token out of a network error that quotes it', async () => {
    failHttp(
      'https://packagist.org',
      Object.assign(new Error('failed for ?apiToken=SECRET-TOKEN'), {
        code: 'EOTHER',
      }),
    );
    const error = await failure(make());
    expect(String(error)).toContain('[redacted]');
    expect(String(error)).not.toContain('SECRET-TOKEN');
  });

  it('keeps the credentials of the repository URL out of a response that echoes it', async () => {
    mockHttp({
      [UPDATE]: {
        status: 400,
        text: 'invalid repository https://user:repopass@github.com/o/r.git',
      },
    });
    const error = await failure(
      make(),
      'https://user:repopass@github.com/o/r.git',
    );
    expect(JSON.stringify(error)).not.toContain('repopass');
    expect(JSON.stringify(error)).toContain('[redacted]');
  });

  it('leaves credentials out of the repository URL in a not found error', async () => {
    mockHttp({ [UPDATE]: { status: 404 } });
    const error = await failure(
      make(),
      'https://user:s3cret@github.com/o/r.git',
    );
    expect(JSON.stringify(error)).not.toContain('s3cret');
    expect(JSON.stringify(error)).toContain('https://github.com/o/r.git');
  });
});

describe('request and idle connections', () => {
  it('closes its connection at once, even when the server advertises a long keep-alive', async () => {
    const server = createServer((_req, res) => res.end('{}'));
    server.keepAliveTimeout = 60_000;
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      await request(`http://127.0.0.1:${port}/a`, {});
      const open = async (tries: number): Promise<number> => {
        const count = await new Promise<number>((resolve) =>
          server.getConnections((_error, n) => resolve(n)),
        );
        if (count === 0 || tries === 0) {
          return count;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
        return open(tries - 1);
      };
      expect(await open(20)).toBe(0);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

describe('request Retry-After forms', () => {
  it.each([
    ['zero', '0'],
    ['a date in the past', 'Wed, 21 Oct 2015 07:28:00 GMT'],
    ['text that is neither', 'soon'],
  ])('falls back to the back-off for %s', async (_name, header) => {
    const server = await listen((_req, res) => {
      res.writeHead(503, { 'Retry-After': header });
      res.end('busy');
    });
    try {
      const started = Date.now();
      const result = await request(
        `${server.url}/a`,
        {},
        { retries: 1, minTimeout: 1 },
      );
      expect(result.status).toBe(503);
      expect(server.seen).toHaveLength(2);
      expect(Date.now() - started).toBeLessThan(900);
    } finally {
      await server.close();
    }
  });

  it('waits for a date in the future', async () => {
    const server = await listen((_req, res) => {
      const first = server.seen.length === 1;
      res.writeHead(
        first ? 503 : 200,
        first
          ? { 'Retry-After': new Date(Date.now() + 1500).toUTCString() }
          : {},
      );
      res.end('{}');
    });
    try {
      const started = Date.now();
      const result = await request(`${server.url}/a`, {}, { retries: 1 });
      expect(result.ok).toBe(true);
      expect(Date.now() - started).toBeGreaterThanOrEqual(400);
    } finally {
      await server.close();
    }
  });
});

describe('request redirects, when asked to follow them', () => {
  const stops: (() => Promise<void>)[] = [];

  afterEach(async () => {
    await Promise.all(stops.splice(0).map((stop) => stop()));
  });

  describe('redirects', () => {
    it('are followed on the same origin when asked for, credentials included', async () => {
      const headers: unknown[] = [];
      const { url, seen } = await serveOn(stops, (req, res) => {
        headers.push(req.headers['authorization']);
        if (seen.length === 1) {
          res.writeHead(301, { Location: '/b?x=1' }).end();
          return;
        }
        res.end('{"ok":1}');
      });

      const result = await request(
        `${url}/a`,
        { headers: { Authorization: 'Bearer T' } },
        { followRedirects: true },
      );

      expect(result).toMatchObject({ status: 200, body: { ok: 1 } });
      expect(seen).toEqual(['GET /a', 'GET /b?x=1']);
      expect(headers).toEqual(['Bearer T', 'Bearer T']);
    });

    it('are not followed to another origin, so the credentials stay put', async () => {
      const other = await serveOn(stops, (_req, res) => res.end('{"leak":1}'));
      const { url } = await serveOn(stops, (_req, res) => {
        res.writeHead(302, { Location: `${other.url}/x?token=SECRET` }).end();
      });

      const result = await request(
        `${url}/a`,
        { headers: { Authorization: 'Bearer T' } },
        { followRedirects: true },
      );

      expect(result).toMatchObject({
        status: 302,
        location: `${other.url}/x`,
      });
      expect(other.seen).toHaveLength(0);
    });

    it('are not followed from https to http', async () => {
      const agent = new MockAgent();
      agent.disableNetConnect();
      agent
        .get('https://x.test')
        .intercept({ path: '/a', method: 'GET' })
        // eslint-disable-next-line unicorn/prefer-https -- the fixture redirect stays on http on purpose
        .reply(301, '', { headers: { location: 'http://x.test/b?access=1' } });

      const result = await request(
        'https://x.test/a',
        {},
        { agent, followRedirects: true },
      );

      expect(result).toMatchObject({
        status: 301,
        // eslint-disable-next-line unicorn/prefer-https -- the fixture redirect stays on http on purpose
        location: 'http://x.test/b',
      });
    });

    it('stop after three hops and report the last redirect', async () => {
      const { url, seen } = await serveOn(stops, (_req, res) => {
        res.writeHead(301, { Location: '/again' }).end();
      });

      const result = await request(`${url}/a`, {}, { followRedirects: true });

      expect(result).toMatchObject({ status: 301, location: `${url}/again` });
      expect(seen).toHaveLength(4);
    });

    it('are not followed for a POST', async () => {
      const { url, seen } = await serveOn(stops, (_req, res) => {
        res.writeHead(307, { Location: '/b' }).end();
      });

      const result = await request(
        `${url}/a`,
        { method: 'POST', body: 'a=1' },
        { followRedirects: true },
      );

      expect(result.status).toBe(307);
      expect(seen).toEqual(['POST /a']);
    });

    it('are not followed without a usable location', async () => {
      const { url, seen } = await serveOn(stops, (_req, res) => {
        res.writeHead(302).end();
      });

      const result = await request(`${url}/a`, {}, { followRedirects: true });

      expect(result).toMatchObject({ status: 302 });
      expect(result.location).toBeUndefined();
      expect(seen).toHaveLength(1);
    });
  });
});
