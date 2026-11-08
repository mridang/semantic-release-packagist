import { afterEach, describe, expect, it } from '@jest/globals';
import { MockAgent } from 'undici';
import { PackagistClient } from '../src/packagist.js';
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

  it('reports a connection that keeps dropping without the token', async () => {
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
    expect(String(failure)).not.toContain('SECRET-TOKEN');
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
  ): Promise<{ client: PackagistClient; server: Loopback }> {
    const server = await startLoopback(respond);
    started.push(server);
    return {
      server,
      client: new PackagistClient(CREDENTIALS, {
        endpoint: server.url,
        minTimeout: 1,
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
});
