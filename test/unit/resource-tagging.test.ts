/**
 * Unit tests for the label-based deployment state backend.
 *
 * Covers:
 *   - applyTypekroTags: label + annotation stamping
 *   - extractTypekroTags: round-trip extraction from a live resource
 *   - getEffectiveScopes: merges annotation, WeakMap, and legacy sources
 *   - shouldDeleteForScopes: scope-filter matching matrix
 *   - buildFactoryInstanceSelector: label selector construction
 *   - sanitiseLabelValue: DNS-label sanitisation
 *
 * Discovery module (deployment-state-discovery.ts) — graph reconstruction
 * from per-resource annotations — is exercised by integration tests that
 * deploy to a real cluster and then call `factory.deleteInstance` from a
 * fresh factory instance.
 */

import { describe, expect, it } from 'bun:test';
import { setMetadataField } from '../../src/core/metadata/index.js';
import type { KubernetesResource } from '../../src/core/types/kubernetes.js';
import {
  applyTypekroTags,
  buildFactoryInstanceSelector,
  DEPLOYMENT_ID_ANNOTATION,
  DEPENDS_ON_ANNOTATION,
  extractTypekroTags,
  FACTORY_NAME_ANNOTATION,
  FACTORY_NAME_LABEL,
  FACTORY_NAMESPACE_ANNOTATION,
  getEffectiveScopes,
  INSTANCE_NAME_ANNOTATION,
  INSTANCE_NAME_LABEL,
  MANAGED_BY_LABEL,
  MANAGED_BY_VALUE,
  RESOURCE_ID_ANNOTATION,
  sanitiseLabelValue,
  SCOPES_ANNOTATION,
  shouldDeleteForScopes,
  type TagContext,
} from '../../src/core/deployment/resource-tagging.js';

// ── applyTypekroTags ──────────────────────────────────────────────────────

describe('applyTypekroTags', () => {
  function makeManifest(): KubernetesResource {
    return {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: 'my-app',
        namespace: 'default',
      },
    };
  }

  function makeCtx(overrides?: Partial<TagContext>): TagContext {
    return {
      factoryName: 'webapp',
      instanceName: 'testapp',
      deploymentId: 'deploy-1',
      factoryNamespace: 'factory-ns',
      resourceId: 'appDeployment',
      ...overrides,
    };
  }

  it('sets managed-by, factory-name, and instance-name labels', () => {
    const manifest = makeManifest();
    applyTypekroTags(manifest, makeCtx());
    const labels = (manifest.metadata as any).labels;
    expect(labels[MANAGED_BY_LABEL]).toBe(MANAGED_BY_VALUE);
    expect(labels[FACTORY_NAME_LABEL]).toBe('webapp');
    expect(labels[INSTANCE_NAME_LABEL]).toBe('testapp');
  });

  it('sets deployment-id, resource-id, and factory-namespace annotations', () => {
    const manifest = makeManifest();
    applyTypekroTags(manifest, makeCtx());
    const annotations = (manifest.metadata as any).annotations;
    expect(annotations[DEPLOYMENT_ID_ANNOTATION]).toBe('deploy-1');
    expect(annotations[RESOURCE_ID_ANNOTATION]).toBe('appDeployment');
    expect(annotations[FACTORY_NAMESPACE_ANNOTATION]).toBe('factory-ns');
  });

  it('sets scopes annotation when provided', () => {
    const manifest = makeManifest();
    applyTypekroTags(manifest, makeCtx({ scopes: ['cluster'] }));
    const ann = (manifest.metadata as any).annotations[SCOPES_ANNOTATION];
    expect(JSON.parse(ann)).toEqual(['cluster']);
  });

  it('omits scopes annotation when scopes is empty', () => {
    const manifest = makeManifest();
    applyTypekroTags(manifest, makeCtx({ scopes: [] }));
    expect((manifest.metadata as any).annotations[SCOPES_ANNOTATION]).toBeUndefined();
  });

  it('sets depends-on annotation when provided', () => {
    const manifest = makeManifest();
    applyTypekroTags(manifest, makeCtx({ dependencies: ['database', 'cache'] }));
    const ann = (manifest.metadata as any).annotations[DEPENDS_ON_ANNOTATION];
    expect(JSON.parse(ann)).toEqual(['database', 'cache']);
  });

  it('preserves existing user labels and annotations', () => {
    const manifest = makeManifest();
    (manifest.metadata as any).labels = { 'app.kubernetes.io/name': 'my-app' };
    (manifest.metadata as any).annotations = { 'my.org/version': '1.0' };
    applyTypekroTags(manifest, makeCtx());
    expect((manifest.metadata as any).labels['app.kubernetes.io/name']).toBe('my-app');
    expect((manifest.metadata as any).annotations['my.org/version']).toBe('1.0');
  });

  it('creates metadata if missing', () => {
    const manifest = { apiVersion: 'v1', kind: 'ConfigMap' } as KubernetesResource;
    applyTypekroTags(manifest, makeCtx());
    expect((manifest.metadata as any).labels[MANAGED_BY_LABEL]).toBe(MANAGED_BY_VALUE);
  });

  it('stores raw factory/instance names as annotations', () => {
    const manifest = makeManifest();
    applyTypekroTags(manifest, makeCtx({ factoryName: 'My/Factory', instanceName: 'Test:App' }));
    const ann = (manifest.metadata as any).annotations;
    expect(ann[FACTORY_NAME_ANNOTATION]).toBe('My/Factory');
    expect(ann[INSTANCE_NAME_ANNOTATION]).toBe('Test:App');
    // Labels are sanitized
    const labels = (manifest.metadata as any).labels;
    expect(labels[FACTORY_NAME_LABEL]).toBe('my-factory');
    expect(labels[INSTANCE_NAME_LABEL]).toBe('test-app');
  });
});

