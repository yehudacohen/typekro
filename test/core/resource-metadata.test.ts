/**
 * Unit tests for the ResourceMetadata WeakMap store.
 *
 * Validates all accessors, convenience functions, copy semantics,
 * and the key invariant: metadata is invisible to serialization.
 *
 * @see src/core/metadata/resource-metadata.ts
 */

import { describe, expect, it } from 'bun:test';
import {
  clearResourceMetadata,
  copyResourceMetadata,
  getForEach,
  getIncludeWhen,
  getMetadataField,
  getReadinessEvaluator,
  getReadyWhen,
  getResourceId,
  getResourceMetadata,
  getTemplateOverrides,
  hasResourceMetadata,
  setForEach,
  setIncludeWhen,
  setMetadataField,
  setReadinessEvaluator,
  setReadyWhen,
  setResourceId,
  setResourceMetadata,
  setTemplateOverrides,
} from '../../src/core/metadata/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a plain object that acts as a resource */
function makeResource(extra: Record<string, unknown> = {}) {
  return { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'test' }, ...extra };
}

// ===========================================================================
// Core accessors
// ===========================================================================

describe('ResourceMetadata: core accessors', () => {
  it('getResourceMetadata returns undefined for unknown resource', () => {
    const resource = makeResource();
    expect(getResourceMetadata(resource)).toBeUndefined();
  });

  it('setResourceMetadata creates a new metadata record', () => {
    const resource = makeResource();
    const result = setResourceMetadata(resource, { resourceId: 'test-id' });
    expect(result).toEqual({ resourceId: 'test-id' });
    expect(getResourceMetadata(resource)).toEqual({ resourceId: 'test-id' });
  });

  it('setResourceMetadata merges into existing metadata', () => {
    const resource = makeResource();
    setResourceMetadata(resource, { resourceId: 'r1' });
    setResourceMetadata(resource, { includeWhen: ['x'] });
    expect(getResourceMetadata(resource)).toEqual({
      resourceId: 'r1',
      includeWhen: ['x'],
    });
  });

  it('setResourceMetadata overwrites individual fields', () => {
    const resource = makeResource();
    setResourceMetadata(resource, { resourceId: 'old' });
    setResourceMetadata(resource, { resourceId: 'new' });
    expect(getResourceMetadata(resource)?.resourceId).toBe('new');
  });

  it('getMetadataField returns single field', () => {
    const resource = makeResource();
    setResourceMetadata(resource, { resourceId: 'abc', includeWhen: [1, 2] });
    expect(getMetadataField(resource, 'resourceId')).toBe('abc');
    expect(getMetadataField(resource, 'includeWhen')).toEqual([1, 2]);
  });

  it('getMetadataField returns undefined for unset field', () => {
    const resource = makeResource();
    setResourceMetadata(resource, { resourceId: 'x' });
    expect(getMetadataField(resource, 'readyWhen')).toBeUndefined();
  });

  it('setMetadataField sets a single field', () => {
    const resource = makeResource();
    setMetadataField(resource, 'resourceId', 'single');
    expect(getMetadataField(resource, 'resourceId')).toBe('single');
  });

  it('setMetadataField creates metadata record if none exists', () => {
    const resource = makeResource();
    setMetadataField(resource, 'forEach', [{ item: 'list' }]);
    expect(getResourceMetadata(resource)).toEqual({ forEach: [{ item: 'list' }] });
  });

  it('hasResourceMetadata returns true after set', () => {
    const resource = makeResource();
    expect(hasResourceMetadata(resource)).toBe(false);
    setResourceMetadata(resource, { resourceId: 'x' });
    expect(hasResourceMetadata(resource)).toBe(true);
  });

  it('clearResourceMetadata removes all metadata', () => {
    const resource = makeResource();
    setResourceMetadata(resource, { resourceId: 'x', includeWhen: [1] });
    expect(clearResourceMetadata(resource)).toBe(true);
    expect(getResourceMetadata(resource)).toBeUndefined();
    expect(hasResourceMetadata(resource)).toBe(false);
  });

  it('clearResourceMetadata returns false if no metadata existed', () => {
    const resource = makeResource();
    expect(clearResourceMetadata(resource)).toBe(false);
  });
});

