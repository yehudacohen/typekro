/**
 * Custom HTTP Library for @kubernetes/client-node that works with Bun
 *
 * This module provides a workaround for Bun's fetch TLS issues:
 * https://github.com/oven-sh/bun/issues/10642
 *
 * The issue: Bun intercepts node-fetch and uses its native fetch implementation,
 * which doesn't properly support https.Agent for TLS configuration (client certificates,
 * skipTLSVerify, etc.).
 *
 * The solution: Extract TLS options from the https.Agent and pass them directly
 * to https.request instead of using the agent.
 */

import type {
  HttpLibrary,
  RequestContext,
  ResponseContext,
} from '@kubernetes/client-node/dist/gen/http/http.js';
import { from, type Observable } from '@kubernetes/client-node/dist/gen/rxjsStub.js';
import * as http from 'http';
import * as https from 'https';
import { DEFAULT_HTTP_READ_TIMEOUT } from '../config/defaults.js';
import { getComponentLogger } from '../logging/index.js';

/**
 * Configuration for HTTP request timeouts by operation type.
 *
 * These timeouts apply when running in Bun runtime to prevent requests
 * from hanging indefinitely when the Kubernetes API server doesn't respond
 * (due to webhook delays, network issues, etc.).
 *
 * Timeout values are based on kubectl defaults and operation characteristics:
 * - Watch operations: DISABLED (handled by API server via timeoutSeconds parameter)
 * - Read operations (GET/LIST): Complete quickly
 * - Write operations (CREATE/PATCH/PUT): May trigger webhooks, need longer timeouts
 * - Delete operations: May wait for finalizers, need even longer timeouts
 */
export interface HttpTimeoutConfig {
  /**
   * Timeout for read operations (GET, LIST)
   * @default 30000 (30 seconds) - matches kubectl default
   */
  default?: number;

  /**
   * Timeout for watch operations (long-lived connections with ?watch=true)
   * @default 3600000 (1 hour) - effectively disabled
   * Watch connections are controlled by the Kubernetes API server via timeoutSeconds
   * query parameter. HTTP-level timeouts interfere with EventMonitor reconnection logic.
   */
  watch?: number;

  /**
   * Timeout for create operations (POST)
   * @default 120000 (2 minutes)
   * May trigger admission webhooks for validation, CRD defaults, mutations
   */
  create?: number;

  /**
   * Timeout for update operations (PATCH, PUT)
   * @default 120000 (2 minutes)
   * May trigger admission webhooks for validation, CRD defaults, mutations
   */
  update?: number;

  /**
   * Timeout for delete operations (DELETE)
   * @default 180000 (3 minutes)
   * May wait for finalizers, graceful termination
   */
  delete?: number;
}

/**
 * Default timeout values for Kubernetes API operations
 * Based on kubectl defaults and operation characteristics
 */
const DEFAULT_TIMEOUTS: Required<HttpTimeoutConfig> = {
  default: DEFAULT_HTTP_READ_TIMEOUT,
  watch: 3600000, // 1 hour - effectively disabled (API server controls watch timeouts)
  create: 120000, // 2 minutes - write operations with webhooks
  update: 120000, // 2 minutes - write operations with webhooks
  delete: 180000, // 3 minutes - may need to wait for finalizers
};

/**
 * Check if we're running in Bun runtime
 */
export function isBunRuntime(): boolean {
  return typeof Bun !== 'undefined';
}

/**
 * Custom HTTP Library that uses Node's https module directly.
 * This bypasses Bun's fetch which has TLS/agent issues.
 *
 * Use this when running in Bun with kubernetes client to ensure
 * proper TLS certificate handling and request timeouts.
 *
 * @see https://github.com/oven-sh/bun/issues/10642
 */
export class BunCompatibleHttpLibrary implements HttpLibrary {
  private timeouts: Required<HttpTimeoutConfig>;
  private logger = getComponentLogger('bun-http-library');

  /**
   * Create a new BunCompatibleHttpLibrary with optional custom timeout configuration
   * @param timeoutConfig - Optional custom timeout values for different operation types
   */
  constructor(timeoutConfig?: HttpTimeoutConfig) {
    this.timeouts = {
      ...DEFAULT_TIMEOUTS,
      ...timeoutConfig,
    };

    // Log timeout configuration when running in Bun
    if (isBunRuntime()) {
      this.logger.debug('BunCompatibleHttpLibrary initialized with timeouts', {
        default: `${this.timeouts.default}ms`,
        watch: `${this.timeouts.watch}ms`,
        create: `${this.timeouts.create}ms`,
        update: `${this.timeouts.update}ms`,
        delete: `${this.timeouts.delete}ms`,
      });
    }
  }

  public send(request: RequestContext): Observable<ResponseContext> {
    const resultPromise = this.makeRequest(request);
    return from(resultPromise);
  }

  /**
   * Determine the appropriate timeout for this HTTP request based on
   * the HTTP method and URL parameters
   *
   * @param method - HTTP method (GET, POST, PATCH, DELETE, etc.)
   * @param url - Full request URL
   * @returns Timeout in milliseconds
   */
  private getTimeoutForRequest(method: string, url: string): number {
    // Watch operations are long-lived streaming connections controlled by the
    // Kubernetes API server via timeoutSeconds query parameter. Do NOT set
    // HTTP-level timeouts on watch connections as this interferes with the
    // EventMonitor's reconnection logic and causes AbortError issues.
    if (url.includes('?watch=true') || url.includes('&watch=true')) {
      return this.timeouts.watch;
    }

    // Operation-specific timeouts based on HTTP method
    // Increased for complex operations that may involve webhooks/finalizers
    const upperMethod = method.toUpperCase();
    switch (upperMethod) {
      case 'POST':
        return this.timeouts.create;
      case 'PATCH':
      case 'PUT':
        return this.timeouts.update;
      case 'DELETE':
        return this.timeouts.delete;
      case 'GET':
      case 'HEAD':
      case 'OPTIONS':
      default:
        return this.timeouts.default;
    }
  }

