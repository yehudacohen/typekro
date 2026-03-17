import { describe, expect, it } from 'bun:test';
import {
  hasBody,
  hasResourceVersion,
  hasStatusCode,
  isKubernetesError,
  isKubernetesList,
  isKubernetesResource,
  isKubernetesResponse,
} from '../../../src/core/kubernetes/type-guards.js';

describe('Kubernetes Type Guards', () => {
  // =========================================================================
  // isKubernetesResponse
  // =========================================================================
  describe('isKubernetesResponse', () => {
    it('returns true for object with body property', () => {
      expect(isKubernetesResponse({ body: { kind: 'Deployment' } })).toBe(true);
    });

    it('returns true when body is null', () => {
      expect(isKubernetesResponse({ body: null })).toBe(true);
    });

    it('returns true when body is a primitive', () => {
      expect(isKubernetesResponse({ body: 'text' })).toBe(true);
    });

    it('returns true when response has additional properties', () => {
      expect(
        isKubernetesResponse({
          body: {},
          response: { statusCode: 200, headers: {} },
        })
      ).toBe(true);
    });

    it('returns false for null', () => {
      expect(isKubernetesResponse(null)).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(isKubernetesResponse(undefined)).toBe(false);
    });

    it('returns false for primitives', () => {
      expect(isKubernetesResponse('string')).toBe(false);
      expect(isKubernetesResponse(42)).toBe(false);
      expect(isKubernetesResponse(true)).toBe(false);
    });

    it('returns false for object without body', () => {
      expect(isKubernetesResponse({ status: 200 })).toBe(false);
    });

    it('returns false for empty object', () => {
      expect(isKubernetesResponse({})).toBe(false);
    });
  });

  // =========================================================================
  // isKubernetesError
  // =========================================================================
  describe('isKubernetesError', () => {
    it('returns true for error with statusCode', () => {
      expect(isKubernetesError({ statusCode: 404 })).toBe(true);
    });

    it('returns true for error with response.statusCode', () => {
      expect(isKubernetesError({ response: { statusCode: 500 } })).toBe(true);
    });

    it('returns true for error with body.code', () => {
      expect(isKubernetesError({ body: { code: 403 } })).toBe(true);
    });

    it('returns true when multiple error indicators present', () => {
      expect(
        isKubernetesError({
          statusCode: 409,
          response: { statusCode: 409 },
          body: { code: 409 },
        })
      ).toBe(true);
    });

    it('returns false for null', () => {
      expect(isKubernetesError(null)).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(isKubernetesError(undefined)).toBe(false);
    });

    it('returns false for primitives', () => {
      expect(isKubernetesError('error')).toBe(false);
      expect(isKubernetesError(404)).toBe(false);
    });

    it('returns false for object without error properties', () => {
      expect(isKubernetesError({ message: 'something broke' })).toBe(false);
    });

    it('returns false when statusCode is not a number', () => {
      expect(isKubernetesError({ statusCode: '404' })).toBe(false);
    });

    it('returns false when body.code is not a number', () => {
      expect(isKubernetesError({ body: { code: 'NotFound' } })).toBe(false);
    });

    it('returns false when response is null', () => {
      expect(isKubernetesError({ response: null })).toBe(false);
    });

    it('returns false when body is null', () => {
      expect(isKubernetesError({ body: null })).toBe(false);
    });
  });

  // =========================================================================
  // hasStatusCode
  // =========================================================================
  describe('hasStatusCode', () => {
    it('returns true for object with numeric statusCode', () => {
      expect(hasStatusCode({ statusCode: 200 })).toBe(true);
      expect(hasStatusCode({ statusCode: 404 })).toBe(true);
      expect(hasStatusCode({ statusCode: 0 })).toBe(true);
    });

    it('returns false for string statusCode', () => {
      expect(hasStatusCode({ statusCode: '200' })).toBe(false);
    });

    it('returns false for null', () => {
      expect(hasStatusCode(null)).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(hasStatusCode(undefined)).toBe(false);
    });

    it('returns false for empty object', () => {
      expect(hasStatusCode({})).toBe(false);
    });

    it('returns false for primitives', () => {
      expect(hasStatusCode(42)).toBe(false);
      expect(hasStatusCode('str')).toBe(false);
    });
  });

  // =========================================================================
  // isKubernetesResource
  // =========================================================================
  describe('isKubernetesResource', () => {
    it('returns true for full resource', () => {
      expect(
        isKubernetesResource({
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: { name: 'test', namespace: 'default' },
          spec: { replicas: 3 },
          status: { readyReplicas: 3 },
        })
      ).toBe(true);
    });

    it('returns true for resource with only kind and apiVersion', () => {
      expect(isKubernetesResource({ apiVersion: 'v1', kind: 'Service' })).toBe(true);
    });

    it('returns true for empty object (all fields optional)', () => {
      // The guard allows all fields to be undefined
      expect(isKubernetesResource({})).toBe(true);
    });

    it('returns true when metadata is an object', () => {
      expect(isKubernetesResource({ metadata: { name: 'test' } })).toBe(true);
    });

    it('returns false for null', () => {
      expect(isKubernetesResource(null)).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(isKubernetesResource(undefined)).toBe(false);
    });

    it('returns false for primitives', () => {
      expect(isKubernetesResource('string')).toBe(false);
      expect(isKubernetesResource(123)).toBe(false);
    });

    it('returns false when apiVersion is a number', () => {
      expect(isKubernetesResource({ apiVersion: 1, kind: 'Test' })).toBe(false);
    });

    it('returns false when kind is a number', () => {
      expect(isKubernetesResource({ apiVersion: 'v1', kind: 42 })).toBe(false);
    });

    it('returns false when metadata is a string', () => {
      expect(isKubernetesResource({ metadata: 'bad' })).toBe(false);
    });
  });

  // =========================================================================
  // hasBody
  // =========================================================================
  describe('hasBody', () => {
    const isString = (v: unknown): v is string => typeof v === 'string';
    const isNumber = (v: unknown): v is number => typeof v === 'number';

    it('returns true when body passes the guard', () => {
      expect(hasBody({ body: 'hello' }, isString)).toBe(true);
      expect(hasBody({ body: 42 }, isNumber)).toBe(true);
    });

    it('returns false when body fails the guard', () => {
      expect(hasBody({ body: 42 }, isString)).toBe(false);
      expect(hasBody({ body: 'hello' }, isNumber)).toBe(false);
    });

    it('returns false when there is no body', () => {
      expect(hasBody({ other: 'value' }, isString)).toBe(false);
    });

    it('returns false for null', () => {
      expect(hasBody(null, isString)).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(hasBody(undefined, isString)).toBe(false);
    });

    it('returns false for primitives', () => {
      expect(hasBody('string', isString)).toBe(false);
    });

    it('works with isKubernetesResource as body guard', () => {
      expect(hasBody({ body: { apiVersion: 'v1', kind: 'Pod' } }, isKubernetesResource)).toBe(true);

      expect(hasBody({ body: 'not a resource' }, isKubernetesResource)).toBe(false);
    });
  });

  // =========================================================================
  // isKubernetesList
  // =========================================================================
  describe('isKubernetesList', () => {
    it('returns true for object with items array', () => {
      expect(isKubernetesList({ items: [] })).toBe(true);
      expect(isKubernetesList({ items: [{ kind: 'Pod' }] })).toBe(true);
    });

    it('returns true for list with metadata', () => {
      expect(
        isKubernetesList({
          items: [],
          metadata: { resourceVersion: '12345' },
        })
      ).toBe(true);
    });

    it('returns false when items is not an array', () => {
      expect(isKubernetesList({ items: 'not-array' })).toBe(false);
      expect(isKubernetesList({ items: {} })).toBe(false);
      expect(isKubernetesList({ items: 42 })).toBe(false);
    });

    it('returns false for null', () => {
      expect(isKubernetesList(null)).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(isKubernetesList(undefined)).toBe(false);
    });

    it('returns false for empty object', () => {
      expect(isKubernetesList({})).toBe(false);
    });

    it('returns false for primitives', () => {
      expect(isKubernetesList('list')).toBe(false);
    });
  });

  // =========================================================================
  // hasResourceVersion
  // =========================================================================
  describe('hasResourceVersion', () => {
    it('returns true for object with metadata.resourceVersion string', () => {
      expect(hasResourceVersion({ metadata: { resourceVersion: '12345' } })).toBe(true);
    });

    it('returns true for full resource with resourceVersion', () => {
      expect(
        hasResourceVersion({
          apiVersion: 'v1',
          kind: 'Pod',
          metadata: {
            name: 'test',
            resourceVersion: '98765',
          },
        })
      ).toBe(true);
    });

    it('returns false when resourceVersion is a number', () => {
      expect(hasResourceVersion({ metadata: { resourceVersion: 12345 } })).toBe(false);
    });

    it('returns false when metadata is missing', () => {
      expect(hasResourceVersion({})).toBe(false);
    });

    it('returns false when metadata is null', () => {
      expect(hasResourceVersion({ metadata: null })).toBe(false);
    });

    it('returns false when metadata is a string', () => {
      expect(hasResourceVersion({ metadata: 'invalid' })).toBe(false);
    });

    it('returns false when resourceVersion is missing from metadata', () => {
      expect(hasResourceVersion({ metadata: { name: 'test' } })).toBe(false);
    });

    it('returns false for null', () => {
      expect(hasResourceVersion(null)).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(hasResourceVersion(undefined)).toBe(false);
    });

    it('returns false for primitives', () => {
      expect(hasResourceVersion('str')).toBe(false);
      expect(hasResourceVersion(42)).toBe(false);
    });
  });
});
