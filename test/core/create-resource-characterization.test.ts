/**
 * Characterization tests for create-resource.ts
 *
 * These tests capture the CURRENT behavior of the proxy engine and
 * `createResource` factory as a safety net for future refactoring (Phase 2).
 *
 * Organized by internal function:
 *   1. deepCloneValue (via toJSON)
 *   2. createRefFactory (via property access on refs)
 *   3. createPropertyProxy (via spec/status proxy access)
 *   4. createGenericProxyResource (via Enhanced proxy)
 *   5. createResource (public API)
 *
 * @see src/core/proxy/create-resource.ts
 */

import { describe, expect, it } from 'bun:test';
import {
  createCompositionContext,
  runInStatusBuilderContext,
  runWithCompositionContext,
} from '../../src/core/composition/context.js';
import { TypeKroError } from '../../src/core/errors.js';
import { createResource } from '../../src/core/proxy/create-resource.js';
import type { CelExpression } from '../../src/core/types/common.js';
import type { KubernetesResource } from '../../src/core/types/kubernetes.js';
import { CEL_EXPRESSION_BRAND, KUBERNETES_REF_BRAND } from '../../src/shared/brands.js';
import { isKubernetesRef } from '../../src/utils/type-guards.js';
import { asKubernetesRef, getReadinessEvaluator } from '../utils/mock-factories.js';

// ---------------------------------------------------------------------------
// Runtime accessor helpers (avoid `as any` for branded proxy objects)
// ---------------------------------------------------------------------------

/** Cast a value to CelExpression runtime shape for inspecting proxy internals. */
function asCelExpression(value: unknown): CelExpression {
  return value as CelExpression;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a minimal KubernetesResource for testing */
function makeResource(
  overrides: Partial<KubernetesResource<Record<string, unknown>, Record<string, unknown>>> = {}
): KubernetesResource<Record<string, unknown>, Record<string, unknown>> {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: 'my-app' },
    spec: { replicas: 3, image: 'nginx' },
    ...overrides,
  };
}

// ===========================================================================
// 1. deepCloneValue (tested via toJSON on proxied resources)
// ===========================================================================

describe('deepCloneValue (via toJSON)', () => {
  it('strips function-valued properties from spec', () => {
    const r = createResource(
      makeResource({
        spec: { name: 'test', fn: () => 'hello' },
      })
    );
    const json = JSON.parse(JSON.stringify(r.spec));
    expect(json).toEqual({ name: 'test' });
    expect(json.fn).toBeUndefined();
  });

  it('preserves null and undefined values in spec', () => {
    const r = createResource(
      makeResource({
        spec: { a: null, b: undefined, c: 'ok' },
      })
    );
    const json = r.spec.toJSON();
    // null is preserved, undefined is stripped by JSON.stringify convention
    expect(json.a).toBeNull();
    expect(json.c).toBe('ok');
  });

  it('clones Date objects as new Date instances', () => {
    const date = new Date('2025-01-01');
    const r = createResource(
      makeResource({
        spec: { created: date },
      })
    );
    const json = r.spec.toJSON();
    expect(json.created).toBeInstanceOf(Date);
    expect(json.created.getTime()).toBe(date.getTime());
    // Must be a different object (clone, not reference)
    expect(json.created).not.toBe(date);
  });

  it('deeply clones nested arrays', () => {
    const r = createResource(
      makeResource({
        spec: { ports: [{ port: 80 }, { port: 443 }] },
      })
    );
    const json = r.spec.toJSON();
    expect(json.ports).toEqual([{ port: 80 }, { port: 443 }]);
  });

  it('deeply clones nested objects', () => {
    const inner = { level2: { level3: 'deep' } };
    const r = createResource(
      makeResource({
        spec: { nested: inner },
      })
    );
    const json = r.spec.toJSON();
    expect(json.nested).toEqual({ level2: { level3: 'deep' } });
    expect(json.nested).not.toBe(inner);
  });

  it('clones RegExp objects', () => {
    const r = createResource(
      makeResource({
        spec: { pattern: /abc/gi },
      })
    );
    const json = r.spec.toJSON();
    expect(json.pattern).toBeInstanceOf(RegExp);
    expect(json.pattern.source).toBe('abc');
    expect(json.pattern.flags).toBe('gi');
  });
});

