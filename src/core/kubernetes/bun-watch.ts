import * as http from 'node:http';
import * as https from 'node:https';
import type * as k8s from '@kubernetes/client-node';
import { ensureError } from '../errors.js';
import { extractAgentTlsOptions, isBunRuntime } from './bun-http-library.js';
import { getKubernetesClientNode } from './client-node-runtime.js';

export interface KubernetesWatch {
  watch(
    path: string,
    queryParams: Record<string, string | number | boolean | undefined>,
    callback: (phase: string, apiObj: unknown, watchObj: unknown) => void,
    done: (error: unknown) => void
  ): Promise<{ abort(): void }>;
}

interface WatchError extends Error {
  statusCode?: number;
  responseBody?: string;
}

export type BunWatchRequestFactory = (
  protocol: 'http:' | 'https:',
  options: https.RequestOptions,
  callback: (response: http.IncomingMessage) => void
) => http.ClientRequest;

const defaultRequestFactory: BunWatchRequestFactory = (protocol, options, callback) => {
  const client = protocol === 'https:' ? https : http;
  return client.request(options, callback);
};

function watchCompletionError(message: string, name: 'AbortError' | 'TimeoutError'): Error {
  return new DOMException(message, name);
}

/**
 * Streaming Kubernetes watch transport for Bun.
 *
 * The upstream Watch uses node-fetch and passes client certificates through an
 * https.Agent. Bun's fetch compatibility layer does not reliably honor that
 * agent, which turns an authenticated kubeconfig into `system:anonymous`.
 * This implementation applies KubeConfig authentication, extracts the TLS
 * material, and sends it directly through node:https like the ordinary Bun API
 * transport.
 */
export class BunCompatibleWatch implements KubernetesWatch {
  constructor(
    private readonly kubeConfig: k8s.KubeConfig,
    private readonly requestFactory: BunWatchRequestFactory = defaultRequestFactory
  ) {}

  async watch(
    path: string,
    queryParams: Record<string, string | number | boolean | undefined>,
    callback: (phase: string, apiObj: unknown, watchObj: unknown) => void,
    done: (error: unknown) => void
  ): Promise<{ abort(): void }> {
    const cluster = this.kubeConfig.getCurrentCluster();
    if (!cluster) throw new Error('No currently active cluster');

    const url = new URL(path, cluster.server);
    url.searchParams.set('watch', 'true');
    for (const [key, value] of Object.entries(queryParams)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const authenticatedOptions: https.RequestOptions = { headers: {} };
    await this.kubeConfig.applyToHTTPSOptions(authenticatedOptions);
    const tls = extractAgentTlsOptions(authenticatedOptions.agent);
    let completed = false;
    let aborted = false;
    const doneOnce = (error: unknown) => {
      if (completed) return;
      completed = true;
      done(error);
    };

    const request = this.requestFactory(
      url.protocol as 'http:' | 'https:',
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        agent: false,
        auth: authenticatedOptions.auth,
        headers: {
          ...authenticatedOptions.headers,
          connection: 'close',
          accept: 'application/json',
        },
        rejectUnauthorized: tls.rejectUnauthorized ?? true,
        cert: tls.cert,
        key: tls.key,
        ca: tls.ca,
        pfx: tls.pfx,
        passphrase: tls.passphrase,
        servername: tls.servername,
        ciphers: tls.ciphers,
      },
      (response) => {
        if (response.statusCode !== 200) {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer | string) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          response.on('end', () => {
            const error = new Error(
              `Kubernetes watch request failed with HTTP ${response.statusCode ?? 0}`
            ) as WatchError;
            if (response.statusCode !== undefined) error.statusCode = response.statusCode;
            error.responseBody = Buffer.concat(chunks).toString('utf8');
            doneOnce(error);
          });
          return;
        }

        response.setEncoding('utf8');
        let pending = '';
        const consumeLine = (line: string) => {
          const trimmed = line.trim();
          if (!trimmed) return;
          try {
            const event = JSON.parse(trimmed) as {
              type?: string;
              object?: unknown;
            };
            callback(event.type ?? 'UNKNOWN', event.object, event);
          } catch {
            // Kubernetes watch streams may contain an incomplete trailing line;
            // malformed lines are ignored like the upstream client.
          }
        };
        response.on('data', (chunk: string) => {
          pending += chunk;
          let newline = pending.indexOf('\n');
          while (newline >= 0) {
            consumeLine(pending.slice(0, newline));
            pending = pending.slice(newline + 1);
            newline = pending.indexOf('\n');
          }
        });
        response.on('error', doneOnce);
        response.on('end', () => {
          consumeLine(pending);
          doneOnce(
            aborted
              ? watchCompletionError('Kubernetes watch aborted', 'AbortError')
              : watchCompletionError('Kubernetes watch timeout or server close', 'TimeoutError')
          );
        });
      }
    );

    request.on('error', (error) => {
      doneOnce(aborted ? watchCompletionError('Kubernetes watch aborted', 'AbortError') : error);
    });
    request.end();

    return {
      abort: () => {
        if (aborted) return;
        aborted = true;
        request.destroy(watchCompletionError('Kubernetes watch aborted', 'AbortError'));
      },
    };
  }
}

export function createWatchForRuntime(kubeConfig: k8s.KubeConfig): KubernetesWatch {
  if (isBunRuntime()) return new BunCompatibleWatch(kubeConfig);
  const clientNode = getKubernetesClientNode();
  return new clientNode.Watch(kubeConfig) as KubernetesWatch;
}

export function watchErrorMessage(error: unknown): string {
  const watchError = ensureError(error) as WatchError;
  return watchError.responseBody
    ? `${watchError.message}: ${watchError.responseBody}`
    : watchError.message;
}
