/**
 * Unit tests for src/core/deployment/k8s-helpers.ts
 *
 * Tests error classification, media type extraction, resource patching,
 * and resource enhancement utilities.
 */

import { describe, expect, it, type mock } from 'bun:test';
import {
  enhanceResourceForEvaluation,
  extractAcceptedMediaTypes,
  isNotFoundError,
  isUnsupportedMediaTypeError,
  patchResourceWithCorrectContentType,
} from '../../src/core/deployment/k8s-helpers.js';
import type { KubernetesApiError } from '../../src/core/types.js';
import { createK8sError, createMockK8sApi } from '../utils/mock-factories.js';

// =============================================================================
// isNotFoundError
// =============================================================================

describe('isNotFoundError', () => {
  it('returns true when statusCode is 404', () => {
    const error = createK8sError('Not Found', 404);
    expect(isNotFoundError(error)).toBe(true);
  });

  it('returns true when body.code is 404', () => {
    const error: KubernetesApiError = { body: { code: 404 } };
    expect(isNotFoundError(error)).toBe(true);
  });

  it('returns false for a 500 status code', () => {
    const error = createK8sError('Internal Server Error', 500);
    expect(isNotFoundError(error)).toBe(false);
  });

  it('returns false for a 415 status code', () => {
    const error = createK8sError('Unsupported Media Type', 415);
    expect(isNotFoundError(error)).toBe(false);
  });

  it('returns false for null', () => {
    expect(isNotFoundError(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isNotFoundError(undefined)).toBe(false);
  });

  it('returns false for a string', () => {
    expect(isNotFoundError('not found')).toBe(false);
  });

  it('returns false for a number', () => {
    expect(isNotFoundError(404)).toBe(false);
  });

  it('returns false for an empty object', () => {
    expect(isNotFoundError({})).toBe(false);
  });
});

// =============================================================================
// isUnsupportedMediaTypeError
// =============================================================================

describe('isUnsupportedMediaTypeError', () => {
  it('returns true when statusCode is 415', () => {
    const error = createK8sError('Unsupported Media Type', 415);
    expect(isUnsupportedMediaTypeError(error)).toBe(true);
  });

  it('returns true when response.statusCode is 415', () => {
    const error: KubernetesApiError = { response: { statusCode: 415 } };
    expect(isUnsupportedMediaTypeError(error)).toBe(true);
  });

  it('returns true when body.code is 415', () => {
    const error: KubernetesApiError = { body: { code: 415 } };
    expect(isUnsupportedMediaTypeError(error)).toBe(true);
  });

  it('returns false for a 404 status code', () => {
    const error = createK8sError('Not Found', 404);
    expect(isUnsupportedMediaTypeError(error)).toBe(false);
  });

  it('returns false for a 500 status code', () => {
    const error = createK8sError('Internal Server Error', 500);
    expect(isUnsupportedMediaTypeError(error)).toBe(false);
  });

  it('returns false for null', () => {
    expect(isUnsupportedMediaTypeError(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isUnsupportedMediaTypeError(undefined)).toBe(false);
  });

  it('returns false for a non-object', () => {
    expect(isUnsupportedMediaTypeError('error')).toBe(false);
  });

  it('returns false for an empty object', () => {
    expect(isUnsupportedMediaTypeError({})).toBe(false);
  });
});

// =============================================================================
// extractAcceptedMediaTypes
// =============================================================================

describe('extractAcceptedMediaTypes', () => {
  it('extracts media types from error message with "accepted media types include:" pattern', () => {
    const error: KubernetesApiError = {
      message:
        'the body of the request was in an unknown format - accepted media types include: application/json-patch+json, application/merge-patch+json',
    };
    expect(extractAcceptedMediaTypes(error)).toEqual([
      'application/json-patch+json',
      'application/merge-patch+json',
    ]);
  });

  it('extracts media types from body.message when message is absent', () => {
    const error: KubernetesApiError = {
      body: {
        message:
          'the body of the request was in an unknown format - accepted media types include: application/merge-patch+json, application/apply-patch+yaml',
      },
    };
    expect(extractAcceptedMediaTypes(error)).toEqual([
      'application/merge-patch+json',
      'application/apply-patch+yaml',
    ]);
  });

  it('returns default types when message does not match the pattern', () => {
    const error: KubernetesApiError = { message: 'some other error' };
    expect(extractAcceptedMediaTypes(error)).toEqual([
      'application/json-patch+json',
      'application/merge-patch+json',
      'application/apply-patch+yaml',
    ]);
  });

  it('returns default types for null input', () => {
    expect(extractAcceptedMediaTypes(null)).toEqual([
      'application/json-patch+json',
      'application/merge-patch+json',
      'application/apply-patch+yaml',
    ]);
  });

  it('returns default types for undefined input', () => {
    expect(extractAcceptedMediaTypes(undefined)).toEqual([
      'application/json-patch+json',
      'application/merge-patch+json',
      'application/apply-patch+yaml',
    ]);
  });

  it('returns default types for an empty object', () => {
    expect(extractAcceptedMediaTypes({})).toEqual([
      'application/json-patch+json',
      'application/merge-patch+json',
      'application/apply-patch+yaml',
    ]);
  });

  it('extracts a single media type', () => {
    const error: KubernetesApiError = {
      message: 'accepted media types include: application/strategic-merge-patch+json',
    };
    expect(extractAcceptedMediaTypes(error)).toEqual(['application/strategic-merge-patch+json']);
  });
});

// =============================================================================
// patchResourceWithCorrectContentType
// =============================================================================

describe('patchResourceWithCorrectContentType', () => {
  it('calls k8sApi.patch with the resource and merge-patch content type', async () => {
    const patchedResource = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'test-cm', namespace: 'default' },
    };
    const k8sApi = createMockK8sApi({ patchResult: patchedResource });

    const resource = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'test-cm', namespace: 'default' },
    };

    const result = await patchResourceWithCorrectContentType(k8sApi, resource);

    expect(result).toEqual(patchedResource);

    const patchFn = k8sApi.patch as ReturnType<typeof mock>;
    expect(patchFn).toHaveBeenCalledTimes(1);
    expect(patchFn.mock.calls[0]).toEqual([
      resource,
      undefined,
      undefined,
      undefined,
      undefined,
      'application/merge-patch+json',
    ]);
  });

  it('logs Secret metadata without exposing data', async () => {
    const k8sApi = createMockK8sApi();

    const secretResource = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'my-secret', namespace: 'test-ns' },
      data: { password: 'c2VjcmV0' },
    };

    // Should not throw — the logger.debug call should handle Secret metadata
    await patchResourceWithCorrectContentType(k8sApi, secretResource);

    const patchFn = k8sApi.patch as ReturnType<typeof mock>;
    expect(patchFn).toHaveBeenCalledTimes(1);
    // Verify the resource was passed through to patch
    expect(patchFn.mock.calls[0]?.[0]).toBe(secretResource);
  });

  it('handles non-Secret resources without special logging', async () => {
    const k8sApi = createMockK8sApi();

    const resource = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'my-deploy', namespace: 'default' },
    };

    await patchResourceWithCorrectContentType(k8sApi, resource);

    const patchFn = k8sApi.patch as ReturnType<typeof mock>;
    expect(patchFn).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// enhanceResourceForEvaluation
