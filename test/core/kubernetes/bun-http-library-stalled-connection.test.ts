/**
 * A connection that stalls before the server answers.
 *
 * Two shapes are covered. An IDLE pooled connection that a load balancer has silently dropped
 * (an NLB forgets a flow after ~350s idle and blackholes whatever is sent on it next), and a FRESH
 * connection that is lost on the way (a handshake or request the network swallowed). Both look the
 * same to the client: bytes go out and nothing ever comes back, so the read hangs for its whole
 * budget unless something sends it again on another connection.
 */
import { describe, expect, it } from 'bun:test';
import * as net from 'node:net';
import { isRequestTimeoutError } from '../../../src/core/deployment/poll-timeout.js';
import { BunCompatibleHttpLibrary } from '../../../src/core/kubernetes/bun-http-library.js';

/** What the fake server does with the requests on one connection. */
type ConnectionBehaviour =
  /** Read the request and never answer, never close. */
  | 'blackhole'
  /** Answer after `delayMs` (headers and body together), keeping the connection open. */
  | { readonly delayMs: number }
  /** Send headers at once and the body after `bodyDelayMs`. */
  | { readonly headersThenBodyAfterMs: number };

interface FakeServer {
  readonly port: number;
  /** Connections accepted so far. */
  connections(): number;
  /** Connections that have been closed (by either side). */
  closed(): number;
  close(): Promise<void>;
}

const BODY = '{"kind":"Namespace","metadata":{"name":"demo"}}';
const HEADERS = `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${BODY.length}\r\n\r\n`;

/**
 * A raw TCP server speaking just enough HTTP/1.1 keep-alive. `behaviour(n)` picks what connection
 * number `n` (0-based) does. With `idleBlackholeMs`, a connection that has been idle that long is
 * forgotten, as a load balancer forgets an idle flow: later requests on it are read and dropped.
 */
