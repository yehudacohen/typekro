/**
 * Property-based tests for Kubernetes error handling utilities
 *
 * **Feature: upgrade-kubernetes-client, Property 1: Error Handling Consistency**
 * **Validates: Requirements 2.1, 2.4**
 */

import { describe, expect, it } from 'bun:test';
import * as fc from 'fast-check';
import {
  getErrorStatusCode,
  isNotFoundError,
  isConflictError,
  isRetryableError,
  formatKubernetesError,
  isUnauthorizedError,
  isForbiddenError,
  isBadRequestError,
  isValidationError,
  getErrorReason,
  getErrorDetails,
} from '../../../src/core/kubernetes/errors.js';

describe('Kubernetes Error Handling Utilities', () => {
  describe('getErrorStatusCode', () => {
    /**
     * **Feature: upgrade-kubernetes-client, Property 1: Error Handling Consistency**
     * **Validates: Requirements 2.1, 2.4**
     *
     * For any API error response with a status code, the error handling code
     * SHALL extract the status code correctly regardless of the error structure.
     */
    it('should extract status code from direct statusCode property (0.x style)', () => {
      fc.assert(
        fc.property(fc.integer({ min: 100, max: 599 }), (statusCode) => {
          const error = { statusCode };
          expect(getErrorStatusCode(error)).toBe(statusCode);
        }),
        { numRuns: 100 }
      );
    });

    it('should extract status code from response.statusCode (1.x+ fetch style)', () => {
      fc.assert(
        fc.property(fc.integer({ min: 100, max: 599 }), (statusCode) => {
          const error = { response: { statusCode } };
          expect(getErrorStatusCode(error)).toBe(statusCode);
        }),
        { numRuns: 100 }
      );
    });

    it('should extract status code from body.code', () => {
      fc.assert(
        fc.property(fc.integer({ min: 100, max: 599 }), (code) => {
          const error = { body: { code } };
          expect(getErrorStatusCode(error)).toBe(code);
        }),
        { numRuns: 100 }
      );
    });

    it('should prioritize direct statusCode over nested properties', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 100, max: 599 }),
          fc.integer({ min: 100, max: 599 }),
          fc.integer({ min: 100, max: 599 }),
          (directCode, responseCode, bodyCode) => {
            const error = {
              statusCode: directCode,
              response: { statusCode: responseCode },
              body: { code: bodyCode },
            };
            // Direct statusCode should take priority
            expect(getErrorStatusCode(error)).toBe(directCode);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should return undefined for non-object errors', () => {
      expect(getErrorStatusCode(null)).toBeUndefined();
      expect(getErrorStatusCode(undefined)).toBeUndefined();
      expect(getErrorStatusCode('error string')).toBeUndefined();
      expect(getErrorStatusCode(123)).toBeUndefined();
      expect(getErrorStatusCode(true)).toBeUndefined();
    });

    it('should return undefined for objects without status code', () => {
      expect(getErrorStatusCode({})).toBeUndefined();
      expect(getErrorStatusCode({ message: 'error' })).toBeUndefined();
      expect(getErrorStatusCode({ response: {} })).toBeUndefined();
      expect(getErrorStatusCode({ body: {} })).toBeUndefined();
    });
  });

  describe('isNotFoundError', () => {
    it('should return true for 404 errors', () => {
      expect(isNotFoundError({ statusCode: 404 })).toBe(true);
      expect(isNotFoundError({ response: { statusCode: 404 } })).toBe(true);
      expect(isNotFoundError({ body: { code: 404 } })).toBe(true);
    });

    it('should return false for non-404 errors', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 100, max: 599 }).filter((n) => n !== 404),
          (statusCode) => {
            expect(isNotFoundError({ statusCode })).toBe(false);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('isConflictError', () => {
    it('should return true for 409 errors', () => {
      expect(isConflictError({ statusCode: 409 })).toBe(true);
      expect(isConflictError({ response: { statusCode: 409 } })).toBe(true);
      expect(isConflictError({ body: { code: 409 } })).toBe(true);
    });

    it('should return false for non-409 errors', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 100, max: 599 }).filter((n) => n !== 409),
          (statusCode) => {
            expect(isConflictError({ statusCode })).toBe(false);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('isRetryableError', () => {
    const retryableStatusCodes = [408, 429, 500, 502, 503, 504];

    it('should return true for retryable HTTP status codes', () => {
      for (const statusCode of retryableStatusCodes) {
        expect(isRetryableError({ statusCode })).toBe(true);
        expect(isRetryableError({ response: { statusCode } })).toBe(true);
      }
    });

    it('should return false for non-retryable HTTP status codes', () => {
      const nonRetryableCodes = [200, 201, 400, 401, 403, 404, 409, 422];
      for (const statusCode of nonRetryableCodes) {
        expect(isRetryableError({ statusCode })).toBe(false);
      }
    });

    it('should return true for network errors', () => {
      expect(isRetryableError(new Error('ECONNREFUSED'))).toBe(true);
      expect(isRetryableError(new Error('ENOTFOUND'))).toBe(true);
      expect(isRetryableError(new Error('ETIMEDOUT'))).toBe(true);
      expect(isRetryableError(new Error('network error'))).toBe(true);
      expect(isRetryableError(new Error('socket hang up'))).toBe(true);
      expect(isRetryableError(new Error('connection reset'))).toBe(true);
    });

    it('should return true for AbortError', () => {
      const abortError = new Error('Aborted');
      abortError.name = 'AbortError';
      expect(isRetryableError(abortError)).toBe(true);
    });

    it('should return false for client errors', () => {
      expect(isRetryableError({ statusCode: 400 })).toBe(false);
      expect(isRetryableError({ statusCode: 401 })).toBe(false);
      expect(isRetryableError({ statusCode: 403 })).toBe(false);
      expect(isRetryableError({ statusCode: 404 })).toBe(false);
    });
  });

  describe('formatKubernetesError', () => {
    it('should format error with status code', () => {
      const error = { statusCode: 404, message: 'Not Found' };
      const formatted = formatKubernetesError(error);
      expect(formatted).toContain('404');
      expect(formatted).toContain('Not Found');
    });

    it('should format error with body reason and message', () => {
      const error = {
        statusCode: 409,
        body: {
          reason: 'AlreadyExists',
          message: 'Resource already exists',
        },
      };
      const formatted = formatKubernetesError(error);
      expect(formatted).toContain('409');
      expect(formatted).toContain('AlreadyExists');
      expect(formatted).toContain('Resource already exists');
    });

    it('should handle non-object errors', () => {
      expect(formatKubernetesError('string error')).toBe('string error');
      expect(formatKubernetesError(null)).toBe('null');
      expect(formatKubernetesError(undefined)).toBe('undefined');
    });
  });

  describe('Status code helper functions', () => {
    it('isUnauthorizedError should detect 401', () => {
      expect(isUnauthorizedError({ statusCode: 401 })).toBe(true);
      expect(isUnauthorizedError({ statusCode: 403 })).toBe(false);
    });

    it('isForbiddenError should detect 403', () => {
      expect(isForbiddenError({ statusCode: 403 })).toBe(true);
      expect(isForbiddenError({ statusCode: 401 })).toBe(false);
    });

    it('isBadRequestError should detect 400', () => {
      expect(isBadRequestError({ statusCode: 400 })).toBe(true);
      expect(isBadRequestError({ statusCode: 422 })).toBe(false);
    });

    it('isValidationError should detect 422', () => {
      expect(isValidationError({ statusCode: 422 })).toBe(true);
      expect(isValidationError({ statusCode: 400 })).toBe(false);
    });
  });

  describe('getErrorReason', () => {
    it('should extract reason from body', () => {
      const error = { body: { reason: 'NotFound' } };
      expect(getErrorReason(error)).toBe('NotFound');
    });

    it('should return undefined when no reason', () => {
      expect(getErrorReason({})).toBeUndefined();
      expect(getErrorReason({ body: {} })).toBeUndefined();
      expect(getErrorReason(null)).toBeUndefined();
    });
  });

  describe('getErrorDetails', () => {
    it('should extract all available details', () => {
      const error = {
        statusCode: 404,
        body: {
          reason: 'NotFound',
          message: 'Resource not found',
          details: { name: 'my-resource' },
        },
      };
      const details = getErrorDetails(error);
      expect(details.statusCode).toBe(404);
      expect(details.reason).toBe('NotFound');
      expect(details.message).toBe('Resource not found');
      expect(details.details).toEqual({ name: 'my-resource' });
    });

    it('should handle missing properties gracefully', () => {
      const details = getErrorDetails({});
      expect(details.statusCode).toBeUndefined();
      expect(details.reason).toBeUndefined();
      expect(details.message).toBeUndefined();
      expect(details.details).toBeUndefined();
    });

    it('should handle non-object errors', () => {
      const details = getErrorDetails('error string');
      expect(details.message).toBe('error string');
    });
  });
});
