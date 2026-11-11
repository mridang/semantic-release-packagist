import { createServer } from 'node:http';
import { connect } from 'node:net';

export interface TunnelProxy {
  readonly url: string;
  readonly tunnelled: string[];
  readonly close: () => Promise<void>;
}

/**
 * Start a plain HTTP proxy on 127.0.0.1 that accepts `CONNECT`, records the
 * host it was asked for and tunnels to a local server instead.
 * @param targetPort - The local port every tunnel leads to.
 * @returns The proxy's URL, the hosts it was asked for and a way to stop it.
 */
export async function startTunnelProxy(
  targetPort: number,
): Promise<TunnelProxy> {
  const tunnelled: string[] = [];
  const server = createServer();
  server.on('connect', (request, socket, head) => {
    tunnelled.push(request.url ?? '');
    const upstream = connect(targetPort, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    tunnelled,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