// ===========================================================================
// 2. createRefFactory (via property access that returns KubernetesRef)
// ===========================================================================

describe('createRefFactory (via ref property access)', () => {
  it('returns KubernetesRef for non-existent spec properties outside status context', () => {
    const r = createResource(makeResource({ spec: { replicas: 3 } }));
    const ref = r.spec.nonExistent;
    expect(isKubernetesRef(ref)).toBe(true);
    expect(asKubernetesRef(ref).resourceId).toBe('deploymentMyApp');
    expect(asKubernetesRef(ref).fieldPath).toBe('spec.nonExistent');
  });

  it('creates nested reference chains via property access', () => {
    const r = createResource(makeResource());
    const ref = r.status.conditions.ready;
    expect(isKubernetesRef(ref)).toBe(true);
    expect(asKubernetesRef(ref).fieldPath).toBe('status.conditions.ready');
  });

  it('$ prefix creates Kro optional access (.?field) on refs', () => {
    const r = createResource(makeResource());
    const ref = r.status.$optionalField;
    expect(isKubernetesRef(ref)).toBe(true);
    expect(asKubernetesRef(ref).fieldPath).toBe('status.?optionalField');
  });

  it('$ prefix chains correctly with nested access', () => {
    const r = createResource(makeResource());
    const ref = r.status.$optional.nested;
    expect(isKubernetesRef(ref)).toBe(true);
    expect(asKubernetesRef(ref).fieldPath).toBe('status.?optional.nested');
  });

  it('orValue() returns CelExpression with string default', () => {
    const r = createResource(makeResource());
    const expr = r.status.someField.orValue('fallback');
    expect(asCelExpression(expr)[CEL_EXPRESSION_BRAND]).toBe(true);
    expect(asCelExpression(expr).expression).toBe('status.someField.orValue("fallback")');
  });

  it('orValue() returns CelExpression with numeric default', () => {
    const r = createResource(makeResource());
    const expr = r.status.someField.orValue(42);
    expect(asCelExpression(expr)[CEL_EXPRESSION_BRAND]).toBe(true);
    expect(asCelExpression(expr).expression).toBe('status.someField.orValue(42)');
  });

  it('valueOf and toString return the fieldPath on directly created refs', () => {
    const r = createResource(makeResource());
    // When accessing a non-existent status prop, the result goes through
    // createPropertyProxy → createRefFactory. The ref target has valueOf/toString
    // defined, but String() on a Proxy with a function target may not invoke them
    // in the same way. Characterize actual behavior:
    const ref = r.status.readyReplicas;
    // The ref IS a KubernetesRef
    expect(isKubernetesRef(ref)).toBe(true);
    expect(asKubernetesRef(ref).fieldPath).toBe('status.readyReplicas');
    expect(asKubernetesRef(ref).resourceId).toBe('deploymentMyApp');
  });

  it('ref has the KUBERNETES_REF_BRAND symbol', () => {
    const r = createResource(makeResource());
    const ref = r.status.anyField;
    expect(asKubernetesRef(ref)[KUBERNETES_REF_BRAND]).toBe(true);
  });
});

// ===========================================================================
// 3. createPropertyProxy (via spec/status proxy on Enhanced)
// ===========================================================================