// =============================================================================

describe('enhanceResourceForEvaluation', () => {
  it('adds Ready condition for OCI HelmRepository with metadata', () => {
    const resource = {
      spec: { type: 'oci' },
      status: { conditions: [] },
      metadata: { generation: 1, resourceVersion: '12345' },
    };

    const result = enhanceResourceForEvaluation(resource, 'HelmRepository');

    expect(result.status?.conditions).toHaveLength(1);
    expect(result.status?.conditions?.[0]).toEqual({
      type: 'Ready',
      status: 'True',
      message: 'OCI repository is functional',
      reason: 'OciRepositoryProcessed',
    });
  });

  it('preserves existing conditions when adding Ready', () => {
    const resource = {
      spec: { type: 'oci' },
      status: {
        conditions: [{ type: 'Stalled', status: 'False' }],
      },
      metadata: { generation: 2, resourceVersion: '67890' },
    };

    const result = enhanceResourceForEvaluation(resource, 'HelmRepository');

    expect(result.status?.conditions).toHaveLength(2);
    expect(result.status?.conditions?.[0]).toEqual({
      type: 'Stalled',
      status: 'False',
    });
    expect(result.status?.conditions?.[1]).toEqual({
      type: 'Ready',
      status: 'True',
      message: 'OCI repository is functional',
      reason: 'OciRepositoryProcessed',
    });
  });

  it('returns unchanged for non-OCI HelmRepository', () => {
    const resource = {
      spec: { type: 'default' },
      status: { conditions: [] },
      metadata: { generation: 1, resourceVersion: '12345' },
    };

    const result = enhanceResourceForEvaluation(resource, 'HelmRepository');

    expect(result).toBe(resource);
  });

  it('returns unchanged for HelmRepository without spec.type', () => {
    const resource = {
      spec: {},
      status: { conditions: [] },
      metadata: { generation: 1, resourceVersion: '12345' },
    };

    const result = enhanceResourceForEvaluation(resource, 'HelmRepository');

    expect(result).toBe(resource);
  });

  it('returns unchanged for non-HelmRepository kinds', () => {
    const resource = {
      spec: { type: 'oci' },
      status: { conditions: [] },
      metadata: { generation: 1, resourceVersion: '12345' },
    };

    const result = enhanceResourceForEvaluation(resource, 'Deployment');

    expect(result).toBe(resource);
  });

  it('returns unchanged when Ready condition already exists', () => {
    const resource = {
      spec: { type: 'oci' },
      status: {
        conditions: [{ type: 'Ready', status: 'True' }],
      },
      metadata: { generation: 1, resourceVersion: '12345' },
    };

    const result = enhanceResourceForEvaluation(resource, 'HelmRepository');

    expect(result).toBe(resource);
  });

  it('returns unchanged for OCI HelmRepository without generation', () => {
    const resource = {
      spec: { type: 'oci' },
      status: { conditions: [] },
      metadata: { resourceVersion: '12345' },
    };

    const result = enhanceResourceForEvaluation(resource, 'HelmRepository');

    expect(result).toBe(resource);
  });

  it('returns unchanged for OCI HelmRepository without resourceVersion', () => {
    const resource = {
      spec: { type: 'oci' },
      status: { conditions: [] },
      metadata: { generation: 1 },
    };

    const result = enhanceResourceForEvaluation(resource, 'HelmRepository');

    expect(result).toBe(resource);
  });

  it('returns unchanged for OCI HelmRepository without metadata', () => {
    const resource = {
      spec: { type: 'oci' },
      status: { conditions: [] },
    };

    const result = enhanceResourceForEvaluation(resource, 'HelmRepository');

    expect(result).toBe(resource);
  });

  it('does not mutate the original resource', () => {
    const resource = {
      spec: { type: 'oci' },
      status: { conditions: [] },
      metadata: { generation: 1, resourceVersion: '12345' },
    };

    const result = enhanceResourceForEvaluation(resource, 'HelmRepository');

    // Result is a new object
    expect(result).not.toBe(resource);
    // Original is not mutated
    expect(resource.status.conditions).toHaveLength(0);
  });
});
