import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

interface Seen {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: IncomingMessage['headers'];
  readonly body: string;
}

export interface Loopback {
  readonly connections: () => Promise<number>;
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
  respond: (attempt: number, response: ServerResponse) => void,
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
      seen.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body,
      });
      respond(seen.length, response);
    });
  });
  // Advertise a long keep-alive, as a real server or CDN does.
  server.keepAliveTimeout = 60000;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/api/update-package`,
    seen,
    connections: () =>
      new Promise<number>((resolve) => {
        server.getConnections((_error, count) => resolve(count));
      }),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * Write a large body to a response, one chunk at a time and only as fast as the
 * client reads it.
 *
 * @param response The response to write to.
 * @param totalBytes How much to write if the client keeps reading.
 * @returns How much had been handed to the connection when it closed.
 */
export function streamBody(
  response: ServerResponse,
  totalBytes: number,
): Promise<number> {
  const chunk = Buffer.alloc(64 * 1024, 'x');
  const progress = { sent: 0 };
  const pump = (): void => {
    while (progress.sent < totalBytes) {
      progress.sent += chunk.length;
      if (!response.write(chunk)) {
        response.once('drain', pump);
        return;
      }
    }
    response.end();
  };
  return new Promise((resolve) => {
    response.on('close', () => resolve(progress.sent));
    pump();
  });
}