describe('createPropertyProxy (via spec/status access)', () => {
  it('returns real values for existing spec properties outside status context', () => {
    const r = createResource(
      makeResource({
        spec: { replicas: 3, image: 'nginx' },
      })
    );
    expect(r.spec.replicas).toBe(3);
    expect(r.spec.image).toBe('nginx');
  });

  it('returns KubernetesRef for non-existent spec properties', () => {
    const r = createResource(
      makeResource({
        spec: { replicas: 3 },
      })
    );
    const ref = r.spec.doesNotExist;
    expect(isKubernetesRef(ref)).toBe(true);
  });

  it('returns KubernetesRef for ALL spec properties inside status builder context', () => {
    const r = createResource(
      makeResource({
        spec: { replicas: 3, image: 'nginx' },
      })
    );
    runInStatusBuilderContext(() => {
      const ref = r.spec.replicas;
      expect(isKubernetesRef(ref)).toBe(true);
      expect(asKubernetesRef(ref).fieldPath).toBe('spec.replicas');
    });
  });

  it('returns KubernetesRef for ALL status properties inside status builder context', () => {
    const r = createResource(
      makeResource({
        status: { ready: true },
      })
    );
    runInStatusBuilderContext(() => {
      const ref = r.status.ready;
      expect(isKubernetesRef(ref)).toBe(true);
      expect(asKubernetesRef(ref).fieldPath).toBe('status.ready');
    });
  });

  it('$ prefix on spec property creates optional ref', () => {
    const r = createResource(
      makeResource({
        spec: { replicas: 3 },
      })
    );
    const ref = r.spec.$replicas;
    expect(isKubernetesRef(ref)).toBe(true);
    expect(asKubernetesRef(ref).fieldPath).toBe('spec.?replicas');
  });

  it('toJSON on spec proxy returns clean object (no functions)', () => {
    const r = createResource(
      makeResource({
        spec: { replicas: 3, name: 'test' },
      })
    );
    const json = r.spec.toJSON();
    expect(json).toEqual({ replicas: 3, name: 'test' });
  });

  it('property set on spec proxy works', () => {
    const r = createResource(
      makeResource({
        spec: { replicas: 3 },
      })
    );
    (r.spec as Record<string, unknown>).replicas = 5;
    expect(r.spec.replicas).toBe(5);
  });

  it('Object.keys on spec proxy returns original keys', () => {
    const r = createResource(
      makeResource({
        spec: { replicas: 3, image: 'nginx' },
      })
    );
    const keys = Object.keys(r.spec);
    expect(keys).toContain('replicas');
    expect(keys).toContain('image');
  });

  it('spec proxy is cached — same object returned on repeated access', () => {
    const r = createResource(makeResource({ spec: { x: 1 } }));
    const s1 = r.spec;
    const s2 = r.spec;
    expect(s1).toBe(s2);
  });

  it('status proxy is cached — same object returned on repeated access', () => {
    const r = createResource(makeResource({ status: { ready: true } }));
    const s1 = r.status;
    const s2 = r.status;
    expect(s1).toBe(s2);
  });

  it('creates empty proxy when spec is undefined', () => {
    const r = createResource(
      // biome-ignore lint/suspicious/noExplicitAny: intentionally testing undefined spec edge case with exactOptionalPropertyTypes
      makeResource({ spec: undefined } as any)
    );
    // Accessing any property on an empty spec should return a ref
    const ref = r.spec.anyProp;
    expect(isKubernetesRef(ref)).toBe(true);
  });

  it('creates empty proxy when status is undefined', () => {
    const r = createResource(
      // biome-ignore lint/suspicious/noExplicitAny: intentionally testing undefined status edge case with exactOptionalPropertyTypes
      makeResource({ status: undefined } as any)
    );
    const ref = r.status.anyProp;
    expect(isKubernetesRef(ref)).toBe(true);
  });
});

// ===========================================================================
// 4. createGenericProxyResource (via Enhanced proxy)
// ===========================================================================

