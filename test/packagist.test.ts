import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { MockAgent } from 'undici';
import { PackagistClient } from '../src/packagist.js';
import { startTunnelProxy } from './utils/proxy.js';
import { startLoopback, type Loopback } from './utils/server.js';

const CREDENTIALS = { username: 'test-user', apiToken: 'SECRET-TOKEN' };
const REPOSITORY = 'https://github.com/test-user/test-repo.git';
const UPDATE = { path: /^\/api\/update-package\?/, method: 'POST' } as const;

/**
 * A client that talks to an in-memory Packagist, backing off for 1ms.
 */
function withMock(): {
  client: PackagistClient;
  packagist: ReturnType<MockAgent['get']>;
} {
  const agent = new MockAgent();
  agent.disableNetConnect();
  return {
    client: new PackagistClient(CREDENTIALS, { agent, minTimeout: 1 }),
    packagist: agent.get('https://packagist.org'),
  };
}

describe('PackagistClient.updatePackage', () => {
  it('posts the repository with the credentials in the query', async () => {
    const { client, packagist } = withMock();
    packagist
      .intercept({
        ...UPDATE,
        query: { username: 'test-user', apiToken: 'SECRET-TOKEN' },
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repository: { url: REPOSITORY } }),
      })
      .reply(202, '{}');
    await expect(client.updatePackage(REPOSITORY)).resolves.toBeUndefined();
  });

  it.each([401, 403])(
    'maps %s to an invalid credentials error',
    async (status) => {
      const { client, packagist } = withMock();
      packagist.intercept(UPDATE).reply(status, 'nope').times(1);
      await expect(client.updatePackage(REPOSITORY)).rejects.toMatchObject({
        code: 'EINVALIDPACKAGISTTOKEN',
        message: 'Invalid Packagist credentials.',
        details: expect.stringContaining(`returned a ${status} status`),
      });
    },
  );

  it('maps 404 to a package not found error naming the repository', async () => {
    const { client, packagist } = withMock();
    packagist.intercept(UPDATE).reply(404, '').times(1);
    await expect(client.updatePackage(REPOSITORY)).rejects.toMatchObject({
      code: 'EPACKAGISTNOTFOUND',
      message: 'Packagist package not found.',
      details: expect.stringContaining(REPOSITORY),
    });
  });

  it('maps any other status to an API error with the response body', async () => {
    const { client, packagist } = withMock();
    packagist.intercept(UPDATE).reply(418, 'teapot body').times(1);
    await expect(client.updatePackage(REPOSITORY)).rejects.toMatchObject({
      code: 'EPACKAGISTAPI',
      message: "Failed to notify Packagist: I'm a Teapot",
      details:
        'The Packagist API returned an unexpected 418 status. Response: teapot body',
    });
  });

  it('retries a server error and then succeeds', async () => {
    const { client, packagist } = withMock();
    packagist.intercept(UPDATE).reply(503, 'busy');
    packagist.intercept(UPDATE).reply(200, '{}');
    await expect(client.updatePackage(REPOSITORY)).resolves.toBeUndefined();
  });

  it('retries throttling and then succeeds', async () => {
    const { client, packagist } = withMock();
    packagist.intercept(UPDATE).reply(429, 'slow down');
    packagist.intercept(UPDATE).reply(200, '{}');
    await expect(client.updatePackage(REPOSITORY)).resolves.toBeUndefined();
  });

  it('retries a dropped connection and then succeeds', async () => {
    const { client, packagist } = withMock();
    packagist
      .intercept(UPDATE)
      .replyWithError(
        Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
      );
    packagist.intercept(UPDATE).reply(200, '{}');
    await expect(client.updatePackage(REPOSITORY)).resolves.toBeUndefined();
  });

  it.each([503, 429])(
    'reports a %s that outlasts the retries',
    async (status) => {
      const { client, packagist } = withMock();
      packagist.intercept(UPDATE).reply(status, 'busy').times(4);
      await expect(client.updatePackage(REPOSITORY)).rejects.toMatchObject({
        code: 'EPACKAGISTAPI',
        details: `The Packagist API returned an unexpected ${status} status. Response: busy`,
      });
    },
  );

  it('reports a connection that keeps dropping with its reason', async () => {
    const { client, packagist } = withMock();
    packagist
      .intercept(UPDATE)
      .replyWithError(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))
      .times(4);
    const failure = await client
      .updatePackage(REPOSITORY)
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain('reset');
  });

  it('includes the cause of a failure that has one', async () => {
    const { client, packagist } = withMock();
    packagist
      .intercept(UPDATE)
      .replyWithError(
        Object.assign(
          new TypeError('request failed', {
            cause: new Error('socket hang up'),
          }),
          { code: 'EOTHER' },
        ),
      )
      .times(1);
    await expect(client.updatePackage(REPOSITORY)).rejects.toThrow(
      'request failed: socket hang up',
    );
  });
});