async function fakeServer(
  behaviour: (connection: number) => ConnectionBehaviour,
  options: { readonly idleBlackholeMs?: number } = {}
): Promise<FakeServer> {
  let accepted = 0;
  let closed = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    const mode = behaviour(accepted++);
    sockets.add(socket);
    socket.on('error', () => undefined); // the client's teardown is expected
    socket.on('close', () => {
      closed++;
      sockets.delete(socket);
    });
    let lastActivity = Date.now();
    let buffered = '';
    socket.on('data', (chunk) => {
      const idleFor = Date.now() - lastActivity;
      lastActivity = Date.now();
      if (options.idleBlackholeMs !== undefined && idleFor >= options.idleBlackholeMs) {
        return; // the flow was forgotten while idle: swallow everything
      }
      buffered += chunk.toString();
      while (buffered.includes('\r\n\r\n')) {
        buffered = buffered.slice(buffered.indexOf('\r\n\r\n') + 4);
        if (mode === 'blackhole') return;
        if ('delayMs' in mode) {
          setTimeout(() => {
            lastActivity = Date.now();
            socket.write(HEADERS + BODY);
          }, mode.delayMs);
        } else {
          socket.write(HEADERS);
          setTimeout(() => {
            lastActivity = Date.now();
            socket.write(BODY);
          }, mode.headersThenBodyAfterMs);
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    port: typeof address === 'object' && address ? address.port : 0,
    connections: () => accepted,
    closed: () => closed,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

function requestContext(port: number, options: { method?: string; query?: string } = {}) {
  return {
    getUrl: () => `http://127.0.0.1:${port}/api/v1/namespaces/demo${options.query ?? ''}`,
    getHttpMethod: () => options.method ?? 'GET',
    getHeaders: () => ({}),
    getBody: () => undefined,
    getAgent: () => undefined,
  };
}

/** Resolve to the settlement, or to {@link HUNG} if the promise has not settled by `watchdogMs`. */
const HUNG = Symbol('never settled');
async function settleWithin(
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function send(library: BunCompatibleHttpLibrary, request: ReturnType<typeof requestContext>) {
  return library.send(request as never).toPromise();
}

function statusOf(outcome: unknown): number | undefined {
  return (outcome as { httpStatusCode?: number } | undefined)?.httpStatusCode;
}

describe('an idle connection a load balancer has dropped', () => {
  /**
   * The fake server must reproduce the failure, or the next test proves nothing: on a REUSED
   * connection that sat idle past the cutoff, a request goes out and no answer ever comes back.
   */
  it('blackholes a request sent on a connection after it sat idle', async () => {
    const server = await fakeServer(() => ({ delayMs: 0 }), { idleBlackholeMs: 100 });
    const socket = net.connect(server.port, '127.0.0.1');
    try {
      await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
      const responses: string[] = [];
      socket.on('data', (chunk) => responses.push(chunk.toString()));
      const request = 'GET /api/v1/namespaces/demo HTTP/1.1\r\nHost: x\r\n\r\n';

      socket.write(request);
      await sleep(50);
      expect(responses.join('')).toContain('200 OK');

      responses.length = 0;
      await sleep(150); // idle past the cutoff
      socket.write(request);
      await sleep(300);
      expect(responses).toEqual([]);
    } finally {
      socket.destroy();
      await server.close();
    }
  });

  it('cannot stall a later read, because every request has its own connection', async () => {
    const server = await fakeServer(() => ({ delayMs: 0 }), { idleBlackholeMs: 100 });
    try {
      const library = new BunCompatibleHttpLibrary({ default: 2_000, readHedgeDelay: 0 });

      expect(statusOf(await send(library, requestContext(server.port)))).toBe(200);
      await sleep(250); // idle past the cutoff
      const { outcome, elapsedMs } = await settleWithin(
        send(library, requestContext(server.port)),
        1_500
      );

      expect(outcome).not.toBe(HUNG);
      expect(statusOf(outcome)).toBe(200);
      expect(elapsedMs).toBeLessThan(500);
      expect(server.connections()).toBe(2);
    } finally {
      await server.close();
    }
  });
});

describe('a read whose connection stalls before the server answers', () => {
  it('is answered by a second copy on a new connection, long before the budget', async () => {
    // The first connection swallows the request; every later one answers.
    const server = await fakeServer((n) => (n === 0 ? 'blackhole' : { delayMs: 0 }));
    try {
      const library = new BunCompatibleHttpLibrary({ default: 5_000, readHedgeDelay: 100 });
      const { outcome, elapsedMs } = await settleWithin(
        send(library, requestContext(server.port)),
        3_000
      );

      expect(statusOf(outcome)).toBe(200);
      expect(elapsedMs).toBeGreaterThanOrEqual(90);
      expect(elapsedMs).toBeLessThan(1_000);
      expect(server.connections()).toBe(2);
      // The abandoned first copy is torn down, not left open for its whole budget.
      await sleep(100);
      expect(server.closed()).toBe(2);
    } finally {
      await server.close();
    }
  });

  it('keeps the first copy when it answers after the second was sent but before it', async () => {
    // Slow, not stalled: the first answers at 250ms; the second would take 2s.
    const server = await fakeServer((n) => ({ delayMs: n === 0 ? 250 : 2_000 }));
    try {
      const library = new BunCompatibleHttpLibrary({ default: 5_000, readHedgeDelay: 100 });
      const { outcome, elapsedMs } = await settleWithin(
        send(library, requestContext(server.port)),
        3_000
      );

      expect(statusOf(outcome)).toBe(200);
      expect(elapsedMs).toBeLessThan(1_000);
      expect(server.connections()).toBe(2);
    } finally {
      await server.close();
    }
  });

  it('sends no second copy when the headers arrive in time, however slow the body', async () => {
    const server = await fakeServer(() => ({ headersThenBodyAfterMs: 400 }));
    try {
      const library = new BunCompatibleHttpLibrary({ default: 5_000, readHedgeDelay: 100 });
      expect(statusOf(await send(library, requestContext(server.port)))).toBe(200);
      expect(server.connections()).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('still fails within the read budget, with the request timeout, when every copy stalls', async () => {
    const server = await fakeServer(() => 'blackhole');
    try {
      const library = new BunCompatibleHttpLibrary({ default: 400, readHedgeDelay: 100 });
      const { outcome, elapsedMs } = await settleWithin(
        send(library, requestContext(server.port)),
        3_000
      );

      expect(outcome).not.toBe(HUNG);
      expect(isRequestTimeoutError(outcome)).toBe(true);
      expect((outcome as Error).message).toContain('timed out after 400ms');
      expect(elapsedMs).toBeLessThan(900); // one budget, not two
      expect(server.connections()).toBe(2);
    } finally {
      await server.close();
    }
  });

  it('never duplicates a write', async () => {
    const server = await fakeServer(() => 'blackhole');
    try {
      const library = new BunCompatibleHttpLibrary({ create: 400, readHedgeDelay: 100 });
      const { outcome } = await settleWithin(
        send(library, requestContext(server.port, { method: 'POST' })),
        3_000
      );

      expect(isRequestTimeoutError(outcome)).toBe(true);
      expect(server.connections()).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('never duplicates a watch', async () => {
    const server = await fakeServer(() => 'blackhole');
    try {
      const library = new BunCompatibleHttpLibrary({ readHedgeDelay: 100 });
      const pending = send(library, requestContext(server.port, { query: '?watch=true' }));
      pending.catch(() => undefined);
      await sleep(400);
      expect(server.connections()).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('tears both copies down when the caller aborts', async () => {
    const server = await fakeServer(() => 'blackhole');
    try {
      const library = new BunCompatibleHttpLibrary({ default: 5_000, readHedgeDelay: 100 });
      const controller = new AbortController();
      const request = { ...requestContext(server.port), getSignal: () => controller.signal };
      const pending = settleWithin(library.send(request as never).toPromise(), 3_000);
      await sleep(250); // both copies are in flight
      controller.abort(new Error('converge cancelled'));
      const { outcome, elapsedMs } = await pending;

      expect((outcome as Error).message).toBe('converge cancelled');
      expect(elapsedMs).toBeLessThan(1_000);
      await sleep(100);
      expect(server.connections()).toBe(2);
      expect(server.closed()).toBe(2);
    } finally {
      await server.close();
    }
  });
});