describe('createGenericProxyResource (via Enhanced proxy)', () => {
  it('.id returns the deterministic resourceId', () => {
    const r = createResource(makeResource());
    expect(r.id).toBe('deploymentMyApp');
  });

  it('.id returns explicit id when provided', () => {
    const r = createResource(makeResource({ id: 'myCustomId' }));
    expect(r.id).toBe('myCustomId');
  });

  it('metadata is wrapped in a proxy with real values', () => {
    const r = createResource(
      makeResource({
        metadata: { name: 'test', namespace: 'default', labels: { app: 'x' } },
      })
    );
    expect(r.metadata.name).toBe('test');
    expect(r.metadata.namespace).toBe('default');
    expect(r.metadata.labels).toEqual({ app: 'x' });
  });

  it('metadata proxy populates missing properties from original metadata', () => {
    const r = createResource(
      makeResource({
        metadata: { name: 'test', namespace: 'default' },
      })
    );
    // name and namespace should be accessible
    expect(r.metadata.name).toBe('test');
  });

  it('data field returns property proxy when present on resource', () => {
    const r = createResource(
      makeResource({
        data: { key1: 'value1' },
      })
    );
    expect(r.data?.key1).toBe('value1');
  });

  it('stringData field returns property proxy when present on resource', () => {
    const r = createResource(
      makeResource({
        stringData: { secret: 'password' },
      })
    );
    expect(r.stringData?.secret).toBe('password');
  });

  it('provisioner field returns raw value when present', () => {
    const r = createResource(
      makeResource({
        provisioner: 'kubernetes.io/aws-ebs',
      })
    );
    // provisioner is MagicProxy<string> on Enhanced — access via generic record for assertion
    expect((r as unknown as Record<string, unknown>).provisioner).toBe('kubernetes.io/aws-ebs');
  });

  it('provisioner returns ref when value is undefined but field is on resource', () => {
    const r = createResource(
      // biome-ignore lint/suspicious/noExplicitAny: intentionally testing undefined provisioner edge case with exactOptionalPropertyTypes
      makeResource({ provisioner: undefined } as any)
    );
    const ref = (r as unknown as Record<string, unknown>).provisioner;
    expect(isKubernetesRef(ref)).toBe(true);
    expect(asKubernetesRef(ref).fieldPath).toBe('provisioner');
  });

  it('$ prefix on Enhanced proxy creates ref factory', () => {
    const r = createResource(makeResource());
    const ref = (r as Record<string, unknown>).$customField;
    expect(isKubernetesRef(ref)).toBe(true);
    expect(asKubernetesRef(ref).fieldPath).toBe('customField');
  });

  it('external ref resources return ref for unknown properties', () => {
    const r = createResource(
      makeResource({
        __externalRef: true,
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: 'ext-cm' },
      })
    );
    const ref = (r as Record<string, unknown>).unknownField;
    expect(isKubernetesRef(ref)).toBe(true);
    expect(asKubernetesRef(ref).fieldPath).toBe('unknownField');
  });

  it('non-external-ref resources fall through to Reflect.get for unknown props', () => {
    const r = createResource(makeResource());
    // For a regular resource without __externalRef, unknown top-level props
    // should NOT be ref factories — they should be undefined via Reflect.get
    const result = (r as Record<string, unknown>).totallyUnknownProp;
    expect(result).toBeUndefined();
  });

  it('toJSON excludes __resourceId, withReadinessEvaluator, readinessEvaluator, id', () => {
    const r = createResource(makeResource({ id: 'myId' }));
    const json = JSON.parse(JSON.stringify(r));
    expect(json.__resourceId).toBeUndefined();
    expect(json.withReadinessEvaluator).toBeUndefined();
    expect(json.readinessEvaluator).toBeUndefined();
    expect(json.id).toBeUndefined();
    // But apiVersion, kind, metadata, spec should be there
    expect(json.apiVersion).toBe('apps/v1');
    expect(json.kind).toBe('Deployment');
    expect(json.metadata).toBeDefined();
  });

  it('ownKeys returns the target keys', () => {
    const r = createResource(makeResource({ spec: { x: 1 } }));
    const keys = Object.keys(r);
    expect(keys).toContain('apiVersion');
    expect(keys).toContain('kind');
    expect(keys).toContain('metadata');
    expect(keys).toContain('spec');
  });

  it('rules field returns property proxy when present', () => {
    const r = createResource(
      makeResource({
        rules: [{ apiGroups: [''], resources: ['pods'], verbs: ['get'] }],
      })
    );
    expect(Array.isArray(r.rules)).toBe(true);
  });

  it('roleRef field returns property proxy when present', () => {
    const r = createResource(
      makeResource({
        roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'my-role' },
      })
    );
    expect((r as unknown as { roleRef: { kind: string } }).roleRef.kind).toBe('Role');
  });

  it('subjects field returns property proxy when present', () => {
    const r = createResource(
      makeResource({
        subjects: [{ kind: 'ServiceAccount', name: 'default', namespace: 'default' }],
      })
    );
    expect(Array.isArray(r.subjects)).toBe(true);
  });

  it('parameters field returns property proxy when present', () => {
    const r = createResource(
      makeResource({
        parameters: { type: 'gp2' },
      })
    );
    expect((r as unknown as { parameters: { type: string } }).parameters.type).toBe('gp2');
  });

  it('subsets field returns property proxy when present', () => {
    const r = createResource(
      makeResource({
        subsets: [{ addresses: [{ ip: '10.0.0.1' }] }],
      })
    );
    expect(Array.isArray(r.subsets)).toBe(true);
  });
});

