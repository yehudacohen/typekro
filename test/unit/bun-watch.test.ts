import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'bun:test';
import type * as k8s from '@kubernetes/client-node';
import { BunCompatibleWatch, watchErrorMessage } from '../../src/core/kubernetes/bun-watch.js';

const servers = new Set<Server>();

async function listen(server: Server): Promise<number> {
  servers.add(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected an IP server address');
  return address.port;
}

function kubeConfigFor(server: string, token = 'test-token'): k8s.KubeConfig {
  return {
    getCurrentCluster: () => ({ name: 'test', server, skipTLSVerify: false }),
    applyToHTTPSOptions: async (options: { headers?: Record<string, string> }) => {
      options.headers = { ...options.headers, authorization: `Bearer ${token}` };
    },
  } as unknown as k8s.KubeConfig;
}

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    )
  );
  servers.clear();
});

describe('BunCompatibleWatch', () => {
  it('applies kubeconfig authentication and parses streaming events', async () => {
    let authorization: string | undefined;
    const server = createServer((request, response) => {
      authorization = request.headers.authorization;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        `${JSON.stringify({
          type: 'ADDED',
          object: { kind: 'Event', metadata: { name: 'scheduled' } },
        })}\n`
      );
    });
    const port = await listen(server);
    const watch = new BunCompatibleWatch(kubeConfigFor(`http://127.0.0.1:${port}`));
    const events: Array<{ phase: string; object: unknown }> = [];

    const completion = new Promise<unknown>((resolve) => {
      void watch.watch(
        '/api/v1/namespaces/default/events',
        { timeoutSeconds: 5, fieldSelector: 'involvedObject.name=demo' },
        (phase, object) => events.push({ phase, object }),
        resolve
      );
    });

    const completionError = await completion;
    expect(authorization).toBe('Bearer test-token');
    expect(events).toEqual([
      {
        phase: 'ADDED',
        object: { kind: 'Event', metadata: { name: 'scheduled' } },
      },
    ]);
    expect(completionError).toBeInstanceOf(DOMException);
    expect((completionError as Error).name).toBe('TimeoutError');
  });

  it('preserves API-server status and response diagnostics', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(403, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ kind: 'Status', reason: 'Forbidden', message: 'denied' }));
    });
    const port = await listen(server);
    const watch = new BunCompatibleWatch(kubeConfigFor(`http://127.0.0.1:${port}`));

    const completion = new Promise<unknown>((resolve) => {
      void watch.watch('/api/v1/namespaces/default/events', {}, () => {}, resolve);
    });

    const error = await completion;
    expect(watchErrorMessage(error)).toContain('HTTP 403');
    expect(watchErrorMessage(error)).toContain('Forbidden');
    expect(watchErrorMessage(error)).toContain('denied');
  });
});
