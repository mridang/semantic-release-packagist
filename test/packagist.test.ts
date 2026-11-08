import { describe, expect, it, jest } from '@jest/globals';
import { MockAgent, Response, type fetch } from 'undici';
import { PackagistClient } from '../src/packagist.js';

const CREDENTIALS = { username: 'test-user', apiToken: 'SECRET-TOKEN' };
const REPOSITORY = 'https://github.com/test-user/test-repo.git';

/**
 * A client whose `fetch` returns the given responses in order.
 */
function withFetcher(...responses: Response[]): {
  client: PackagistClient;
  fetcher: jest.Mock<typeof fetch>;
} {
  const fetcher = jest.fn<typeof fetch>();
  responses.forEach((response) => fetcher.mockResolvedValueOnce(response));
  return { client: new PackagistClient(CREDENTIALS, { fetcher }), fetcher };
}

/**
 * A client that talks to an in-memory Packagist.
 */
function withMock(): {
  client: PackagistClient;
  packagist: ReturnType<MockAgent['get']>;
} {
  const agent = new MockAgent();
  agent.disableNetConnect();
  return {
    client: new PackagistClient(CREDENTIALS, { agent }),
    packagist: agent.get('https://packagist.org'),
  };
}

const UPDATE = { path: /^\/api\/update-package\?/, method: 'POST' } as const;

describe('PackagistClient.updatePackage', () => {
  it('posts the repository to the update endpoint with the credentials', async () => {
    const { client, fetcher } = withFetcher(
      new Response('{}', { status: 202 }),
    );
    await client.updatePackage(REPOSITORY);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    const target = new URL(String(url));
    expect(target.origin + target.pathname).toBe(
      'https://packagist.org/api/update-package',
    );
    expect(Object.fromEntries(target.searchParams)).toStrictEqual({
      username: 'test-user',
      apiToken: 'SECRET-TOKEN',
    });
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repository: { url: REPOSITORY } }),
    });
    expect(init?.dispatcher).toBeUndefined();
  });

  it.each([401, 403])(
    'maps %s to an invalid credentials error',
    async (status) => {
      const { client } = withFetcher(new Response('nope', { status }));
      await expect(client.updatePackage(REPOSITORY)).rejects.toMatchObject({
        code: 'EINVALIDPACKAGISTTOKEN',
        message: 'Invalid Packagist credentials.',
        details: expect.stringContaining(`returned a ${status} status`),
      });
    },
  );

  it('maps 404 to a package not found error naming the repository', async () => {
    const { client } = withFetcher(new Response('', { status: 404 }));
    await expect(client.updatePackage(REPOSITORY)).rejects.toMatchObject({
      code: 'EPACKAGISTNOTFOUND',
      message: 'Packagist package not found.',
      details: expect.stringContaining(REPOSITORY),
    });
  });

  it('maps any other status to an API error with the response body', async () => {
    const { client } = withFetcher(
      new Response('teapot body', { status: 418, statusText: "I'm a teapot" }),
    );
    await expect(client.updatePackage(REPOSITORY)).rejects.toMatchObject({
      code: 'EPACKAGISTAPI',
      message: "Failed to notify Packagist: I'm a teapot",
      details:
        'The Packagist API returned an unexpected 418 status. Response: teapot body',
    });
  });

  it('reports a failure that has no HTTP status with its cause', async () => {
    const fetcher = jest
      .fn<typeof fetch>()
      .mockRejectedValue(
        new TypeError('fetch failed', { cause: new Error('socket hang up') }),
      );
    const client = new PackagistClient(CREDENTIALS, { fetcher });
    await expect(client.updatePackage(REPOSITORY)).rejects.toThrow(
      'fetch failed: socket hang up',
    );
  });

  it('reports a failure that is not an error as text', async () => {
    const fetcher = jest.fn<typeof fetch>().mockRejectedValue('offline');
    const client = new PackagistClient(CREDENTIALS, { fetcher });
    await expect(client.updatePackage(REPOSITORY)).rejects.toThrow('offline');
  });

  it.each([503, 429])(
    'does not retry the update after a %s',
    async (status) => {
      const { client, packagist } = withMock();
      packagist.intercept(UPDATE).reply(status, 'busy').times(1);
      packagist.intercept(UPDATE).reply(200, '{}');
      await expect(client.updatePackage(REPOSITORY)).rejects.toMatchObject({
        code: 'EPACKAGISTAPI',
        details: `The Packagist API returned an unexpected ${status} status. Response: busy`,
      });
    },
  );

  it('does not retry the update after a dropped connection', async () => {
    const { client, packagist } = withMock();
    packagist
      .intercept(UPDATE)
      .replyWithError(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))
      .times(1);
    packagist.intercept(UPDATE).reply(200, '{}');
    await expect(client.updatePackage(REPOSITORY)).rejects.toThrow(
      /fetch failed: reset/,
    );
  });

  it('does not leak the token when the connection drops', async () => {
    const { client, packagist } = withMock();
    packagist
      .intercept(UPDATE)
      .replyWithError(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))
      .times(1);
    const failure = await client
      .updatePackage(REPOSITORY)
      .catch((e: unknown) => e);
    expect(String(failure)).not.toContain('SECRET-TOKEN');
  });

  it('does not retry a rejection of the credentials', async () => {
    const { client, packagist } = withMock();
    packagist.intercept(UPDATE).reply(401, 'no').times(1);
    await expect(client.updatePackage(REPOSITORY)).rejects.toMatchObject({
      code: 'EINVALIDPACKAGISTTOKEN',
    });
  });
});