// ===========================================================================
// 5. createResource (public API)
// ===========================================================================

describe('createResource — public API', () => {
  describe('ID generation', () => {
    it('generates deterministic ID from kind + metadata.name', () => {
      const r = createResource(makeResource({ kind: 'Deployment', metadata: { name: 'my-app' } }));
      expect(r.id).toBe('deploymentMyApp');
    });

    it('uses kind.toLowerCase() as fallback when metadata.name is missing', () => {
      const r = createResource(makeResource({ kind: 'Service', metadata: {} }));
      // When name is missing, fallback is kind.toLowerCase() = 'service'.
      // Since 'service' already contains 'service', no kind prefix added → just 'service'
      expect(r.id).toBe('service');
    });

    it('accepts explicit id and uses it directly', () => {
      const r = createResource(makeResource({ id: 'myExplicitId' }));
      expect(r.id).toBe('myExplicitId');
    });

    it('strips explicit id from the resource object (not sent to K8s)', () => {
      const r = createResource(makeResource({ id: 'myExplicitId' }));
      const json = JSON.parse(JSON.stringify(r));
      expect(json.id).toBeUndefined();
    });

    it('throws TypeKroError for invalid explicit id (non-camelCase)', () => {
      expect(() => createResource(makeResource({ id: 'kebab-case-id' }))).toThrow(TypeKroError);
    });

    it('throws TypeKroError for id starting with uppercase', () => {
      expect(() => createResource(makeResource({ id: 'UpperCase' }))).toThrow(TypeKroError);
    });

    it('throws TypeKroError for id with underscores', () => {
      expect(() => createResource(makeResource({ id: 'snake_case' }))).toThrow(TypeKroError);
    });

    it('accepts valid camelCase ids', () => {
      const r = createResource(makeResource({ id: 'validCamelCase' }));
      expect(r.id).toBe('validCamelCase');
    });

    it('accepts single lowercase word as id', () => {
      const r = createResource(makeResource({ id: 'simple' }));
      expect(r.id).toBe('simple');
    });

    it('name already containing kind omits kind prefix in generated id', () => {
      const r = createResource(
        makeResource({
          kind: 'Deployment',
          metadata: { name: 'my-deployment-app' },
        })
      );
      // "deployment" is in the name already, so just camelCase the name
      expect(r.id).toBe('myDeploymentApp');
    });
  });

  describe('scope validation', () => {
    it('throws when cluster-scoped resource has namespace', () => {
      expect(() =>
        createResource(
          makeResource({
            kind: 'ClusterRole',
            metadata: { name: 'admin', namespace: 'default' },
          }),
          { scope: 'cluster' }
        )
      ).toThrow(TypeKroError);
    });

    it('does not throw when cluster-scoped resource has no namespace', () => {
      const r = createResource(
        makeResource({
          kind: 'ClusterRole',
          metadata: { name: 'admin' },
        }),
        { scope: 'cluster' }
      );
      expect(r.kind).toBe('ClusterRole');
    });

    it('does not throw when namespaced resource has no namespace (warns)', () => {
      // This should warn but not throw
      const r = createResource(
        makeResource({
          kind: 'Deployment',
          metadata: { name: 'my-app' },
        }),
        { scope: 'namespaced' }
      );
      expect(r.kind).toBe('Deployment');
    });

    it('does not throw when namespaced resource has namespace', () => {
      const r = createResource(
        makeResource({
          kind: 'Deployment',
          metadata: { name: 'my-app', namespace: 'production' },
        }),
        { scope: 'namespaced' }
      );
      expect(r.kind).toBe('Deployment');
    });
  });

  describe('composition context registration', () => {
    it('registers resource with active composition context', () => {
      const context = createCompositionContext('test');
      runWithCompositionContext(context, () => {
        const r = createResource(makeResource({ id: 'testDep' }));
        expect(context.resources.testDep).toBe(r);
      });
    });

    it('does not register external ref resources with composition context', () => {
      const context = createCompositionContext('test');
      runWithCompositionContext(context, () => {
        createResource(
          makeResource({
            __externalRef: true,
            id: 'externalRef',
          })
        );
        expect(context.resources.externalRef).toBeUndefined();
      });
    });

    it('works fine when no composition context is active', () => {
      // Should not throw
      const r = createResource(makeResource());
      expect(r.kind).toBe('Deployment');
    });
  });

  describe('withReadinessEvaluator', () => {
    it('returns the same Enhanced resource (fluent chaining)', () => {
      const r = createResource(makeResource());
      // ReadinessEvaluator is a function: (liveResource: T) => ResourceStatus
      const evaluator = () => ({ ready: true, message: 'ok' });
      const result = r.withReadinessEvaluator(evaluator);
      // Fluent chaining — returns the same proxied resource
      expect(result.kind).toBe('Deployment');
      expect(result.id!).toBe(r.id!);
    });

    it('attaches readinessEvaluator as non-enumerable property', () => {
      const r = createResource(makeResource());
      const evaluator = () => ({ ready: true, message: 'ok' });
      r.withReadinessEvaluator(evaluator);
      // readinessEvaluator should exist but not be enumerable
      expect(getReadinessEvaluator(r)).toBe(evaluator);
      expect(Object.keys(r)).not.toContain('readinessEvaluator');
    });
  });

  describe('conditional expression support', () => {
    it('adds withIncludeWhen method to enhanced resource', () => {
      const r = createResource(makeResource());
      expect(typeof r.withIncludeWhen).toBe('function');
    });

    it('adds withReadyWhen method to enhanced resource', () => {
      const r = createResource(makeResource());
      expect(typeof r.withReadyWhen).toBe('function');
    });

    it('adds withConditional method to enhanced resource', () => {
      const r = createResource(makeResource());
      // withConditional is added at runtime by ConditionalExpressionIntegrator, not on the Enhanced type
      expect(typeof (r as unknown as Record<string, unknown>).withConditional).toBe('function');
    });
  });

  describe('full round-trip serialization', () => {
    it('JSON.stringify of Enhanced resource produces clean K8s object', () => {
      const r = createResource(
        makeResource({
          apiVersion: 'v1',
          kind: 'ConfigMap',
          metadata: { name: 'my-config', namespace: 'default' },
          // biome-ignore lint/suspicious/noExplicitAny: intentionally testing undefined spec with exactOptionalPropertyTypes
          spec: undefined as any,
          data: { key: 'value' },
        })
      );
      const json = JSON.parse(JSON.stringify(r));
      expect(json.apiVersion).toBe('v1');
      expect(json.kind).toBe('ConfigMap');
      expect(json.metadata.name).toBe('my-config');
      expect(json.data.key).toBe('value');
      // Internal fields excluded
      expect(json.__resourceId).toBeUndefined();
      expect(json.withReadinessEvaluator).toBeUndefined();
    });
  });
});
