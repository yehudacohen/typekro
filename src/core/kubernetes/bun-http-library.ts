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

import * as http from 'node:http';
import * as https from 'node:https';
import type {
  HttpLibrary,
  RequestContext,
  ResponseContext,
} from '@kubernetes/client-node/dist/gen/http/http.js';
import { from, type Observable } from '@kubernetes/client-node/dist/gen/rxjsStub.js';
import {
  DEFAULT_HTTP_DELETE_TIMEOUT,
  DEFAULT_HTTP_READ_HEDGE_DELAY,
  DEFAULT_HTTP_READ_TIMEOUT,
  DEFAULT_HTTP_WATCH_TIMEOUT,
  DEFAULT_HTTP_WRITE_TIMEOUT,
} from '../config/defaults.js';
import { RequestTimeoutError } from '../deployment/poll-timeout.js';
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

  /**
   * How long a read (GET/HEAD, not a watch) may go without response headers before a second
   * copy of it is sent on a new connection. The first copy is NOT cancelled: both run, the first
   * complete response wins and the other is torn down, and both share the read's `default`
   * budget, so a read still settles within that budget.
   *
   * This rides out a connection that stalls before the server answers — a dropped handshake or a
   * request the network swallowed — which otherwise costs the whole read budget and fails the call.
   * A read that is merely slow (a large LIST) costs one duplicate request and returns as fast as
   * before. Writes and deletes are never duplicated.
   *
   * @default 10000 (10 seconds). `0`, or any value not below `default`, disables it.
   */
  readHedgeDelay?: number;
}

/**
 * TLS-related options extracted from an https.Agent at runtime.
 * Node.js stores these on agent.options but it's not part of the public type.
 */
export interface AgentTlsOptions {
  rejectUnauthorized?: boolean;
  cert?: string | Buffer;
  key?: string | Buffer;
  ca?: string | Buffer | Array<string | Buffer>;
  pfx?: string | Buffer;
  passphrase?: string;
  servername?: string;
  ciphers?: string;
}

/**
 * The transport dropped before the response was complete.
 *
 * WHY THIS TYPE EXISTS: a request whose socket dies mid-response must REJECT, and must reject as
 * something callers already understand. It is modelled as a {@link RequestTimeoutError} because the
 * caller's situation is identical to a timeout — the call did not return an answer — so gates that
 * fail CLOSED on a wedged call (they must not read "no answer" as "nothing is there") keep working
 * without knowing this class exists. `code` is `ECONNRESET` and the message contains
 * `socket hang up`, the two shapes the transient/retryable classifiers already match on, so a
 * retry loop treats it as the transient transport blip it usually is.
 *
 * NOTE ON `timeoutMs`: nothing here EXPIRED — the socket died with budget to spare, typically in
 * milliseconds out of minutes. The inherited field therefore carries how long the request actually
 * ran ({@link elapsedMs}), never the configured budget, so a log line or a retry heuristic reading
 * it cannot conclude that the deadline was reached.
 */
export class PrematureCloseError extends RequestTimeoutError {
  /** Node's system-error code for a peer-reset socket; transient-error classifiers match on it. */
  readonly code = 'ECONNRESET' as const;
  /** How long the request ran before the transport died. Same value as the inherited `timeoutMs`. */
  readonly elapsedMs: number;
  constructor(method: string, path: string, elapsedMs: number, phase: string, cause?: unknown) {
    super(
      `socket hang up: the connection closed before the response completed (${method} ${path}) — ${phase}.\n` +
        `The connection lasted ${elapsedMs}ms; its budget had not expired.\n` +
        (cause instanceof Error ? `Underlying transport error: ${cause.message}\n` : '') +
        `\n` +
        `The Kubernetes API server, or something between it and this client (load balancer, proxy, ` +
        `NAT gateway), dropped the connection mid-flight. This is usually transient; retry.`,
      elapsedMs
    );
    this.name = 'PrematureCloseError';
    this.elapsedMs = elapsedMs;
    if (cause !== undefined) this.cause = cause;
  }
}

