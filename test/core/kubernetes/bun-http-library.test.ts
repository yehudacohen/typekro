import { describe, expect, it } from 'bun:test';
import * as net from 'node:net';
import {
  BunCompatibleHttpLibrary,
  getHttpLibraryForRuntime,
  isBunRuntime,
  PrematureCloseError,
} from '../../../src/core/kubernetes/bun-http-library.js';
import { isRequestTimeoutError } from '../../../src/core/deployment/poll-timeout.js';
import { classifyApiReadError } from '../../../src/core/deployment/k8s-helpers.js';

describe('bun-http-library', () => {
  // =========================================================================
  // isBunRuntime
  // =========================================================================
  describe('isBunRuntime', () => {
    it('returns true when running in Bun', () => {
      // We are running under Bun test runner
      expect(isBunRuntime()).toBe(true);
    });
  });

  // =========================================================================
  // getHttpLibraryForRuntime
  // =========================================================================
  describe('getHttpLibraryForRuntime', () => {
    it('returns BunCompatibleHttpLibrary when in Bun', () => {
      const lib = getHttpLibraryForRuntime();
      expect(lib).toBeInstanceOf(BunCompatibleHttpLibrary);
    });

    it('accepts custom timeout config', () => {
      const lib = getHttpLibraryForRuntime({ default: 5000, watch: 10000 });
      expect(lib).toBeInstanceOf(BunCompatibleHttpLibrary);
    });
  });

  // =========================================================================
  // BunCompatibleHttpLibrary
  // =========================================================================
  describe('BunCompatibleHttpLibrary', () => {
    it('can be constructed with no arguments', () => {
      const lib = new BunCompatibleHttpLibrary();
      expect(lib).toBeInstanceOf(BunCompatibleHttpLibrary);
    });

    it('can be constructed with partial timeout config', () => {
      const lib = new BunCompatibleHttpLibrary({ default: 5000 });
      expect(lib).toBeInstanceOf(BunCompatibleHttpLibrary);
    });

    it('can be constructed with full timeout config', () => {
      const lib = new BunCompatibleHttpLibrary({
        default: 5000,
        watch: 60000,
        create: 30000,
        update: 30000,
        delete: 45000,
      });
      expect(lib).toBeInstanceOf(BunCompatibleHttpLibrary);
    });

    it('implements HttpLibrary interface (has send method)', () => {
      const lib = new BunCompatibleHttpLibrary();
      expect(typeof lib.send).toBe('function');
    });
  });
});

