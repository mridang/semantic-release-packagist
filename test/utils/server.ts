import { createServer, type IncomingMessage, type Server } from 'node:http';

interface Seen {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly body: string;
}

export interface Loopback {
  readonly url: string;
  readonly seen: Seen[];
  readonly close: () => Promise<void>;
}

/**
 * Start a real HTTP server on 127.0.0.1 that records every request and
 * answers through the given handler.
 *
 * @param respond Called with the request number (from 1) and the raw response.
 * @returns The server's URL, the requests it saw and a way to stop it.
 */
export async function startLoopback(
  respond: (
    attempt: number,
    response: import('node:http').ServerResponse,
  ) => void,
): Promise<Loopback> {
  const seen: Seen[] = [];
  const read = async (request: IncomingMessage): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf8');
  };
  const server: Server = createServer((request, response) => {
    void read(request).then((body) => {
      seen.push({ method: request.method, url: request.url, body });
      respond(seen.length, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/api/update-package`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