/** Extract the TLS material KubeConfig placed on an https.Agent. */
export function extractAgentTlsOptions(agent: unknown): AgentTlsOptions {
  return agent && typeof agent === 'object' && 'options' in agent
    ? (Reflect.get(agent, 'options') as AgentTlsOptions)
    : {};
}

/**
 * Default timeout values for Kubernetes API operations
 * Based on kubectl defaults and operation characteristics
 */
const DEFAULT_TIMEOUTS: Required<HttpTimeoutConfig> = {
  default: DEFAULT_HTTP_READ_TIMEOUT,
  watch: DEFAULT_HTTP_WATCH_TIMEOUT, // 1 hour - effectively disabled (API server controls watch timeouts)
  create: DEFAULT_HTTP_WRITE_TIMEOUT, // 2 minutes - write operations with webhooks
  update: DEFAULT_HTTP_WRITE_TIMEOUT, // 2 minutes - write operations with webhooks
  delete: DEFAULT_HTTP_DELETE_TIMEOUT, // 3 minutes - may need to wait for finalizers
  readHedgeDelay: DEFAULT_HTTP_READ_HEDGE_DELAY, // 10 seconds - second copy of a stalled read
};

/** True for a watch request, which is long-lived by design and never timed or duplicated here. */
function isWatchUrl(url: string): boolean {
  return url.includes('?watch=true') || url.includes('&watch=true');
}

/** Per-attempt controls for {@link BunCompatibleHttpLibrary}'s request. */
interface RequestAttempt {
  /** This attempt's budget. Defaults to the budget for the request's method. */
  readonly timeoutMs?: number;
  /** Tears this attempt down when another copy of the same read has already answered. */
  readonly cancel?: AbortSignal;
  /** Called once, when the response headers arrive. */
  readonly onResponseStart?: () => void;
}