describe('BunCompatibleHttpLibrary request timeout', () => {
  /**
   * The socket timer is armed SYNCHRONOUSLY while the request is issued, so with equal budgets it
   * fires BEFORE any deadline wrapper around the call — it is the error callers actually see. It
   * must therefore be recognisable as a timeout, or a gate that fails OPEN on ordinary errors
   * (the singleton-owner spec-drift check) silently skips its assertion on a wedged credential.
   */
  it('rejects a server that never answers with a recognisable request timeout', async () => {
    const http = await import('node:http');
    // Accept the connection and never reply — a half-open request, not a refused one.
    const server = http.createServer(() => undefined);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    try {
      const library = new BunCompatibleHttpLibrary({ default: 50 });
      const request = {
        getUrl: () => `http://127.0.0.1:${port}/api/v1/namespaces/demo`,
        getHttpMethod: () => 'GET',
        getHeaders: () => ({}),
        getBody: () => undefined,
        getAgent: () => undefined,
      };

      const failure = await library
        .send(request as never)
        .toPromise()
        .then(
          () => new Error('request unexpectedly succeeded'),
          (error: unknown) => error
        );

      expect(isRequestTimeoutError(failure)).toBe(true);
      expect((failure as Error).message).toContain('HTTP request timeout');
      expect((failure as { timeoutMs?: number }).timeoutMs).toBe(50);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

/**
 * PREMATURE CLOSE — the promise must settle on EVERY terminal event.
 *
 * The failure these cover is a HANG, not a wrong answer: the request's wall-clock timer used to be
 * cleared by the request's 'close' event without the promise being settled, so once the timer was
 * gone nothing could ever reject. Bun makes that fatal because it emits the REQUEST's 'close' as soon
 * as the response HEADERS arrive — before the body — and then reports a mid-body socket drop only on
 * the RESPONSE ('aborted' / 'error' / 'close'), which nothing listened to. Node emits the request's
 * 'close' after the exchange ends, so the same code merely disarms the timer a little later and hangs
 * too; Bun just reaches the hang on every truncated response.
 *
 * Each test therefore races the call against a watchdog FAR longer than the configured timeout: a
 * regression shows up as the watchdog winning, never as a slow pass.
 */
describe('BunCompatibleHttpLibrary premature close', () => {
  /** A raw TCP server, so a response can be truncated mid-flight (http.Server cannot do that). */
  async function rawServer(
    onRequestBytes: (socket: net.Socket) => void
  ): Promise<{ port: number; close: () => Promise<void> }> {
    const server = net.createServer((socket) => {
      socket.on('error', () => undefined); // the client's RST is expected
      socket.once('data', () => onRequestBytes(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    return {
      port: typeof address === 'object' && address ? address.port : 0,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  function requestContext(port: number, method = 'GET') {
    return {
      getUrl: () => `http://127.0.0.1:${port}/api/v1/namespaces/demo`,
      getHttpMethod: () => method,
      getHeaders: () => ({}),
      getBody: () => undefined,
      getAgent: () => undefined,
    };
  }

  /** Resolve to the settlement, or to the watchdog sentinel if the promise never settles. */
  const HUNG = Symbol('never settled');
  async function settleOrHang(
    promise: Promise<unknown>,
    watchdogMs: number
  ): Promise<{ outcome: unknown; elapsedMs: number }> {
    const startedAt = Date.now();
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      promise.then(
        (value) => value,
        (error: unknown) => error
      ),
      new Promise((resolve) => {
        watchdog = setTimeout(() => resolve(HUNG), watchdogMs);
      }),
    ]);
    if (watchdog) clearTimeout(watchdog);
    return { outcome, elapsedMs: Date.now() - startedAt };
  }

  // (a) The production symptom: headers and a partial body arrive, then the socket dies.
  it('rejects promptly when the socket dies mid-body instead of hanging forever', async () => {
    const server = await rawServer((socket) => {
      // A Content-Length the body will never reach, then a hard reset.
      socket.write(
        'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 400\r\n\r\n'
      );
      socket.write('{"kind":"Namespace","metadata":{"name":"demo"');
      setTimeout(() => socket.destroy(), 20);
    });
    try {
      // A 30s timeout the test cannot possibly be waiting on: only settling on the CLOSE can pass.
      const library = new BunCompatibleHttpLibrary({ default: 30_000 });
      const { outcome, elapsedMs } = await settleOrHang(
        library.send(requestContext(server.port) as never).toPromise() as Promise<unknown>,
        3_000
      );

      expect(outcome).not.toBe(HUNG);
      expect(elapsedMs).toBeLessThan(3_000);
      expect(outcome).toBeInstanceOf(PrematureCloseError);
      expect((outcome as Error).message).toContain('socket hang up');
      expect((outcome as Error).message).toContain('GET /api/v1/namespaces/demo');
      // Transport failure, so the transient classifiers must catch it: `code` for the system-error
      // path and `socket hang up` for the message path.
      expect((outcome as { code?: string }).code).toBe('ECONNRESET');
      expect(classifyApiReadError(outcome)).toBe('unreachable');
      // And it must NOT read as "the object does not exist" to a gate that fails open on 404.
      expect(classifyApiReadError(outcome)).not.toBe('notFound');
      // Recognisable to the request-timeout gates, which fail CLOSED on a call that never answered.
      expect(isRequestTimeoutError(outcome)).toBe(true);
    } finally {
      await server.close();
    }
  });

  // (a′) Same shape, but a graceful FIN rather than a reset, and a chunked body.
  it('rejects promptly when a chunked response is cut short by a FIN', async () => {
    const server = await rawServer((socket) => {
      socket.write('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n');
      socket.write('1a\r\n{"kind":"NamespaceList","i\r\n');
      setTimeout(() => socket.end(), 20);
    });
    try {
      const library = new BunCompatibleHttpLibrary({ default: 30_000 });
      const { outcome } = await settleOrHang(
        library.send(requestContext(server.port) as never).toPromise() as Promise<unknown>,
        3_000
      );

      expect(outcome).not.toBe(HUNG);
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toContain('socket hang up');
    } finally {
      await server.close();
    }
  });

  // (c) Nothing at all comes back — the connection is accepted and then dropped.
  it('rejects promptly when the connection is dropped before any response', async () => {
    const server = await rawServer((socket) => {
      setTimeout(() => socket.destroy(), 10);
    });
    try {
      const library = new BunCompatibleHttpLibrary({ default: 30_000 });
      const { outcome, elapsedMs } = await settleOrHang(
        library.send(requestContext(server.port) as never).toPromise() as Promise<unknown>,
        3_000
      );

      expect(outcome).not.toBe(HUNG);
      expect(elapsedMs).toBeLessThan(3_000);
      expect(outcome).toBeInstanceOf(Error);
      // Either the runtime's own socket error or our typed close error — both are transport
      // failures, and neither may be mistaken for a 404.
      expect(classifyApiReadError(outcome)).toBe('unreachable');
    } finally {
      await server.close();
    }
  });

  // (d) The happy path still resolves — and leaves no armed timer behind.
  it('resolves a normal 200 and clears the request timer', async () => {
    const server = await rawServer((socket) => {
      const payload = '{"kind":"Namespace","metadata":{"name":"demo"}}';
      socket.end(
        `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${payload.length}\r\nConnection: close\r\n\r\n${payload}`
      );
    });

    // A timeout value no other timer in the process would use, so the request's own timer can be
    // picked out of every setTimeout call and checked for a matching clearTimeout.
    const UNIQUE_TIMEOUT_MS = 987_654;
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const armed = new Set<unknown>();
    const cleared = new Set<unknown>();
    globalThis.setTimeout = ((handler: never, delay?: number, ...args: never[]) => {
      const handle = realSetTimeout(handler, delay as number, ...args);
      if (delay === UNIQUE_TIMEOUT_MS) armed.add(handle);
      return handle;
    }) as typeof globalThis.setTimeout;
    globalThis.clearTimeout = ((handle: never) => {
      cleared.add(handle);
      return realClearTimeout(handle);
    }) as typeof globalThis.clearTimeout;

    try {
      const library = new BunCompatibleHttpLibrary({ default: UNIQUE_TIMEOUT_MS });
      const response = (await library
        .send(requestContext(server.port) as never)
        .toPromise()) as unknown as {
        httpStatusCode: number;
        getBodyAsAny: () => Promise<{ kind: string }>;
      };

      expect(response.httpStatusCode).toBe(200);
      expect((await response.getBodyAsAny()).kind).toBe('Namespace');

      // The timer was armed, and it was disarmed — a leaked one would keep a CLI process alive for
      // its full budget after the work is done.
      expect(armed.size).toBe(1);
      for (const handle of armed) expect(cleared.has(handle)).toBe(true);
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
      await server.close();
    }
  });

  // The latch: a timeout tears the socket down itself, and that teardown must not produce a SECOND,
  // different rejection that masks the timeout.
  it('reports the timeout, not its own teardown, when the budget expires', async () => {
    const server = await rawServer(() => undefined); // accept, never answer
    try {
      const library = new BunCompatibleHttpLibrary({ default: 60 });
      const { outcome } = await settleOrHang(
        library.send(requestContext(server.port) as never).toPromise() as Promise<unknown>,
        3_000
      );

      expect(outcome).not.toBe(HUNG);
      expect(isRequestTimeoutError(outcome)).toBe(true);
      expect((outcome as Error).message).toContain('HTTP request timeout');
      expect((outcome as Error).message).not.toContain('socket hang up');
      expect((outcome as { timeoutMs?: number }).timeoutMs).toBe(60);
    } finally {
      await server.close();
    }
  });
});