// ===========================================================================
// Copy semantics
// ===========================================================================

describe('ResourceMetadata: copyResourceMetadata', () => {
  it('copies all metadata from source to target', () => {
    const source = makeResource({ id: 'src' });
    const target = makeResource({ id: 'tgt' });
    setResourceMetadata(source, {
      resourceId: 'my-id',
      readinessEvaluator: () => ({ ready: true, message: 'ok' }),
      includeWhen: ['cond'],
    });

    expect(copyResourceMetadata(source, target)).toBe(true);

    expect(getResourceId(target)).toBe('my-id');
    expect(typeof getReadinessEvaluator(target)).toBe('function');
    expect(getIncludeWhen(target)).toEqual(['cond']);
  });

  it('returns false when source has no metadata', () => {
    const source = makeResource();
    const target = makeResource();
    expect(copyResourceMetadata(source, target)).toBe(false);
  });

  it('copy is a shallow clone — mutations on target do not affect source', () => {
    const source = makeResource();
    const target = makeResource();
    setResourceMetadata(source, { resourceId: 'original' });
    copyResourceMetadata(source, target);

    setMetadataField(target, 'resourceId', 'mutated');
    expect(getResourceId(source)).toBe('original');
    expect(getResourceId(target)).toBe('mutated');
  });
});

// ===========================================================================
// Convenience: resourceId
// ===========================================================================

describe('ResourceMetadata: resourceId convenience', () => {
  it('getResourceId / setResourceId round-trip', () => {
    const resource = makeResource();
    expect(getResourceId(resource)).toBeUndefined();
    setResourceId(resource, 'my-deployment');
    expect(getResourceId(resource)).toBe('my-deployment');
  });
});

// ===========================================================================
// Convenience: readinessEvaluator
// ===========================================================================

describe('ResourceMetadata: readinessEvaluator convenience', () => {
  it('getReadinessEvaluator / setReadinessEvaluator round-trip', () => {
    const resource = makeResource();
    const evaluator = (r: unknown) => ({
      ready: !!(r as Record<string, unknown>)?.status,
      message: 'checked',
    });

    expect(getReadinessEvaluator(resource)).toBeUndefined();
    setReadinessEvaluator(resource, evaluator);
    expect(getReadinessEvaluator(resource)).toBe(evaluator);
  });
});

// ===========================================================================
// Convenience: conditional metadata
// ===========================================================================

describe('ResourceMetadata: conditional metadata convenience', () => {
  it('includeWhen round-trip', () => {
    const resource = makeResource();
    expect(getIncludeWhen(resource)).toBeUndefined();
    setIncludeWhen(resource, ['schema.spec.enabled == true']);
    expect(getIncludeWhen(resource)).toEqual(['schema.spec.enabled == true']);
  });

  it('readyWhen round-trip', () => {
    const resource = makeResource();
    expect(getReadyWhen(resource)).toBeUndefined();
    setReadyWhen(resource, ['status.ready == true']);
    expect(getReadyWhen(resource)).toEqual(['status.ready == true']);
  });

  it('forEach round-trip', () => {
    const resource = makeResource();
    expect(getForEach(resource)).toBeUndefined();
    setForEach(resource, [{ item: 'schema.spec.regions' }]);
    expect(getForEach(resource)).toEqual([{ item: 'schema.spec.regions' }]);
  });

  it('templateOverrides round-trip', () => {
    const resource = makeResource();
    expect(getTemplateOverrides(resource)).toBeUndefined();
    const overrides = [{ propertyPath: 'spec.replicas', celExpression: 'schema.spec.count' }];
    setTemplateOverrides(resource, overrides);
    expect(getTemplateOverrides(resource)).toEqual(overrides);
  });
});