// ── extractTypekroTags ────────────────────────────────────────────────────

describe('extractTypekroTags', () => {
  it('extracts all fields from a fully-tagged resource', () => {
    const resource = {
      metadata: {
        labels: {
          [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
          [FACTORY_NAME_LABEL]: 'webapp',
          [INSTANCE_NAME_LABEL]: 'testapp',
        },
        annotations: {
          [FACTORY_NAME_ANNOTATION]: 'webapp',
          [INSTANCE_NAME_ANNOTATION]: 'testapp',
          [DEPLOYMENT_ID_ANNOTATION]: 'deploy-1',
          [RESOURCE_ID_ANNOTATION]: 'appDeployment',
          [FACTORY_NAMESPACE_ANNOTATION]: 'factory-ns',
          [SCOPES_ANNOTATION]: '["cluster"]',
          [DEPENDS_ON_ANNOTATION]: '["database","cache"]',
        },
      },
    };
    const tags = extractTypekroTags(resource);
    expect(tags.factoryName).toBe('webapp');
    expect(tags.instanceName).toBe('testapp');
    expect(tags.deploymentId).toBe('deploy-1');
    expect(tags.resourceId).toBe('appDeployment');
    expect(tags.factoryNamespace).toBe('factory-ns');
    expect(tags.scopes).toEqual(['cluster']);
    expect(tags.dependencies).toEqual(['database', 'cache']);
  });

  it('returns empty arrays for missing scopes and dependencies', () => {
    const resource = { metadata: { labels: {}, annotations: {} } };
    const tags = extractTypekroTags(resource);
    expect(tags.scopes).toEqual([]);
    expect(tags.dependencies).toEqual([]);
  });

  it('tolerates malformed JSON in annotations', () => {
    const resource = {
      metadata: {
        annotations: {
          [SCOPES_ANNOTATION]: 'not-json',
          [DEPENDS_ON_ANNOTATION]: '{bad}',
        },
      },
    };
    const tags = extractTypekroTags(resource);
    expect(tags.scopes).toEqual([]);
    expect(tags.dependencies).toEqual([]);
  });

  it('falls back to labels when annotations are missing', () => {
    const resource = {
      metadata: {
        labels: {
          [FACTORY_NAME_LABEL]: 'webapp',
          [INSTANCE_NAME_LABEL]: 'testapp',
        },
      },
    };
    const tags = extractTypekroTags(resource);
    expect(tags.factoryName).toBe('webapp');
    expect(tags.instanceName).toBe('testapp');
  });
});

// ── getEffectiveScopes ────────────────────────────────────────────────────

describe('getEffectiveScopes', () => {
  it('returns annotation scopes', () => {
    const manifest = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { annotations: { [SCOPES_ANNOTATION]: '["cluster"]' } },
    } as KubernetesResource;
    expect(getEffectiveScopes(manifest)).toEqual(['cluster']);
  });

  it('returns WeakMap scopes metadata', () => {
    const manifest = { apiVersion: 'v1', kind: 'ConfigMap', metadata: {} } as KubernetesResource;
    setMetadataField(manifest, 'scopes', ['team:platform']);
    expect(getEffectiveScopes(manifest)).toEqual(['team:platform']);
  });

  it('treats lifecycle: shared as scopes: ["shared"]', () => {
    const manifest = { apiVersion: 'v1', kind: 'ConfigMap', metadata: {} } as KubernetesResource;
    setMetadataField(manifest, 'lifecycle', 'shared');
    expect(getEffectiveScopes(manifest)).toEqual(['shared']);
  });

  it('returns typekro.io/lifecycle annotation as ["shared"]', () => {
    const manifest = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { annotations: { 'typekro.io/lifecycle': 'shared' } },
    } as KubernetesResource;
    expect(getEffectiveScopes(manifest)).toEqual(['shared']);
  });

  it('merges all sources without duplicates', () => {
    const manifest = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { annotations: { [SCOPES_ANNOTATION]: '["cluster"]' } },
    } as KubernetesResource;
    setMetadataField(manifest, 'scopes', ['cluster', 'team:ops']);
    setMetadataField(manifest, 'lifecycle', 'shared');
    const scopes = getEffectiveScopes(manifest);
    expect(scopes).toContain('cluster');
    expect(scopes).toContain('team:ops');
    expect(scopes).toContain('shared');
    // 'cluster' should not appear twice
    expect(scopes.filter((s) => s === 'cluster')).toHaveLength(1);
  });

  it('returns empty array for unscoped resources', () => {
    const manifest = { apiVersion: 'v1', kind: 'ConfigMap', metadata: {} } as KubernetesResource;
    expect(getEffectiveScopes(manifest)).toEqual([]);
  });
});

