import { describe, expect, it } from 'bun:test';
import {
  BunCompatibleHttpLibrary,
  getHttpLibraryForRuntime,
  isBunRuntime,
} from '../../../src/core/kubernetes/bun-http-library.js';

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
