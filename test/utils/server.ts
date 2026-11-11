import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { Duplex } from 'node:stream';

export interface LoopbackServer {
  readonly url: string;
  readonly port: number;
  /** One entry per request: the method, the path and any `Range` header. */
  readonly seen: string[];
  readonly close: () => Promise<void>;
}

/**
 * Stop a server, dropping the connections it still holds.
 * @param server - The server to stop.
 * @returns Resolves once it has stopped.
 */
function stop(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

/**
 * Start an HTTP server on a free loopback port.
 * @param handler - Answers each request.
 * @returns Where it listens, what it has seen and a way to stop it.
 */
export async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<LoopbackServer> {
  const seen: string[] = [];
  const server = createServer((request, response) => {
    seen.push(
      `${request.method} ${request.url} ${request.headers.range ?? ''}`.trim(),
    );
    handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    seen,
    close: () => stop(server),
  };
}

export interface FaultyProxy {
  readonly url: string;
  /** How many times a client asked this proxy to open a tunnel. */
  readonly connects: () => number;
  readonly close: () => Promise<void>;
}

/**
 * Start a proxy that accepts a `CONNECT` and then misbehaves.
 * @param mode - `reset` drops the connection at once; `stall` never answers.
 * @returns The proxy's URL, a counter of the tunnels asked for and a way to
 * stop it.
 */
export async function startFaultyProxy(
  mode: 'reset' | 'stall',
): Promise<FaultyProxy> {
  const attempts: string[] = [];
  const sockets: Duplex[] = [];
  const server = createServer();
  server.on('connect', (request, socket) => {
    attempts.push(request.url ?? '');
    sockets.push(socket);
    socket.on('error', () => undefined);
    if (mode === 'reset') {
      socket.destroy();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    connects: () => attempts.length,
    close: () => {
      sockets.forEach((socket) => socket.destroy());
      return stop(server);
    },
  };
}
