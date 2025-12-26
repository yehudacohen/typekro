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

import * as https from 'https';
import * as http from 'http';
import { from, type Observable } from '@kubernetes/client-node/dist/gen/rxjsStub.js';
import type { HttpLibrary, RequestContext, ResponseContext } from '@kubernetes/client-node/dist/gen/http/http.js';

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
 * proper TLS certificate handling.
 */
export class BunCompatibleHttpLibrary implements HttpLibrary {
  public send(request: RequestContext): Observable<ResponseContext> {
    const resultPromise = this.makeRequest(request);
    return from(resultPromise);
  }

  private makeRequest(request: RequestContext): Promise<ResponseContext> {
    return new Promise((resolve, reject) => {
      const url = new URL(request.getUrl());
      const isHttps = url.protocol === 'https:';
      const httpModule = isHttps ? https : http;
      
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
        method: request.getHttpMethod(),
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
              } catch {
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

      // Handle abort signal
      const signal = request.getSignal();
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
 */
export function getHttpLibraryForRuntime(): HttpLibrary | undefined {
  if (isBunRuntime()) {
    return new BunCompatibleHttpLibrary();
  }
  return undefined;
}

// Re-export types needed for creating custom configurations
export type { HttpLibrary, RequestContext, ResponseContext };