// ── shouldDeleteForScopes ─────────────────────────────────────────────────

describe('shouldDeleteForScopes', () => {
  it('always deletes instance-private resources (empty scopes)', () => {
    expect(shouldDeleteForScopes([], [])).toBe(true);
    expect(shouldDeleteForScopes([], ['cluster'])).toBe(true);
  });

  it('skips scoped resources when filter is empty (default delete)', () => {
    expect(shouldDeleteForScopes(['cluster'], [])).toBe(false);
    expect(shouldDeleteForScopes(['shared'], [])).toBe(false);
  });

  it('deletes scoped resources when filter matches', () => {
    expect(shouldDeleteForScopes(['cluster'], ['cluster'])).toBe(true);
    expect(shouldDeleteForScopes(['cluster', 'team:ops'], ['cluster'])).toBe(true);
    expect(shouldDeleteForScopes(['team:ops'], ['team:ops'])).toBe(true);
  });

  it('skips scoped resources when filter does not match', () => {
    expect(shouldDeleteForScopes(['cluster'], ['team:ops'])).toBe(false);
    expect(shouldDeleteForScopes(['team:frontend'], ['team:backend'])).toBe(false);
  });

  it('matches when any scope intersects the filter', () => {
    expect(shouldDeleteForScopes(['cluster', 'team:ops'], ['team:ops'])).toBe(true);
  });
});

// ── buildFactoryInstanceSelector ──────────────────────────────────────────

describe('buildFactoryInstanceSelector', () => {
  it('builds a label selector with managed-by, factory, and instance', () => {
    const selector = buildFactoryInstanceSelector({
      factoryName: 'webapp',
      instanceName: 'testapp',
    });
    expect(selector).toContain(`${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE}`);
    expect(selector).toContain(`${FACTORY_NAME_LABEL}=webapp`);
    expect(selector).toContain(`${INSTANCE_NAME_LABEL}=testapp`);
  });

  it('sanitizes factory and instance names', () => {
    const selector = buildFactoryInstanceSelector({
      factoryName: 'My/Factory',
      instanceName: 'Test:App',
    });
    expect(selector).toContain(`${FACTORY_NAME_LABEL}=my-factory`);
    expect(selector).toContain(`${INSTANCE_NAME_LABEL}=test-app`);
  });
});

// ── sanitiseLabelValue ────────────────────────────────────────────────────

describe('sanitiseLabelValue', () => {
  it('lowercases and replaces non-DNS characters', () => {
    expect(sanitiseLabelValue('My/Factory:Name')).toBe('my-factory-name');
  });

  it('truncates to 63 characters', () => {
    const long = 'a'.repeat(100);
    expect(sanitiseLabelValue(long).length).toBeLessThanOrEqual(63);
  });

  it('strips leading and trailing special chars', () => {
    expect(sanitiseLabelValue('--hello--')).toBe('hello');
  });

  it('handles empty string', () => {
    expect(sanitiseLabelValue('')).toBe('');
  });
});

// ── Round-trip: tag → extract → verify ────────────────────────────────────

describe('Tag round-trip', () => {
  it('round-trips all fields through tag and extract', () => {
    const manifest = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'my-svc', namespace: 'default' },
    } as KubernetesResource;

    applyTypekroTags(manifest, {
      factoryName: 'webapp',
      instanceName: 'testapp',
      deploymentId: 'deploy-1',
      factoryNamespace: 'factory-ns',
      resourceId: 'mySvc',
      scopes: ['cluster', 'team:platform'],
      dependencies: ['database', 'cache'],
    });

    const tags = extractTypekroTags(manifest as any);
    expect(tags.factoryName).toBe('webapp');
    expect(tags.instanceName).toBe('testapp');
    expect(tags.deploymentId).toBe('deploy-1');
    expect(tags.resourceId).toBe('mySvc');
    expect(tags.factoryNamespace).toBe('factory-ns');
    expect(tags.scopes).toEqual(['cluster', 'team:platform']);
    expect(tags.dependencies).toEqual(['database', 'cache']);
  });
});
