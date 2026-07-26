import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import type * as k8s from '@kubernetes/client-node';
import {
  BunCompatibleWatch,
  type BunWatchRequestFactory,
  watchErrorMessage,
} from '../../src/core/kubernetes/bun-watch.js';

function kubeConfigFor(server = 'http://kubernetes.test', token = 'test-token'): k8s.KubeConfig {
  return {
    getCurrentCluster: () => ({ name: 'test', server, skipTLSVerify: false }),
    applyToHTTPSOptions: async (options: { headers?: Record<string, string> }) => {
      options.headers = { ...options.headers, authorization: `Bearer ${token}` };
    },
  } as unknown as k8s.KubeConfig;
}

function requestFactory(
  statusCode: number,
  body: string,
  inspectOptions?: (options: Record<string, unknown>) => void
): BunWatchRequestFactory {
  return (_protocol, options, callback) => {
    const request = new EventEmitter() as ClientRequest;
    request.end = (() => {
      inspectOptions?.(options as Record<string, unknown>);
      const response = new PassThrough();
      Object.assign(response, { statusCode });
      callback(response as unknown as IncomingMessage);
      response.end(body);
    }) as ClientRequest['end'];
    request.destroy = ((error?: Error) => {
      if (error) queueMicrotask(() => request.emit('error', error));
      return request;
    }) as ClientRequest['destroy'];
    return request;
  };
}

describe('BunCompatibleWatch', () => {
  it('applies kubeconfig authentication and parses streaming events', async () => {
    let authorization: string | undefined;
    const watch = new BunCompatibleWatch(
      kubeConfigFor(),
      requestFactory(
        200,
        `${JSON.stringify({
          type: 'ADDED',
          object: { kind: 'Event', metadata: { name: 'scheduled' } },
        })}\n`,
        (options) => {
          authorization = (options.headers as Record<string, string> | undefined)?.authorization;
        }
      )
    );
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
    const watch = new BunCompatibleWatch(
      kubeConfigFor(),
      requestFactory(
        403,
        JSON.stringify({ kind: 'Status', reason: 'Forbidden', message: 'denied' })
      )
    );

    const completion = new Promise<unknown>((resolve) => {
      void watch.watch('/api/v1/namespaces/default/events', {}, () => {}, resolve);
    });

    const error = await completion;
    expect(watchErrorMessage(error)).toContain('HTTP 403');
    expect(watchErrorMessage(error)).toContain('Forbidden');
    expect(watchErrorMessage(error)).toContain('denied');
  });
});
