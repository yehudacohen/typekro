import { describe, expect, it } from 'bun:test';
import {
  BunCompatibleHttpLibrary,
  getHttpLibraryForRuntime,
  isBunRuntime,
} from '../../../src/core/kubernetes/bun-http-library.js';
import { isRequestTimeoutError } from '../../../src/core/deployment/poll-timeout.js';

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