  private makeRequest(request: RequestContext): Promise<ResponseContext> {
    return new Promise((resolve, reject) => {
      const url = new URL(request.getUrl());
      const method = request.getHttpMethod();
      const isHttps = url.protocol === 'https:';
      const httpModule = isHttps ? https : http;

      // Determine appropriate timeout for this request
      const timeoutMs = this.getTimeoutForRequest(method, url.toString());

      // For watch operations, skip HTTP timeout entirely - let API server handle it
      const shouldSetTimeout =
        !url.toString().includes('?watch=true') && !url.toString().includes('&watch=true');

      const agent = request.getAgent();
      const headers = request.getHeaders();
      const body = request.getBody();

      // Extract TLS options from the agent if present
      // This is the key workaround for Bun's https.Agent issues
      const agentOptions = agent ? (agent as any).options || {} : {};

      const options: https.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: method,
        headers: headers,
        // Pass TLS options directly instead of using agent
        // This works around Bun's issues with https.Agent
        rejectUnauthorized: agentOptions.rejectUnauthorized ?? true,
        cert: agentOptions.cert,
        key: agentOptions.key,
        ca: agentOptions.ca,
        // Additional TLS options that might be set
        pfx: agentOptions.pfx,
        passphrase: agentOptions.passphrase,
        servername: agentOptions.servername,
        ciphers: agentOptions.ciphers,
      };

      const req = httpModule.request(options, (res) => {
        const chunks: Buffer[] = [];

        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });

        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          const responseHeaders: Record<string, string> = {};

          // Convert headers to simple object
          for (const [key, value] of Object.entries(res.headers)) {
            if (value) {
              responseHeaders[key] = Array.isArray(value) ? value.join(', ') : value;
            }
          }

          // Create response body with all methods expected by kubernetes client
          // Including getBodyAsAny which is used by KubernetesObjectApi
          const responseBody = {
            text: () => Promise.resolve(buffer.toString('utf-8')),
            binary: () => Promise.resolve(buffer),
          };

          // Create a response context that matches the expected interface
          // KubernetesObjectApi expects getBodyAsAny() method on the response
          const response = {
            httpStatusCode: res.statusCode || 0,
            headers: responseHeaders,
            body: responseBody,
            // Add getBodyAsAny method for KubernetesObjectApi compatibility
            getBodyAsAny: async () => {
              const text = buffer.toString('utf-8');
              try {
                return JSON.parse(text);
              } catch (error) {
                this.logger.debug('Failed to parse response body as JSON, returning raw text', {
                  err: error,
                });
                return text;
              }
            },
          };

          resolve(response as ResponseContext);
        });
      });

      req.on('error', (err) => {
        reject(err);
      });

      // ⭐ SET HTTP REQUEST TIMEOUT (skip for watch operations)
      // This is critical for preventing requests from hanging indefinitely
      // when the Kubernetes API server doesn't respond (webhooks, network issues)
      // Watch operations are handled by the API server via timeoutSeconds parameter
      if (shouldSetTimeout) {
        req.setTimeout(timeoutMs, () => {
          req.destroy(); // Abort the request
          const timeoutError = new Error(
            `HTTP request timeout: ${method} ${url.pathname} timed out after ${timeoutMs}ms\n` +
              `URL: ${url.toString()}\n` +
              `\n` +
              `💡 Possible causes:\n` +
              `  • Kubernetes API server is not responding\n` +
              `  • Admission webhooks are slow or unavailable\n` +
              `  • Network connectivity issues\n` +
              `  • Request is legitimately slow and timeout is too short\n` +
              `\n` +
              `✅ Solutions:\n` +
              `  • Verify Kubernetes API server is running: kubectl cluster-info\n` +
              `  • Check webhook status: kubectl get validatingwebhookconfigurations\n` +
              `  • Increase timeout via httpTimeouts option if needed\n` +
              `  • For watch operations: timeouts are disabled (API server controls via timeoutSeconds)`
          );
          reject(timeoutError);
        });
      }

      // Handle abort signal (if available - added in newer versions)
      const signal = (request as any).getSignal?.();
      if (signal) {
        signal.addEventListener('abort', () => {
          req.destroy(new Error('Request aborted'));
        });
      }

      // Send body if present
      if (body) {
        req.write(body);
      }

      req.end();
    });
  }
}

/**
 * Get the appropriate HTTP library based on the runtime environment.
 * Returns BunCompatibleHttpLibrary when running in Bun, otherwise
 * returns undefined to use the default IsomorphicFetchHttpLibrary.
 *
 * @param timeoutConfig - Optional custom timeout configuration for Bun runtime
 * @returns BunCompatibleHttpLibrary for Bun, undefined for other runtimes
 */
export function getHttpLibraryForRuntime(
  timeoutConfig?: HttpTimeoutConfig
): HttpLibrary | undefined {
  if (isBunRuntime()) {
    return new BunCompatibleHttpLibrary(timeoutConfig);
  }
  return undefined;
}

// Re-export types needed for creating custom configurations
export type { HttpLibrary, RequestContext, ResponseContext };