describe('PackagistClient.updatePackage against a real server', () => {
  const started: Loopback[] = [];
  afterEach(async () => {
    await Promise.all(started.splice(0).map((server) => server.close()));
  });

  /**
   * Start a loopback server and a client pointed at it.
   */
  async function serve(
    respond: Parameters<typeof startLoopback>[0],
    options: ConstructorParameters<typeof PackagistClient>[1] = {},
  ): Promise<{ client: PackagistClient; server: Loopback }> {
    const server = await startLoopback(respond);
    started.push(server);
    return {
      server,
      client: new PackagistClient(CREDENTIALS, {
        endpoint: server.url,
        minTimeout: 1,
        ...options,
      }),
    };
  }

  it('sends the same request body on every attempt', async () => {
    const { client, server } = await serve((attempt, response) => {
      response.statusCode = attempt === 1 ? 503 : 200;
      response.end('{}');
    });
    await client.updatePackage(REPOSITORY);
    const body = JSON.stringify({ repository: { url: REPOSITORY } });
    expect(server.seen.map((s) => [s.method, s.body])).toStrictEqual([
      ['POST', body],
      ['POST', body],
    ]);
    expect(server.seen[0]?.url).toBe(
      '/api/update-package?username=test-user&apiToken=SECRET-TOKEN',
    );
  });

  it('retries a 503 and then succeeds', async () => {
    const { client, server } = await serve((attempt, response) => {
      response.statusCode = attempt === 1 ? 503 : 200;
      response.end('{}');
    });
    await expect(client.updatePackage(REPOSITORY)).resolves.toBeUndefined();
    expect(server.seen).toHaveLength(2);
  });

  it('retries a reset connection and then succeeds', async () => {
    const { client, server } = await serve((attempt, response) => {
      if (attempt === 1) {
        response.destroy();
        return;
      }
      response.end('{}');
    });
    await expect(client.updatePackage(REPOSITORY)).resolves.toBeUndefined();
    expect(server.seen).toHaveLength(2);
  });

  it('waits for Retry-After when throttled', async () => {
    const { client, server } = await serve((attempt, response) => {
      if (attempt === 1) {
        response.statusCode = 429;
        response.setHeader('retry-after', '1');
      }
      response.end('{}');
    });
    const startedAt = Date.now();
    await client.updatePackage(REPOSITORY);
    expect(server.seen).toHaveLength(2);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
  });

  it.each([
    [401, 'EINVALIDPACKAGISTTOKEN'],
    [404, 'EPACKAGISTNOTFOUND'],
  ])('does not retry a %s', async (status, code) => {
    const { client, server } = await serve((_attempt, response) => {
      response.statusCode = status;
      response.end('');
    });
    await expect(client.updatePackage(REPOSITORY)).rejects.toMatchObject({
      code,
    });
    expect(server.seen).toHaveLength(1);
  });

  it('reports the last response when the retries run out', async () => {
    const { client, server } = await serve((_attempt, response) => {
      response.statusCode = 503;
      response.end('still busy');
    });
    await expect(client.updatePackage(REPOSITORY)).rejects.toMatchObject({
      code: 'EPACKAGISTAPI',
      details:
        'The Packagist API returned an unexpected 503 status. Response: still busy',
    });
    expect(server.seen).toHaveLength(4);
  });

  it('identifies itself and asks for JSON', async () => {
    const { client, server } = await serve((_attempt, response) => {
      response.end('{}');
    });
    await client.updatePackage(REPOSITORY);
    expect(server.seen[0]?.headers).toMatchObject({
      'user-agent': 'semantic-release-packagist',
      accept: 'application/json',
      'content-type': 'application/json',
    });
  });

  it('treats a success whose connection drops after the headers as a success', async () => {
    const { client, server } = await serve((_attempt, response) => {
      response.writeHead(200, { 'content-length': '100', etag: '"x"' });
      response.write('{"status":');
      setTimeout(() => response.socket?.destroy(), 20);
    });
    await expect(client.updatePackage(REPOSITORY)).resolves.toBeUndefined();
    expect(server.seen).toHaveLength(1);
    expect(server.seen[0]?.headers.range).toBeUndefined();
  });

  it('still reports the status when the body of an error is cut short', async () => {
    const { client } = await serve((_attempt, response) => {
      response.writeHead(418, { 'content-length': '100', etag: '"x"' });
      response.write('teapot');
      setTimeout(() => response.socket?.destroy(), 20);
    });
    await expect(client.updatePackage(REPOSITORY)).rejects.toMatchObject({
      code: 'EPACKAGISTAPI',
      message: "Failed to notify Packagist: I'm a Teapot",
    });
  });

  it('abandons an attempt that stalls and sends the request again', async () => {
    const { client, server } = await serve(
      (attempt, response) => {
        if (attempt > 1) {
          response.end('{}');
        }
      },
      { attemptTimeoutMs: 50 },
    );
    await expect(client.updatePackage(REPOSITORY)).resolves.toBeUndefined();
    expect(server.seen).toHaveLength(2);
  });

  it('caps a long Retry-After by the time budget', async () => {
    const { client, server } = await serve(
      (_attempt, response) => {
        response.statusCode = 503;
        response.setHeader('retry-after', '60');
        response.end('busy');
      },
      { deadlineMs: 400 },
    );
    const startedAt = Date.now();
    await expect(client.updatePackage(REPOSITORY)).rejects.toMatchObject({
      code: 'EPACKAGISTAPI',
    });
    expect(Date.now() - startedAt).toBeLessThan(1500);
    expect(server.seen).toHaveLength(4);
  });

  it('follows a redirect and sends the body again', async () => {
    const { client, server } = await serve((attempt, response) => {
      if (attempt === 1) {
        response.statusCode = 307;
        response.setHeader('location', '/moved/update-package');
      }
      response.end('{}');
    });
    await expect(client.updatePackage(REPOSITORY)).resolves.toBeUndefined();
    const body = JSON.stringify({ repository: { url: REPOSITORY } });
    expect(
      server.seen.map((s) => [s.method, s.url?.split('?')[0], s.body]),
    ).toStrictEqual([
      ['POST', '/api/update-package', body],
      ['POST', '/moved/update-package', body],
    ]);
  });

  it('reports a refused connection by its code, without the token', async () => {
    const { server } = await serve((_attempt, response) => {
      response.end('{}');
    });
    const port = Number(new URL(server.url).port);
    await server.close();
    const client = new PackagistClient(CREDENTIALS, {
      endpoint: `http://localhost:${port}/api/update-package`,
      minTimeout: 1,
    });
    const failure = await client
      .updatePackage(REPOSITORY)
      .catch((e: unknown) => e);
    expect(String(failure)).toMatch(/ECONNREFUSED/);
    expect(String(failure)).not.toContain('SECRET-TOKEN');
  });

  it('keeps the token out of every error, even when the server echoes the URL', async () => {
    const echo = await serve((_attempt, response) => {
      response.statusCode = 418;
      response.end('bad request ?apiToken=SECRET-TOKEN&x');
    });
    const failure = await echo.client
      .updatePackage(REPOSITORY)
      .catch((e: unknown) => e);
    expect(failure).toMatchObject({ code: 'EPACKAGISTAPI' });
    expect(JSON.stringify(failure) + String(failure)).not.toContain(
      'SECRET-TOKEN',
    );
    expect(JSON.stringify(failure)).toContain('[redacted]');
  });

  it('keeps the token out of a network error that quotes it', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    agent
      .get('https://packagist.org')
      .intercept(UPDATE)
      .replyWithError(
        Object.assign(new Error('failed for ?apiToken=SECRET-TOKEN'), {
          code: 'EOTHER',
        }),
      );
    const client = new PackagistClient(CREDENTIALS, { agent });
    const failure = await client
      .updatePackage(REPOSITORY)
      .catch((e: unknown) => e);
    expect(String(failure)).toContain('[redacted]');
    expect(String(failure)).not.toContain('SECRET-TOKEN');
  });

  it.each([
    ['us er', 'tok/+=%?#é'],
    ['us&er=1', 'a b&c'],
  ])('encodes %s and %s in the query', async (username, apiToken) => {
    const server = await startLoopback((_attempt, response) => {
      response.end('{}');
    });
    started.push(server);
    const client = new PackagistClient(
      { username, apiToken },
      { endpoint: server.url },
    );
    await client.updatePackage(REPOSITORY);
    const sent = new URL(`http://x${server.seen[0]?.url}`).searchParams;
    expect(Object.fromEntries(sent)).toStrictEqual({ username, apiToken });
    expect(server.seen[0]?.url).not.toMatch(/[ #é]/);
  });

  it('reads at most a bounded part of a large error body and shortens the details', async () => {
    const { client } = await serve((_attempt, response) => {
      response.statusCode = 418;
      response.end('x'.repeat(5 * 1024 * 1024));
    });
    const failure = await client
      .updatePackage(REPOSITORY)
      .catch((e: unknown) => e);
    expect(failure).toMatchObject({
      code: 'EPACKAGISTAPI',
      details: expect.stringContaining('(truncated)'),
    });
    expect(JSON.stringify(failure).length).toBeLessThan(5000);
  });

  it('does not read the body of a success', async () => {
    const { client } = await serve((_attempt, response) => {
      response.end('x'.repeat(50 * 1024 * 1024));
    });
    const startedAt = Date.now();
    await expect(client.updatePackage(REPOSITORY)).resolves.toBeUndefined();
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  it('leaves credentials out of the repository URL in a not found error', async () => {
    const { client } = await serve((_attempt, response) => {
      response.statusCode = 404;
      response.end('');
    });
    const failure = await client
      .updatePackage('https://user:s3cret@github.com/o/r.git')
      .catch((e: unknown) => e);
    expect(JSON.stringify(failure)).not.toContain('s3cret');
    expect(JSON.stringify(failure)).toContain('https://github.com/o/r.git');
  });

  it('goes through the proxy named by HTTP_PROXY', async () => {
    const { server } = await serve((_attempt, response) => {
      response.end('{}');
    });
    const proxy = await startTunnelProxy(Number(new URL(server.url).port));
    const { http_proxy, https_proxy, ...rest } = process.env;
    void http_proxy;
    void https_proxy;
    jest.replaceProperty(process, 'env', {
      ...rest,
      HTTP_PROXY: proxy.url,
      NO_PROXY: '',
    });
    const proxied = new PackagistClient(CREDENTIALS, {
      endpoint: 'http://packagist.invalid/api/update-package',
    });
    try {
      await expect(proxied.updatePackage(REPOSITORY)).resolves.toBeUndefined();
      expect(proxy.tunnelled).toStrictEqual(['packagist.invalid:80']);
      expect(server.seen).toHaveLength(1);
    } finally {
      await proxy.close();
    }
  });
});