/** Rejection of a read copy that lost the race to another copy. Never reaches a caller. */
class SupersededAttemptError extends Error {
  constructor() {
    super('superseded: another copy of this read answered first');
    this.name = 'SupersededAttemptError';
  }
}

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
        readHedgeDelay: `${this.timeouts.readHedgeDelay}ms`,
      });
    }
  }

  public send(request: RequestContext): Observable<ResponseContext> {
    return from(this.dispatch(request));
  }

  /** Send a read through {@link sendHedged} when it may be duplicated; everything else once. */
  private dispatch(request: RequestContext): Promise<ResponseContext> {
    const method = request.getHttpMethod().toUpperCase();
    const url = request.getUrl();
    const timeoutMs = this.getTimeoutForRequest(method, url);
    const hedgeDelayMs = this.timeouts.readHedgeDelay;
    const idempotentRead = (method === 'GET' || method === 'HEAD') && !isWatchUrl(url);
    if (idempotentRead && hedgeDelayMs > 0 && hedgeDelayMs < timeoutMs) {
      return this.sendHedged(request, method, timeoutMs, hedgeDelayMs);
    }
    return this.makeRequest(request, { timeoutMs });
  }

  /**
   * Send a read, and if no response headers have arrived after `hedgeDelayMs`, send a second copy
   * on a new connection while the first keeps waiting. The first complete response wins and the
   * other copy is torn down.
   *
   * WHY: every request here opens its own connection (see `agent: false` below), and once in a
   * while a fresh connection stalls before the server answers — the handshake or the request is
   * lost somewhere on the path, the API server never sees it, and the read hangs for its whole
   * budget although the same read on another connection returns in well under a second. Waiting
   * out the budget turned one lost packet into a failed fail-closed gate. A second copy on a new
   * connection takes a new path, and since a read changes nothing, sending it twice is safe.
   *
   * BOUNDS: at most one extra copy. It gets only what is left of the original budget, so the read
   * still settles within `timeoutMs`. A failure before the second copy exists is returned at once —
   * refused, reset, TLS, abort — because it is an answer, not a stall. Once both exist, the read
   * fails only when both have, and with the FIRST copy's error, so callers keep seeing the same
   * error shapes (a request timeout with the full budget) they did without the second copy.
   */
  private sendHedged(
    request: RequestContext,
    method: string,
    timeoutMs: number,
    hedgeDelayMs: number
  ): Promise<ResponseContext> {
    return new Promise((resolve, reject) => {
      const path = new URL(request.getUrl()).pathname;
      const issuedAt = Date.now();
      const cancels: AbortController[] = [];
      const errors: unknown[] = [];
      let inFlight = 0;
      let settled = false;
      let hedgeTimer: ReturnType<typeof setTimeout> | undefined;
      const clearHedgeTimer = () => {
        if (hedgeTimer) {
          clearTimeout(hedgeTimer);
          hedgeTimer = undefined;
        }
      };

      const finish = (outcome: () => void): void => {
        if (settled) return;
        settled = true;
        clearHedgeTimer();
        for (const cancel of cancels) cancel.abort();
        outcome();
      };

      const launch = (copy: number, budgetMs: number): void => {
        const cancel = new AbortController();
        cancels.push(cancel);
        inFlight++;
        this.makeRequest(request, {
          timeoutMs: budgetMs,
          cancel: cancel.signal,
          // The original answering in time is the common case: no second copy is needed.
          ...(copy === 0 ? { onResponseStart: clearHedgeTimer } : {}),
        }).then(
          (response) => {
            if (!settled && cancels.length > 1) {
              this.logger.warn(
                copy === 0
                  ? `${method} ${path}: the first request answered after ${Date.now() - issuedAt}ms, ahead of its second copy`
                  : `${method} ${path}: the second copy answered after ${Date.now() - issuedAt}ms; the first request never answered`,
                {
                  method,
                  path,
                  elapsedMs: Date.now() - issuedAt,
                  winner: copy === 0 ? 'first' : 'second',
                }
              );
            }
            finish(() => resolve(response));
          },
          (error: unknown) => {
            inFlight--;
            errors[copy] = error;
            if (inFlight === 0) finish(() => reject(errors[0] ?? error));
          }
        );
      };

      launch(0, timeoutMs);
      hedgeTimer = setTimeout(() => {
        hedgeTimer = undefined;
        const remainingMs = timeoutMs - (Date.now() - issuedAt);
        if (settled || remainingMs <= 0) return;
        this.logger.warn(
          `${method} ${path}: no response after ${hedgeDelayMs}ms — sending a second copy on a new connection`,
          { method, path, hedgeDelayMs, remainingMs }
        );
        launch(1, remainingMs);
      }, hedgeDelayMs);
    });
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
    if (isWatchUrl(url)) {
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
      default:
        return this.timeouts.default;
    }
  }

  private makeRequest(
    request: RequestContext,
    attempt: RequestAttempt = {}
  ): Promise<ResponseContext> {
    return new Promise((resolve, reject) => {
      const url = new URL(request.getUrl());
      const method = request.getHttpMethod();
      const isHttps = url.protocol === 'https:';
      const httpModule = isHttps ? https : http;

      // Determine appropriate timeout for this request
      const timeoutMs = attempt.timeoutMs ?? this.getTimeoutForRequest(method, url.toString());

      // For watch operations, skip HTTP timeout entirely - let API server handle it
      const shouldSetTimeout = !isWatchUrl(url.toString());

      const agent = request.getAgent();
      const headers = request.getHeaders();
      const body = request.getBody();

      // Extract TLS options from the agent if present
      // This is the key workaround for Bun's https.Agent issues
      // Node.js stores constructor options on agent.options (not in public types)
      const agentOptions = extractAgentTlsOptions(agent);

      const options: https.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: method,
        // Disable connection pooling so Bun can exit once requests complete.
        // Reusing the runtime's default agent leaves idle Kubernetes API sockets
        // open after deploy completion, which keeps the CLI process alive.
        agent: false,
        headers: {
          connection: 'close',
          ...headers,
        },
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

      let timeoutId: NodeJS.Timeout | undefined;
      const clearRequestTimeout = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = undefined;
        }
      };

      // Detaching the abort listener, if one was attached. Assigned when the signal is wired up
      // below; a no-op until then, so the latch can always call it.
      let detachAbort = (): void => undefined;
      let detachCancel = (): void => undefined;

      // EVERY terminal path goes through here, and the FIRST one wins. Resolve/reject are latched so
      // a socket teardown that emits several events in a row (`aborted`, then `error`, then `close`)
      // cannot settle twice, and — the bug this guards — so no path can disarm the timer WITHOUT
      // settling. Clearing the timer is the guard's job alone; nothing else touches it. Releasing the
      // abort listener belongs here for the same reason: it is per-request state on a signal that
      // usually OUTLIVES the request.
      let settled = false;
      const settle = (finish: () => void): void => {
        if (settled) return;
        settled = true;
        clearRequestTimeout();
        detachAbort();
        detachCancel();
        finish();
      };

      // Bun's `node:http` emits the REQUEST's 'close' as soon as the response headers arrive, long
      // before the body is done (Node emits it after the exchange ends). So 'close' on the request
      // only means "the exchange ended" while no response has begun; once one has, the response's own
      // terminal events are what tell us whether it completed.
      let responseStarted = false;
      // The elapsed time, not the budget: a premature close happens with budget to spare, and the
      // error must not read as "the deadline was reached". See {@link PrematureCloseError}.
      const issuedAt = Date.now();
      const failPrematureClose = (phase: string, cause?: unknown) =>
        settle(() =>
          reject(new PrematureCloseError(method, url.pathname, Date.now() - issuedAt, phase, cause))
        );

      const req = httpModule.request(options, (res) => {
        responseStarted = true;
        attempt.onResponseStart?.();
        const chunks: Buffer[] = [];

        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });

        // The socket died with the body half-delivered. Unhandled, these leave the promise pending
        // FOREVER: 'end' never fires, and the request's 'error' does not fire either.
        res.on('aborted', () => failPrematureClose('the response body was truncated'));
        res.on('error', (err: Error) => failPrematureClose('the response stream failed', err));
        res.on('close', () => failPrematureClose('the response stream closed before it ended'));

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
              } catch (error: unknown) {
                this.logger.debug('Failed to parse response body as JSON, returning raw text', {
                  err: error,
                });
                return text;
              }
            },
          };

          settle(() => resolve(response as ResponseContext));
        });
      });

      req.on('error', (err) => {
        settle(() => reject(err));
      });

      req.on('socket', (socket) => {
        // Prevent idle client sockets from keeping short-lived CLI processes alive.
        // Bun can keep its HTTP client thread around after requests complete unless
        // the socket is explicitly detached from the event loop.
        socket.unref();
      });

      // ⭐ SET HTTP REQUEST TIMEOUT (skip for watch operations)
      // This is critical for preventing requests from hanging indefinitely
      // when the Kubernetes API server doesn't respond (webhooks, network issues)
      // Watch operations are handled by the API server via timeoutSeconds parameter
      if (shouldSetTimeout) {
        timeoutId = setTimeout(() => {
          // A TYPED timeout (not a bare Error): this timer is armed synchronously as the request is
          // issued, so with equal budgets it fires BEFORE any deadline wrapper around the call and
          // is the error a caller actually sees. A gate that fails open on ordinary failures must be
          // able to tell this apart from "the object does not exist". See `isRequestTimeoutError`.
          const timeoutError = new RequestTimeoutError(
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
              `  • For watch operations: timeouts are disabled (API server controls via timeoutSeconds)`,
            timeoutMs
          );
          // Settle BEFORE tearing the socket down: `req.destroy()` emits 'error'/'close', and the
          // caller must see the timeout — not the ECONNRESET our own abort produced. The latch makes
          // that teardown a no-op.
          settle(() => reject(timeoutError));
          req.destroy();
        }, timeoutMs);

        // Belt and braces for the pre-connect phase. The wall-clock timer above is armed
        // synchronously, so it already covers a DNS or TCP/TLS connect that never completes — but it
        // can only bound the caller's `await`; it cannot guarantee the runtime actually releases a
        // socket still stuck in connect. `setTimeout` on the request tears that socket down from the
        // inside. It is an IDLE timer, so on a live connection it can never fire before the wall
        // clock, which means it never shortens a legitimately slow request.
        req.setTimeout(timeoutMs, () => {
          req.destroy();
        });
      }

      // Handle abort signal (if available - added in newer versions).
      //
      // `{ once: true }` alone is NOT enough to bound the listener's lifetime: it removes the
      // listener when the event FIRES, and the overwhelmingly common case is that it never fires
      // because the request succeeded. A caller's signal typically spans a whole converge — hundreds
      // of requests — so every completed request left its closure (and the `req` it captures)
      // attached, growing the signal's listener list for the life of the operation. Detaching is
      // therefore done by the latch, which every terminal path goes through, with `{ once: true }`
      // kept as belt and braces for the firing case.
      // Call it ON the request: in @kubernetes/client-node >= 1.4 `RequestContext.getSignal()` is a
      // prototype method that reads `this.signal`, so a detached call throws "undefined is not an
      // object (evaluating 'this.signal')" on every request. (Before 1.4 the method did not exist,
      // which is why a detached `getSignal?.()` used to be a harmless no-op.)
      const getSignal = Reflect.get(request, 'getSignal') as
        | ((this: unknown) => AbortSignal | undefined)
        | undefined;
      const signal = typeof getSignal === 'function' ? getSignal.call(request) : undefined;
      if (signal) {
        const onAbort = () => {
          settle(() => reject(signal.reason ?? new Error('Request aborted')));
          req.destroy();
        };
        // An ALREADY-aborted signal never fires 'abort' again, so a listener alone silently misses
        // it and the request goes out anyway — the exact opposite of what the caller asked for.
        // A signal is routinely already aborted by the time a request is issued: a converge-wide
        // signal trips while an earlier call is in flight, and the next call in the queue is built
        // against it. Reject up front and tear the half-built request down BEFORE `req.end()` puts
        // any bytes on the wire.
        if (signal.aborted) {
          settle(() =>
            reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'))
          );
          req.destroy();
        } else {
          signal.addEventListener('abort', onAbort, { once: true });
          detachAbort = () => signal.removeEventListener('abort', onAbort);
        }
      }

      // Another copy of this read answered first (see `sendHedged`): drop this one. Its rejection is
      // swallowed there and never reaches a caller.
      const { cancel } = attempt;
      if (cancel && !settled) {
        const onCancel = () => {
          settle(() => reject(new SupersededAttemptError()));
          req.destroy();
        };
        cancel.addEventListener('abort', onCancel, { once: true });
        detachCancel = () => cancel.removeEventListener('abort', onCancel);
      }

      // The request ended without the promise having settled. On Bun this fires as soon as the
      // response headers land, so it is only terminal while NO response has started; after that the
      // response's own 'aborted'/'error'/'close' are the terminal events. Either way the timer stays
      // armed until something settles — clearing it here WITHOUT settling was the hang.
      req.on('close', () => {
        if (responseStarted) return;
        failPrematureClose('the socket closed before any response was received');
      });

      // Send body if present.
      //
      // These can throw SYNCHRONOUSLY — `write` rejects a body that is not a string or Buffer with
      // ERR_INVALID_ARG_TYPE, for instance. A throw here escapes the Promise executor, which rejects
      // the promise for us but does NOT run the latch, so the timer would stay armed and hold a
      // short-lived CLI process open for its whole budget after the call had already failed. Route
      // it through the latch instead, and tear the half-issued request down.
      //
      // A signal that was ALREADY aborted has settled the promise and destroyed the request above;
      // there is nothing left to send, and writing to a destroyed request would only raise a
      // spurious ERR_STREAM_DESTROYED. Returning here is also what keeps the promise's contract
      // honest: the server never sees a request the caller had already cancelled.
      if (settled) return;
      try {
        if (body) {
          req.write(body);
        }
        req.end();
      } catch (err) {
        settle(() => reject(err));
        req.destroy();
      }
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