// ===========================================================================
// Key invariant: metadata is invisible to serialization
// ===========================================================================

describe('ResourceMetadata: serialization invisibility', () => {
  it('metadata is not visible in Object.keys()', () => {
    const resource = makeResource();
    setResourceMetadata(resource, { resourceId: 'x', includeWhen: [1] });

    const keys = Object.keys(resource);
    expect(keys).not.toContain('resourceId');
    expect(keys).not.toContain('__resourceId');
    expect(keys).not.toContain('includeWhen');
    expect(keys).not.toContain('readinessEvaluator');
  });

  it('metadata is not visible in JSON.stringify()', () => {
    const resource = makeResource();
    setResourceMetadata(resource, {
      resourceId: 'x',
      readinessEvaluator: () => ({ ready: true, message: 'ok' }),
    });

    const json = JSON.stringify(resource);
    expect(json).not.toContain('resourceId');
    expect(json).not.toContain('readinessEvaluator');
  });

  it('metadata is not visible in Object.entries()', () => {
    const resource = makeResource();
    setResourceMetadata(resource, { resourceId: 'x' });

    const entries = Object.entries(resource);
    const keys = entries.map(([k]) => k);
    expect(keys).not.toContain('resourceId');
    expect(keys).not.toContain('__resourceId');
  });

  it('metadata is not visible in for-in loops', () => {
    const resource = makeResource();
    setResourceMetadata(resource, { resourceId: 'x', forEach: [{ a: 'b' }] });

    const forInKeys: string[] = [];
    for (const key in resource) {
      forInKeys.push(key);
    }
    expect(forInKeys).not.toContain('resourceId');
    expect(forInKeys).not.toContain('forEach');
  });

  it('metadata survives {...spread} via copyResourceMetadata', () => {
    const source = makeResource();
    setResourceMetadata(source, { resourceId: 'survive' });

    const target = { ...source, id: 'new-id' };
    copyResourceMetadata(source, target);

    expect(getResourceId(target)).toBe('survive');
    // But the original non-enumerable property pattern would have lost it:
    expect(Object.keys(target)).not.toContain('resourceId');
  });

  it('metadata survives JSON.parse(JSON.stringify()) via copyResourceMetadata', () => {
    const source = makeResource();
    setResourceMetadata(source, { resourceId: 'survive-json' });

    // JSON round-trip creates a completely new object
    const cloned = JSON.parse(JSON.stringify(source));
    copyResourceMetadata(source, cloned);

    expect(getResourceId(cloned)).toBe('survive-json');
  });
});

// ===========================================================================
// Edge cases
// ===========================================================================

describe('ResourceMetadata: edge cases', () => {
  it('works with different object types as keys', () => {
    const arr = [1, 2, 3];
    const fn = () => {};
    const obj = {};

    setResourceId(arr, 'array-resource');
    setResourceId(fn, 'function-resource');
    setResourceId(obj, 'object-resource');

    expect(getResourceId(arr)).toBe('array-resource');
    expect(getResourceId(fn)).toBe('function-resource');
    expect(getResourceId(obj)).toBe('object-resource');
  });

  it('multiple resources maintain independent metadata', () => {
    const r1 = makeResource({ id: 'r1' });
    const r2 = makeResource({ id: 'r2' });

    setResourceId(r1, 'first');
    setResourceId(r2, 'second');

    expect(getResourceId(r1)).toBe('first');
    expect(getResourceId(r2)).toBe('second');
  });

  it('setResourceMetadata with empty object creates empty record', () => {
    const resource = makeResource();
    setResourceMetadata(resource, {});
    expect(hasResourceMetadata(resource)).toBe(true);
    expect(getResourceMetadata(resource)).toEqual({});
  });
});
