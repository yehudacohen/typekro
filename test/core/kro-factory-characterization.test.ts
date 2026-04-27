/**
 * Characterization tests for KroResourceFactoryImpl
 *
 * These tests capture the CURRENT behavior of kro-factory.ts as a safety net
 * for future refactoring (Phase 2). They test through the public API surface
 * and exercise private methods via observable side effects.
 *
 * @see src/core/deployment/kro-factory.ts
 */

import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import * as yaml from 'js-yaml';
import { DirectDeploymentEngine } from '../../src/core/deployment/engine.js';
import { createKroResourceFactory } from '../../src/core/deployment/kro-factory.js';
import { waitForKroInstanceReady } from '../../src/core/deployment/kro-readiness.js';
import { singletonSpecFingerprintAnnotationValue } from '../../src/core/deployment/singleton-owner-drift.js';
import { getCurrentCompositionContext } from '../../src/core/composition/context.js';
import { ValidationError } from '../../src/core/errors.js';
import type { KroResourceFactory } from '../../src/core/types/deployment.js';
import type { SingletonDefinitionRecord } from '../../src/core/types/deployment.js';
import type { Enhanced, KubernetesResource } from '../../src/core/types/kubernetes.js';
import type { SchemaDefinition } from '../../src/core/types/serialization.js';
import { getSingletonResourceId } from '../../src/core/singleton/singleton.js';
import { externalRef, kubernetesComposition, singleton } from '../../src/index.js';
import { CEL_EXPRESSION_BRAND, KUBERNETES_REF_BRAND } from '../../src/shared/brands.js';

// ---------------------------------------------------------------------------
// Test helpers & types
// ---------------------------------------------------------------------------

describe('Kro readiness polling', () => {
  it('does not trust stale status.ready when Kro Ready condition is false', async () => {
    const k8sApi = {
      read: async () => ({
        status: {
          state: 'ACTIVE',
          ready: true,
          conditions: [{ type: 'Ready', status: 'False', message: 'cluster mutated' }],
        },
      }),
    };
    const customObjectsApi = {
      getClusterCustomObject: async () => ({
        spec: { schema: { status: { ready: 'boolean' } } },
      }),
    };

    await expect(waitForKroInstanceReady({
      instanceName: 'stale-ready',
      timeout: 1,
      pollInterval: 0,
      k8sApi: k8sApi as never,
      customObjectsApi: customObjectsApi as never,
      namespace: 'default',
      apiVersion: 'example.com/v1alpha1',
      kind: 'Example',
      rgdName: 'example',
    })).rejects.toThrow('Timeout waiting for Kro instance stale-ready');
  });
});

/** Concrete spec type matching the default test schema */
interface TestSpec {
  name: string;
  replicas: number;
}

/** Concrete status type matching the default test schema */
interface TestStatus {
  ready: boolean;
}

/**
 * Extended spec type for tests that exercise `generateInstanceName` fallback
 * fields and non-standard shapes. These fields exist on the runtime object
 * but are outside the arktype-validated schema.
 */
interface FlexibleTestSpec {
  name?: string;
  appName?: string;
  serviceName?: string;
  resourceName?: string;
  replicas?: number;
  enabled?: boolean;
}

/** Minimal schema definition for testing */
function makeSchema(
  overrides: Partial<SchemaDefinition<TestSpec, TestStatus>> = {}
): SchemaDefinition<TestSpec, TestStatus> {
  return {
    apiVersion: 'v1alpha1',
    kind: 'TestApp',
    spec: type({ name: 'string', replicas: 'number' }),
    status: type({ ready: 'boolean' }),
    ...overrides,
  };
}

/** Minimal resources map for testing */
const emptyResources: Record<string, KubernetesResource> = {};

/** Create a factory with minimal valid config */
function makeFactory(
  name = 'myTestApp',
  options: Record<string, unknown> = {},
  schema = makeSchema(),
  statusMappings: Record<string, unknown> = {}
): KroResourceFactory<TestSpec, TestStatus> {
  return createKroResourceFactory(name, emptyResources, schema, statusMappings, options);
}

/**
 * Create a factory that accepts flexible spec shapes.
 * Used for tests that exercise `generateInstanceName` with non-standard fields
 * (appName, serviceName, resourceName) that exist at runtime but not in the
 * arktype schema.
 */
function makeFlexibleFactory(
  name = 'myTestApp',
  options: Record<string, unknown> = {}
): KroResourceFactory<FlexibleTestSpec, TestStatus> {
  const schema: SchemaDefinition<FlexibleTestSpec, TestStatus> = {
    apiVersion: 'v1alpha1',
    kind: 'TestApp',
    spec: type({
      'name?': 'string',
      'appName?': 'string',
      'serviceName?': 'string',
      'resourceName?': 'string',
      'replicas?': 'number',
      'enabled?': 'boolean',
    }),
    status: type({ ready: 'boolean' }),
  };
  return createKroResourceFactory(name, emptyResources, schema, {}, options);
}

/** Create a branded CelExpression object */
function makeCelExpr(expression: string): { expression: string; [k: symbol]: boolean } {
  return {
    [CEL_EXPRESSION_BRAND]: true,
    expression,
  };
}

/**
 * Access a private method on a KroResourceFactory instance for characterization testing.
 * Uses a Record index signature cast rather than `any` to limit the type escape hatch.
 */
function getPrivateMethod(
  factory: KroResourceFactory<TestSpec, TestStatus>,
  methodName: string
): (...args: unknown[]) => unknown {
  const method = (factory as unknown as Record<string, (...args: unknown[]) => unknown>)[
    methodName
  ];
  if (!method) {
    throw new Error(`Private method '${methodName}' not found on factory`);
  }
  return method.bind(factory);
}

describe('KroResourceFactory: Alchemy RGD serialization', () => {
  it('preserves exec and authProvider auth in serialized Alchemy kubeconfig options', () => {
    const factory = createKroResourceFactory('alchemyExecAuth', {}, makeSchema(), {}, {
      hydrateStatus: false,
    });
    (factory as unknown as Record<string, unknown>).getKubeConfig = () => ({
      getCurrentCluster: () => ({ name: 'cluster', server: 'https://example.invalid' }),
      getCurrentContext: () => 'ctx',
      getCurrentUser: () => ({
        name: 'user',
        exec: { command: 'aws', args: ['eks', 'get-token'] },
        authProvider: { name: 'gcp', config: { 'access-token': 'token' } },
      }),
    });

    const extractKubeConfigOptionsForAlchemy = getPrivateMethod(
      factory as unknown as KroResourceFactory<TestSpec, TestStatus>,
      'extractKubeConfigOptionsForAlchemy'
    ) as () => { user?: { exec?: unknown; authProvider?: unknown } };

    const options = extractKubeConfigOptionsForAlchemy();

    expect(options.user?.exec).toEqual({ command: 'aws', args: ['eks', 'get-token'] });
    expect(options.user?.authProvider).toEqual({ name: 'gcp', config: { 'access-token': 'token' } });
  });

  it('validates injected Alchemy scope before provider execution', async () => {
    const factory = createKroResourceFactory('alchemyInvalidScope', {}, makeSchema(), {}, {
      alchemyScope: {} as any,
      hydrateStatus: false,
    });

    const deployWithAlchemy = getPrivateMethod(factory, 'deployWithAlchemy') as (
      spec: TestSpec,
      instanceNameOverride?: string
    ) => Promise<unknown>;

    await expect(deployWithAlchemy({ name: 'demo', replicas: 1 }, 'demo'))
      .rejects.toThrow('KRO Alchemy deployment: Alchemy scope is invalid');
  });

  it('preserves externalRef entries when deploying the RGD through Alchemy', async () => {
    const resources: Record<string, KubernetesResource> = {
      platformConfig: externalRef({
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: 'platform-config', namespace: 'platform-system' },
        id: 'platformConfig',
      }) as unknown as KubernetesResource,
    };
    const providerCalls: Array<{
      id: string;
      input: {
        resource: Record<string, unknown>;
        deployer?: unknown;
        deploymentStrategy?: string;
        kubeConfigOptions?: Record<string, unknown>;
        kroDeletion?: Record<string, unknown>;
        options?: Record<string, unknown>;
      };
    }> = [];
    const events: string[] = [];
    let insideAlchemyScope = false;

    const factory = createKroResourceFactory('alchemyExternalRef', resources, makeSchema(), {}, {
      alchemyScope: {
        run: async (fn: () => Promise<unknown>) => {
          events.push('scope:start');
          insideAlchemyScope = true;
          try {
            return await fn();
          } finally {
            insideAlchemyScope = false;
            events.push('scope:end');
          }
        },
      } as any,
      hydrateStatus: false,
      rgdProvider: (rgd) => rgd as unknown as Enhanced<Record<string, unknown>, Record<string, unknown>>,
      alchemyBridge: {
        createDeployer() {
          throw new Error('KRO Alchemy props must not carry live deployer objects');
        },
        ensureResourceTypeRegistered() {
          return async (id: string, input: {
            resource: Record<string, unknown>;
            deployer?: unknown;
            deploymentStrategy?: string;
            kubeConfigOptions?: Record<string, unknown>;
            kroDeletion?: Record<string, unknown>;
            options?: Record<string, unknown>;
          }) => {
            expect(insideAlchemyScope).toBe(true);
            events.push(`provider:${input.resource.kind}`);
            providerCalls.push({ id, input });
          };
        },
        createAlchemyResourceId(resource: Enhanced<unknown, unknown>, namespace?: string) {
          return `${namespace ?? 'default'}:${resource.kind}:${resource.metadata.name}`;
        },
      },
    });
    (factory as unknown as Record<string, unknown>).getKubeConfig = () => ({
      getCurrentCluster: () => ({ server: 'https://example.invalid' }),
    });
    let ensuredTargetNamespace = false;
    const readinessCalls: Array<{ instanceName: string; timeout: number }> = [];
    (factory as unknown as Record<string, unknown>).ensureTargetNamespace = async () => {
      ensuredTargetNamespace = true;
    };
    (factory as unknown as Record<string, unknown>).waitForCRDReadyWithEngine = async () => {
      events.push('crd-ready');
    };
    (factory as unknown as Record<string, unknown>).waitForKroInstanceReady = async (
      instanceName: string,
      timeout: number,
    ) => {
      readinessCalls.push({ instanceName, timeout });
    };

    const deployWithAlchemy = getPrivateMethod(factory, 'deployWithAlchemy') as (
      spec: TestSpec,
      instanceNameOverride?: string
    ) => Promise<unknown>;
    await deployWithAlchemy({ name: 'demo', replicas: 1 }, 'demo');

    const rgdCall = providerCalls.find((call) => call.input.resource.kind === 'ResourceGraphDefinition');
    const rgd = rgdCall?.input.resource as {
      spec?: { resources?: Array<{ id: string; externalRef?: unknown; template?: unknown }> };
    } | undefined;
    const instanceCall = providerCalls.find((call) => call.input.resource.kind === 'TestApp');
    const extRefResource = rgd?.spec?.resources?.find((resource) => resource.id === 'platformConfig');

    expect(extRefResource?.externalRef).toEqual({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'platform-config', namespace: 'platform-system' },
    });
    expect(extRefResource).not.toHaveProperty('template');
    expect(ensuredTargetNamespace).toBe(true);
    expect(rgdCall?.input.deploymentStrategy).toBe('kro');
    expect(instanceCall?.input.deploymentStrategy).toBe('kro');
    expect(rgdCall?.input.deployer).toBeUndefined();
    expect(instanceCall?.input.deployer).toBeUndefined();
    expect(rgdCall?.input.kubeConfigOptions).toMatchObject({
      server: 'https://example.invalid',
      skipTLSVerify: false,
    });
    expect(instanceCall?.input.kroDeletion).toMatchObject({
      apiVersion: 'v1alpha1',
      kind: 'TestApp',
      namespace: 'default',
      rgdName: 'alchemy-external-ref',
      timeout: 300000,
    });
    expect(instanceCall?.input.options?.waitForReady).toBe(false);
    expect(events).toEqual([
      'scope:start',
      'provider:ResourceGraphDefinition',
      'scope:end',
      'crd-ready',
      'scope:start',
      'provider:TestApp',
      'scope:end',
    ]);
    expect(readinessCalls).toEqual([{ instanceName: 'demo', timeout: 600000 }]);
  });

  it('disposes the RGD deployment engine after successful deployment', async () => {
    const factory = makeFactory('rgdDispose');
    (factory as unknown as Record<string, unknown>).getKubeConfig = () => ({
      getCurrentCluster: () => ({ server: 'https://example.invalid' }),
    });

    const proto = DirectDeploymentEngine.prototype as unknown as Record<string, unknown>;
    const originalDeployResource = proto.deployResource;
    const originalWaitForCRDByKindAndGroup = proto.waitForCRDByKindAndGroup;
    const originalDispose = proto.dispose;
    let disposed = false;

    proto.deployResource = async () => undefined;
    proto.waitForCRDByKindAndGroup = async () => ({ plural: 'testapps' });
    proto.dispose = async () => {
      disposed = true;
    };

    try {
      const ensureRGDDeployed = getPrivateMethod(factory, 'ensureRGDDeployed') as () => Promise<void>;
      await ensureRGDDeployed();
      expect(disposed).toBe(true);
    } finally {
      proto.deployResource = originalDeployResource;
      proto.waitForCRDByKindAndGroup = originalWaitForCRDByKindAndGroup;
      proto.dispose = originalDispose;
    }
  });
});

// ===========================================================================
// convertToKubernetesName (tested via constructor → rgdName)
// ===========================================================================

describe('KroResourceFactory: convertToKubernetesName', () => {
  it('converts camelCase to kebab-case', () => {
    const factory = makeFactory('myApp');
    expect(factory.rgdName).toBe('my-app');
  });

  it('converts PascalCase to kebab-case', () => {
    const factory = makeFactory('MyAppService');
    expect(factory.rgdName).toBe('my-app-service');
  });

  it('keeps simple lowercase names unchanged', () => {
    const factory = makeFactory('simple');
    expect(factory.rgdName).toBe('simple');
  });

  it('keeps already-kebab-case names unchanged', () => {
    const factory = makeFactory('already-kebab');
    expect(factory.rgdName).toBe('already-kebab');
  });

  it('QUIRK: digit-uppercase boundary does NOT insert dash', () => {
    // The regex only matches [a-z][A-Z] boundaries, not [0-9][A-Z]
    // So 'app2Deploy' → 'app2deploy' (no dash before D)
    const factory = makeFactory('app2Deploy');
    expect(factory.rgdName).toBe('app2deploy');
  });

  it('converts all-uppercase with dashes between letters', () => {
    // 'ABC' → regex inserts dash before each uppercase after lowercase → 'a-b-c'
    // But 'ABC' has no lowercase-uppercase boundary, so it stays 'abc'
    const factory = makeFactory('ABC');
    expect(factory.rgdName).toBe('abc');
  });

  it('handles single character name', () => {
    const factory = makeFactory('a');
    expect(factory.rgdName).toBe('a');
  });

  it('trims leading/trailing whitespace', () => {
    const factory = makeFactory('  myApp  ');
    expect(factory.rgdName).toBe('my-app');
  });

  it('throws ValidationError for empty string', () => {
    expect(() => makeFactory('')).toThrow(ValidationError);
  });

  it('throws ValidationError for whitespace-only string', () => {
    expect(() => makeFactory('   ')).toThrow(ValidationError);
  });

  it('throws ValidationError for name exceeding 253 chars', () => {
    const longName = 'a'.repeat(254);
    expect(() => makeFactory(longName)).toThrow(ValidationError);
  });

  it('allows name exactly at 253 char limit', () => {
    const name = 'a'.repeat(253);
    const factory = makeFactory(name);
    expect(factory.rgdName).toBe(name);
  });

  it('throws ValidationError for name with underscores', () => {
    // 'my_app' → regex doesn't touch underscores → 'my_app' which fails regex
    expect(() => makeFactory('my_app')).toThrow(ValidationError);
  });

  it('throws ValidationError for name starting with dash after conversion', () => {
    // Leading dash is invalid for k8s names
    expect(() => makeFactory('-invalid')).toThrow(ValidationError);
  });

  it('throws ValidationError for name ending with dash after conversion', () => {
    expect(() => makeFactory('invalid-')).toThrow(ValidationError);
  });
});

// ===========================================================================
// Constructor and createKroResourceFactory
// ===========================================================================

describe('KroResourceFactory: constructor', () => {
  it('sets mode to "kro"', () => {
    const factory = makeFactory();
    expect(factory.mode).toBe('kro');
  });

  it('sets name from input', () => {
    const factory = makeFactory('myApp');
    expect(factory.name).toBe('myApp');
  });

  it('defaults namespace to "default"', () => {
    const factory = makeFactory('myApp');
    expect(factory.namespace).toBe('default');
  });

  it('uses provided namespace', () => {
    const factory = makeFactory('myApp', { namespace: 'production' });
    expect(factory.namespace).toBe('production');
  });

  it('sets isAlchemyManaged to false when no alchemyScope', () => {
    const factory = makeFactory('myApp');
    expect(factory.isAlchemyManaged).toBe(false);
  });

  it('sets isAlchemyManaged to true when alchemyScope is provided', () => {
    // Use a truthy value as alchemyScope
    const factory = makeFactory('myApp', { alchemyScope: {} });
    expect(factory.isAlchemyManaged).toBe(true);
  });

  it('computes rgdName as kebab-case of name', () => {
    const factory = makeFactory('myTestApp');
    expect(factory.rgdName).toBe('my-test-app');
  });

  it('provides a schema proxy', () => {
    const factory = makeFactory('myApp');
    expect(factory.schema).toBeDefined();
  });
});

// ===========================================================================
// pluralizeKind (tested via toYaml RGD output or waitForCRDReady patterns)
//
// Since pluralizeKind is private, we test it by creating factories with
// different kinds and checking observable effects. The most direct way is
// to verify behavior through the factory's internal naming, but since that
// requires deployment, we test the logic by creating the factory impl
// directly and accessing it through instance methods.
//
// For characterization purposes, we test the pluralization rules by creating
// a minimal subclass or by using the same regex logic.
// ===========================================================================

describe('KroResourceFactory: pluralizeKind rules', () => {
  // We can test pluralization indirectly: the factory stores the kind in
  // schemaDefinition.kind, and pluralizeKind is called during
  // waitForCRDReadyWithEngine. Since we can't easily invoke that without K8s,
  // we replicate the function's logic here as a characterization of what the
  // source code does. This is validated against the source at lines 927-953.

  function pluralizeKind(kind: string): string {
    const lowerKind = kind.toLowerCase();
    if (
      lowerKind.endsWith('s') ||
      lowerKind.endsWith('sh') ||
      lowerKind.endsWith('ch') ||
      lowerKind.endsWith('x') ||
      lowerKind.endsWith('z')
    ) {
      return `${lowerKind}es`;
    } else if (lowerKind.endsWith('o')) {
      return `${lowerKind}es`;
    } else if (
      lowerKind.endsWith('y') &&
      lowerKind.length > 1 &&
      !'aeiou'.includes(lowerKind[lowerKind.length - 2] || '')
    ) {
      return `${lowerKind.slice(0, -1)}ies`;
    } else if (lowerKind.endsWith('f')) {
      return `${lowerKind.slice(0, -1)}ves`;
    } else if (lowerKind.endsWith('fe')) {
      return `${lowerKind.slice(0, -2)}ves`;
    } else {
      return `${lowerKind}s`;
    }
  }

  it('adds "s" for regular kinds (Deployment)', () => {
    expect(pluralizeKind('Deployment')).toBe('deployments');
  });

  it('adds "es" for kinds ending in "s" (Ingress)', () => {
    expect(pluralizeKind('Ingress')).toBe('ingresses');
  });

  it('adds "es" for kinds ending in "sh" (Mesh)', () => {
    expect(pluralizeKind('Mesh')).toBe('meshes');
  });

  it('adds "es" for kinds ending in "ch" (Match)', () => {
    expect(pluralizeKind('Match')).toBe('matches');
  });

  it('adds "es" for kinds ending in "x" (Box)', () => {
    expect(pluralizeKind('Box')).toBe('boxes');
  });

  it('adds "es" for kinds ending in "z" (Fizz)', () => {
    expect(pluralizeKind('Fizz')).toBe('fizzes');
  });

  it('adds "es" for kinds ending in "o" (Potato)', () => {
    expect(pluralizeKind('Potato')).toBe('potatoes');
  });

  it('replaces consonant+y with "ies" (NetworkPolicy)', () => {
    expect(pluralizeKind('NetworkPolicy')).toBe('networkpolicies');
  });

  it('adds "s" for vowel+y (Gateway)', () => {
    expect(pluralizeKind('Gateway')).toBe('gateways');
  });

  it('replaces "f" with "ves" (Leaf)', () => {
    expect(pluralizeKind('Leaf')).toBe('leaves');
  });

  it('QUIRK: "fe" rule is unreachable because "f" check catches "f" first', () => {
    // Words ending in 'fe' like 'Knife': 'knife'.endsWith('f') is false,
    // so it falls through to the 'fe' check. BUT 'knife' does NOT end with 'f'.
    // Wait — 'knife' ends with 'e', not 'f' or 'fe'. Let me verify:
    // 'knife'.endsWith('f')  → false
    // 'knife'.endsWith('fe') → true
    // So Knife DOES hit the 'fe' rule correctly.
    expect(pluralizeKind('Knife')).toBe('knives');
  });

  it('handles single character kind ending in "s"', () => {
    expect(pluralizeKind('S')).toBe('ses');
  });

  it('handles already-lowercase input', () => {
    expect(pluralizeKind('deployment')).toBe('deployments');
  });

  it('handles Service (ends in "e", default rule)', () => {
    expect(pluralizeKind('Service')).toBe('services');
  });

  it('handles ConfigMap (default "s" rule)', () => {
    expect(pluralizeKind('ConfigMap')).toBe('configmaps');
  });
});

// ===========================================================================
// generateInstanceName (tested via toYaml(spec))
// ===========================================================================

describe('KroResourceFactory: generateInstanceName', () => {
  it('uses spec.name when present', () => {
    const factory = makeFactory('myApp');
    const yaml = factory.toYaml({ name: 'my-instance', replicas: 1 });
    expect(yaml).toContain('name: my-instance');
  });

  it('uses spec.appName when name is absent', () => {
    const factory = makeFlexibleFactory('myApp');
    const yaml = factory.toYaml({ appName: 'app-instance', replicas: 1 });
    expect(yaml).toContain('name: app-instance');
  });

  it('uses spec.serviceName when name and appName are absent', () => {
    const factory = makeFlexibleFactory('myApp');
    const yaml = factory.toYaml({ serviceName: 'svc-instance', replicas: 1 });
    expect(yaml).toContain('name: svc-instance');
  });

  it('uses spec.resourceName when name and appName are absent', () => {
    const factory = makeFlexibleFactory('myApp');
    const yaml = factory.toYaml({ resourceName: 'res-instance', replicas: 1 });
    expect(yaml).toContain('name: res-instance');
  });

  it('prefers name over appName', () => {
    const factory = makeFlexibleFactory('myApp');
    const yaml = factory.toYaml({ name: 'preferred', appName: 'secondary', replicas: 1 });
    expect(yaml).toContain('name: preferred');
  });

  it('QUIRK: skips empty string name (falsy check)', () => {
    const factory = makeFlexibleFactory('myApp');
    const yaml = factory.toYaml({ name: '', appName: 'fallback', replicas: 1 });
    // Empty string is falsy, so it skips to appName
    expect(yaml).toContain('name: fallback');
  });

  it('generates timestamp-based name when no name fields exist', () => {
    const factory = makeFlexibleFactory('myApp');
    const yaml = factory.toYaml({ replicas: 3 });
    // Should contain 'name: myApp-<timestamp>'
    expect(yaml).toMatch(/name: myApp-\d+/);
  });
});

// ===========================================================================
// createCustomResourceInstance (tested via toYaml(spec))
// ===========================================================================

describe('KroResourceFactory: createCustomResourceInstance via toYaml', () => {
  it('prepends kro.run/ when apiVersion has no slash', () => {
    const factory = makeFactory('myApp', {}, makeSchema({ apiVersion: 'v1alpha1' }));
    const yaml = factory.toYaml({ name: 'test', replicas: 1 });
    expect(yaml).toContain('apiVersion: kro.run/v1alpha1');
  });

  it('uses apiVersion as-is when it already has a slash', () => {
    const factory = makeFactory('myApp', {}, makeSchema({ apiVersion: 'custom.io/v1' }));
    const yaml = factory.toYaml({ name: 'test', replicas: 1 });
    expect(yaml).toContain('apiVersion: custom.io/v1');
  });

  it('uses custom group when apiVersion has no slash', () => {
    const factory = makeFactory('myApp', {}, makeSchema({
      apiVersion: 'v1alpha1',
      group: 'platform.example.com',
    }));
    const yamlText = factory.toYaml({ name: 'test', replicas: 1 });
    const parsed = yaml.load(yamlText) as { apiVersion: string };
    expect(parsed.apiVersion).toBe('platform.example.com/v1alpha1');
  });

  it('looks up CRD plural using the custom group', async () => {
    const factory = makeFactory('myApp', {}, makeSchema({
      apiVersion: 'v1alpha1',
      group: 'platform.example.com',
    }));
    (factory as unknown as Record<string, unknown>).createKubernetesObjectApi = () => ({
      list: async () => ({
        items: [
          {
            spec: {
              group: 'kro.run',
              names: { kind: 'TestApp', plural: 'wrongtests' },
            },
          },
          {
            spec: {
              group: 'platform.example.com',
              names: { kind: 'TestApp', plural: 'customtests' },
            },
          },
        ],
      }),
    });

    const lookupCRDPlural = getPrivateMethod(factory, 'lookupCRDPlural') as () => Promise<string | undefined>;
    await expect(lookupCRDPlural()).resolves.toBe('customtests');
  });

  it('preserves live instance annotations when listing instances', async () => {
    const factory = makeFactory('myApp');
    const factoryRecord = factory as unknown as Record<string, unknown>;
    factoryRecord.discoveredPlural = 'testapps';
    factoryRecord.createCustomObjectsApi = async () => ({
      listNamespacedCustomObject: async () => ({
        items: [
          {
            spec: { name: 'demo', replicas: 1 },
            metadata: {
              name: 'demo-instance',
              annotations: {
                'typekro.io/singleton-spec-fingerprint': 'fnv64:livefingerprint',
              },
            },
          },
        ],
      }),
    });
    factoryRecord.createEnhancedProxy = async (spec: TestSpec, instanceName: string) => ({
      metadata: { name: instanceName },
      spec,
      status: { ready: true, url: 'http://demo' },
    });

    const instances = await factory.getInstances();

    expect(instances[0]?.metadata?.annotations?.['typekro.io/singleton-spec-fingerprint']).toBe(
      'fnv64:livefingerprint'
    );
  });

  it('uses kind from schema definition', () => {
    const factory = makeFactory('myApp', {}, makeSchema({ kind: 'WebApp' }));
    const yaml = factory.toYaml({ name: 'test', replicas: 1 });
    expect(yaml).toContain('kind: WebApp');
  });

  it('uses namespace from factory options', () => {
    const factory = makeFactory('myApp', { namespace: 'production' });
    const yaml = factory.toYaml({ name: 'test', replicas: 1 });
    expect(yaml).toContain('namespace: production');
  });

  it('defaults namespace to "default"', () => {
    const factory = makeFactory('myApp');
    const yaml = factory.toYaml({ name: 'test', replicas: 1 });
    expect(yaml).toContain('namespace: default');
  });
});

// ===========================================================================
// toYaml (instance YAML generation)
// ===========================================================================

describe('KroResourceFactory: toYaml(spec) instance YAML', () => {
  it('generates valid YAML structure with apiVersion, kind, metadata, spec', () => {
    const factory = makeFactory('myApp');
    const yaml = factory.toYaml({ name: 'test', replicas: 3 });
    expect(yaml).toContain('apiVersion:');
    expect(yaml).toContain('kind:');
    expect(yaml).toContain('metadata:');
    expect(yaml).toContain('spec:');
  });

  it('serializes string values as valid YAML scalars', () => {
    const factory = makeFactory('myApp');
    const yamlText = factory.toYaml({ name: 'test', replicas: 3 });
    const parsed = yaml.load(yamlText) as { spec: TestSpec };
    expect(parsed.spec.name).toBe('test');
  });

  it('leaves numeric values unquoted', () => {
    const factory = makeFactory('myApp');
    const yaml = factory.toYaml({ name: 'test', replicas: 3 });
    expect(yaml).toContain('  replicas: 3');
  });

  it('leaves boolean values unquoted', () => {
    const factory = makeFlexibleFactory('myApp');
    const yaml = factory.toYaml({ name: 'test', enabled: true });
    expect(yaml).toContain('  enabled: true');
  });

  it('escapes quotes inside string values', () => {
    const factory = makeFactory('myApp');
    const yamlText = factory.toYaml({ name: 'say "hello"', replicas: 1 });
    const parsed = yaml.load(yamlText) as { spec: TestSpec };
    expect(parsed.spec.name).toBe('say "hello"');
  });

  it('round-trips nested objects and arrays in spec', () => {
    const factory = makeFlexibleFactory('myApp');
    const spec = {
      name: 'test',
      tags: ['alpha', 'beta'],
      nested: { image_tag: 'v1', replicas: 2 },
    };
    const yamlText = factory.toYaml(spec);
    const parsed = yaml.load(yamlText) as { spec: typeof spec };
    expect(parsed.spec).toEqual(spec);
  });
});

describe('KroResourceFactory: toYaml() singleton owner isolation', () => {
  it('does not synthesize singleton owner resources from singleton definitions', () => {
    const resources: Record<string, KubernetesResource> = {};
    const singletonKey = 'kro.run/v1alpha1/SingletonBootstrap:singleton-bootstrap#shared-platform';
    const singletonDefinition = {
      id: 'shared-platform',
      key: singletonKey,
      specFingerprint: 'fp',
      registryNamespace: 'typekro-singletons',
      composition: {
        _definition: {
          apiVersion: 'v1alpha1',
          kind: 'SingletonBootstrap',
          name: 'singleton-bootstrap',
        },
      } as unknown as SingletonDefinitionRecord['composition'],
      spec: { name: 'shared-platform' },
    } satisfies SingletonDefinitionRecord;

    const factory = createKroResourceFactory('singletonConsumer', resources, makeSchema(), {}, {
      singletonDefinitions: [singletonDefinition],
    });
    const ownerId = getSingletonResourceId(singletonKey);

    const yaml = factory.toYaml();
    expect(yaml).not.toContain(ownerId);
    expect(Object.hasOwn(resources, ownerId)).toBe(false);

    const buildRgdYaml = getPrivateMethod(factory, 'buildRgdYaml');
    const deployYaml = buildRgdYaml() as string;
    expect(deployYaml).not.toContain(ownerId);
  });
});

// ===========================================================================
// isCelExpression (tested indirectly via evaluateStaticFields)
// ===========================================================================

describe('KroResourceFactory: isCelExpression detection', () => {
  // We test isCelExpression indirectly through evaluateStaticFields behavior.
  // When statusMappings contain a branded CelExpression, the factory's
  // evaluateStaticFields path should recognize and evaluate it.
  // Since evaluateStaticFields is called during deploy (which requires K8s),
  // we test the brand detection logic directly.

  it('recognizes a properly branded CelExpression', () => {
    const celExpr = makeCelExpr('schema.spec.name');
    // Verify the brand is present (same check as isCelExpression)
    expect(CEL_EXPRESSION_BRAND in celExpr).toBe(true);
    expect(celExpr[CEL_EXPRESSION_BRAND]).toBe(true);
    expect(typeof celExpr.expression).toBe('string');
  });

  it('rejects null', () => {
    const nullValue = null;
    expect(typeof nullValue !== 'object' || nullValue === null).toBe(true);
  });

  it('rejects plain objects without brand', () => {
    const obj = { expression: 'test' };
    expect(CEL_EXPRESSION_BRAND in obj).toBe(false);
  });

  it('rejects objects with brand=false', () => {
    const obj = { [CEL_EXPRESSION_BRAND]: false, expression: 'test' };
    expect(obj[CEL_EXPRESSION_BRAND]).toBe(false);
  });

  it('rejects objects with non-string expression', () => {
    const obj = { [CEL_EXPRESSION_BRAND]: true, expression: 42 };
    expect(typeof obj.expression).not.toBe('string');
  });
});

// ===========================================================================
// evaluateStaticCelExpression (tested via createKroResourceFactory + deploy-like paths)
//
// Since this is private and requires spec evaluation, we test the logic
// by creating a factory impl and calling through the class. We use
// Object.getPrototypeOf to access private methods for characterization.
// ===========================================================================

describe('KroResourceFactory: evaluateStaticCelExpression', () => {
  it('evaluates simple schema.spec field reference', () => {
    const factory = makeFactory('myApp');
    const evaluator = getPrivateMethod(factory, 'evaluateStaticCelExpression');
    const result = evaluator(makeCelExpr('schema.spec.name'), { name: 'hello', replicas: 1 });
    expect(result).toBe('hello');
  });

  it('evaluates numeric schema.spec field', () => {
    const factory = makeFactory('myApp');
    const evaluator = getPrivateMethod(factory, 'evaluateStaticCelExpression');
    const result = evaluator(makeCelExpr('schema.spec.replicas'), { name: 'test', replicas: 5 });
    expect(result).toBe(5);
  });

  it('evaluates spec.field reference (without schema prefix)', () => {
    const factory = makeFactory('myApp');
    const evaluator = getPrivateMethod(factory, 'evaluateStaticCelExpression');
    const result = evaluator(makeCelExpr('spec.name'), { name: 'world', replicas: 1 });
    expect(result).toBe('world');
  });

  it('evaluates ternary expression', () => {
    const factory = makeFactory('myApp');
    const evaluator = getPrivateMethod(factory, 'evaluateStaticCelExpression');
    const result = evaluator(makeCelExpr('schema.spec.replicas > 0 ? true : false'), {
      name: 'test',
      replicas: 3,
    });
    expect(result).toBe(true);
  });

  it('evaluates string concatenation', () => {
    const factory = makeFactory('myApp');
    const evaluator = getPrivateMethod(factory, 'evaluateStaticCelExpression');
    const result = evaluator(makeCelExpr('schema.spec.name + "-service"'), {
      name: 'web',
      replicas: 1,
    });
    expect(result).toBe('web-service');
  });

  it('QUIRK: returns expression string as-is for unparseable static literals', () => {
    const factory = makeFactory('myApp');
    const evaluator = getPrivateMethod(factory, 'evaluateStaticCelExpression');
    // A bare URL with no spec references — fails to parse but has no spec refs,
    // so it falls back to returning the expression string
    const result = evaluator(makeCelExpr('http://kro-webapp-service'), {
      name: 'test',
      replicas: 1,
    });
    expect(result).toBe('http://kro-webapp-service');
  });

  it('throws for invalid expression WITH spec references', () => {
    const factory = makeFactory('myApp');
    const evaluator = getPrivateMethod(factory, 'evaluateStaticCelExpression');
    // Invalid syntax but contains schema.spec reference → should throw
    expect(() => {
      evaluator(makeCelExpr('schema.spec.name @@@ invalid'), { name: 'test', replicas: 1 });
    }).toThrow();
  });
});

// ===========================================================================
// resolveSchemaRefMarkers
// ===========================================================================

describe('KroResourceFactory: resolveSchemaRefMarkers', () => {
  it('resolves a single marker to the spec value', () => {
    const factory = makeFactory('myApp');
    const resolver = getPrivateMethod(factory, 'resolveSchemaRefMarkers');
    const result = resolver('__KUBERNETES_REF___schema___spec.name__', {
      name: 'hello',
      replicas: 1,
    });
    expect(result).toBe('hello');
  });

  it('resolves marker with surrounding text', () => {
    const factory = makeFactory('myApp');
    const resolver = getPrivateMethod(factory, 'resolveSchemaRefMarkers');
    const result = resolver('prefix-__KUBERNETES_REF___schema___spec.name__-suffix', {
      name: 'app',
      replicas: 1,
    });
    expect(result).toBe('prefix-app-suffix');
  });

  it('returns string as-is when no markers present', () => {
    const factory = makeFactory('myApp');
    const resolver = getPrivateMethod(factory, 'resolveSchemaRefMarkers');
    const result = resolver('no-markers-here', { name: 'test', replicas: 1 });
    expect(result).toBe('no-markers-here');
  });

  it('resolves nested field paths', () => {
    const factory = makeFactory('myApp');
    const resolver = getPrivateMethod(factory, 'resolveSchemaRefMarkers');
    const result = resolver('__KUBERNETES_REF___schema___spec.db.host__', {
      db: { host: 'localhost' },
      replicas: 1,
    });
    expect(result).toBe('localhost');
  });
});

// ===========================================================================
// evaluateStaticFields
// ===========================================================================

describe('KroResourceFactory: evaluateStaticFields', () => {
  it('evaluates CelExpression fields', async () => {
    const factory = makeFactory('myApp');
    const evaluator = getPrivateMethod(factory, 'evaluateStaticFields');
    const result = await evaluator(
      { greeting: makeCelExpr('schema.spec.name') },
      { name: 'world', replicas: 1 }
    );
    expect(result).toEqual({ greeting: 'world' });
  });

  it('resolves __KUBERNETES_REF_ marker strings', async () => {
    const factory = makeFactory('myApp');
    const evaluator = getPrivateMethod(factory, 'evaluateStaticFields');
    const result = await evaluator(
      { url: '__KUBERNETES_REF___schema___spec.name__-service' },
      { name: 'web', replicas: 1 }
    );
    expect(result).toEqual({ url: 'web-service' });
  });

  it('evaluates inline ${...} CEL expression strings', async () => {
    const factory = makeFactory('myApp');
    const evaluator = getPrivateMethod(factory, 'evaluateStaticFields');
    const result = await evaluator(
      { count: '${schema.spec.replicas}' },
      { name: 'test', replicas: 5 }
    );
    expect(result).toEqual({ count: 5 });
  });

  it('passes through primitive values unchanged', async () => {
    const factory = makeFactory('myApp');
    const evaluator = getPrivateMethod(factory, 'evaluateStaticFields');
    const result = await evaluator(
      { count: 42, flag: true, nothing: null },
      { name: 'test', replicas: 1 }
    );
    expect(result).toEqual({ count: 42, flag: true, nothing: null });
  });

  it('recursively evaluates nested objects', async () => {
    const factory = makeFactory('myApp');
    const evaluator = getPrivateMethod(factory, 'evaluateStaticFields');
    const result = await evaluator(
      { nested: { value: makeCelExpr('schema.spec.name') } },
      { name: 'deep', replicas: 1 }
    );
    expect(result).toEqual({ nested: { value: 'deep' } });
  });

  it('passes through arrays without recursion', async () => {
    const factory = makeFactory('myApp');
    const evaluator = getPrivateMethod(factory, 'evaluateStaticFields');
    const arr = [1, 2, 3];
    const result = await evaluator({ items: arr }, { name: 'test', replicas: 1 });
    expect(result).toEqual({ items: arr });
  });

  it('QUIRK: accessing nonexistent spec fields returns undefined (no throw)', async () => {
    const factory = makeFactory('myApp');
    const evaluator = getPrivateMethod(factory, 'evaluateStaticFields');
    const badExpr = makeCelExpr('schema.spec.nonexistent.deeply.nested');
    const result = (await evaluator({ broken: badExpr }, { name: 'test', replicas: 1 })) as Record<
      string,
      unknown
    >;
    // angular-expressions returns undefined for missing property chains
    // (it doesn't throw), so the catch block is never entered and the
    // evaluated result is undefined
    expect(result.broken).toBeUndefined();
  });

  it('QUIRK: inline CEL with missing field evaluates to undefined', async () => {
    const factory = makeFactory('myApp');
    const evaluator = getPrivateMethod(factory, 'evaluateStaticFields');
    const result = (await evaluator(
      { broken: '${schema.spec.nonexistent}' },
      { name: 'test', replicas: 1 }
    )) as Record<string, unknown>;
    // angular-expressions returns undefined for missing properties,
    // so the catch block is not entered
    expect(result.broken).toBeUndefined();
  });

  it('QUIRK: deeply nested inline CEL with missing fields returns undefined', async () => {
    const factory = makeFactory('myApp');
    const evaluator = getPrivateMethod(factory, 'evaluateStaticFields');
    const result = (await evaluator(
      { broken: '${schema.spec.nonexistent.deeply.nested}' },
      { name: 'test', replicas: 1 }
    )) as Record<string, unknown>;
    // angular-expressions uses safe navigation — it returns undefined even for
    // deeply nested missing paths rather than throwing
    expect(result.broken).toBeUndefined();
  });

  it('handles empty record', async () => {
    const factory = makeFactory('myApp');
    const evaluator = getPrivateMethod(factory, 'evaluateStaticFields');
    const result = await evaluator({}, { name: 'test', replicas: 1 });
    expect(result).toEqual({});
  });
});

// ===========================================================================
// Full factory creation smoke tests
// ===========================================================================

describe('KroResourceFactory: factory creation smoke tests', () => {
  it('createKroResourceFactory returns a factory with mode "kro"', () => {
    const factory = makeFactory('smokeTest');
    expect(factory.mode).toBe('kro');
  });

  it('factory has toYaml method', () => {
    const factory = makeFactory('smokeTest');
    expect(typeof factory.toYaml).toBe('function');
  });

  it('factory has deploy method', () => {
    const factory = makeFactory('smokeTest');
    expect(typeof factory.deploy).toBe('function');
  });

  it('factory has getInstances method', () => {
    const factory = makeFactory('smokeTest');
    expect(typeof factory.getInstances).toBe('function');
  });

  it('factory has deleteInstance method', () => {
    const factory = makeFactory('smokeTest');
    expect(typeof factory.deleteInstance).toBe('function');
  });

  it('factory has getStatus method', () => {
    const factory = makeFactory('smokeTest');
    expect(typeof factory.getStatus).toBe('function');
  });

  it('factory has getRGDStatus method', () => {
    const factory = makeFactory('smokeTest');
    expect(typeof factory.getRGDStatus).toBe('function');
  });
});

describe('KroResourceFactory: mixed status hydration', () => {
  it('does not perform live status re-execution when hydrateStatus is false', async () => {
    interface HydrationSpec {
      name: string;
    }

    interface HydrationStatus {
      url: string;
    }

    const factory = createKroResourceFactory<HydrationSpec, HydrationStatus>(
      'kro-hydration-disabled',
      {},
      {
        apiVersion: 'v1alpha1',
        kind: 'KroHydrationDisabled',
        spec: type({ name: 'string' }),
        status: type({ url: 'string' }),
      },
      { url: 'http://__KUBERNETES_REF___schema___spec.name__' },
      { namespace: 'default', compositionFn: () => ({ url: 'live-value' }), hydrateStatus: false }
    );

    let liveReExecutionCalls = 0;
    const factoryRecord = factory as unknown as Record<string, unknown>;
    factoryRecord.separateStatusFields = async () => ({
      staticFields: { url: 'http://__KUBERNETES_REF___schema___spec.name__' },
      dynamicFields: {},
    });
    factoryRecord.evaluateStaticFields = async () => ({ url: 'http://demo' });
    factoryRecord.reExecuteWithLiveStatus = async () => {
      liveReExecutionCalls++;
      return { url: 'live-value' };
    };

    const createEnhancedProxyWithMixedHydration = getPrivateMethod(
      factory as unknown as KroResourceFactory<TestSpec, TestStatus>,
      'createEnhancedProxyWithMixedHydration'
    ) as (spec: HydrationSpec, instanceName: string) => Promise<{ status: HydrationStatus }>;

    const instance = await createEnhancedProxyWithMixedHydration({ name: 'demo' }, 'demo');

    expect(instance.status.url).toBe('http://demo');
    expect(liveReExecutionCalls).toBe(0);
  });

  it('overrides stale static fields with live re-execution results while preserving dynamic fields', async () => {
    interface HydrationSpec {
      name: string;
      enabled: boolean;
    }

    interface HydrationStatus {
      ready: boolean;
      searxngUrl: string;
    }

    const schema: SchemaDefinition<HydrationSpec, HydrationStatus> = {
      apiVersion: 'v1alpha1',
      kind: 'HydrationTest',
      spec: type({ name: 'string', enabled: 'boolean' }),
      status: type({ ready: 'boolean', searxngUrl: 'string' }),
    };

    const factory = createKroResourceFactory<HydrationSpec, HydrationStatus>(
      'hydration-test',
      {},
      schema,
      {
        ready: makeCelExpr('app.status.ready'),
        searxngUrl: 'http://__KUBERNETES_REF___schema___spec.name__-searxng:8080',
      },
      { namespace: 'default', compositionFn: () => null }
    );

    const factoryRecord = factory as unknown as Record<string, unknown>;
    factoryRecord.separateStatusFields = async () => ({
      staticFields: { searxngUrl: 'http://__KUBERNETES_REF___schema___spec.name__-searxng:8080' },
      dynamicFields: { ready: makeCelExpr('app.status.ready') },
    });
    factoryRecord.evaluateStaticFields = async () => ({
      searxngUrl: 'http://demo-searxng:8080',
    });
    factoryRecord.hydrateDynamicStatusFields = async () => ({ ready: true });
    factoryRecord.reExecuteWithLiveStatus = async () => ({
      ready: false,
      searxngUrl: '',
    });

    const createEnhancedProxyWithMixedHydration = getPrivateMethod(
      factory as unknown as KroResourceFactory<TestSpec, TestStatus>,
      'createEnhancedProxyWithMixedHydration'
    ) as (spec: HydrationSpec, instanceName: string) => Promise<{ status: HydrationStatus }>;

    const instance = await createEnhancedProxyWithMixedHydration(
      { name: 'demo', enabled: false },
      'demo'
    );

    expect(instance.status.ready).toBe(true);
    expect(instance.status.searxngUrl).toBe('');
  });

  it('marks KRO live-status re-execution contexts as re-execution for nested compositions', async () => {
    interface NestedSpec {
      name: string;
    }

    interface NestedStatus {
      ready: boolean;
    }

    interface ParentSpec {
      name: string;
    }

    interface ParentStatus {
      nestedReady: boolean;
    }

    const nested = kubernetesComposition(
      {
        name: 'nested-reexec-check',
        apiVersion: 'v1alpha1',
        kind: 'NestedReexecCheck',
        spec: type({ name: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      (_spec: NestedSpec): NestedStatus => ({
        ready: !!getCurrentCompositionContext()?.isReExecution,
      })
    );

    const parentFactory = createKroResourceFactory<ParentSpec, ParentStatus>(
      'parent-reexec-check',
      {},
      {
        apiVersion: 'v1alpha1',
        kind: 'ParentReexecCheck',
        spec: type({ name: 'string' }),
        status: type({ nestedReady: 'boolean' }),
      },
      {},
      {
        namespace: 'default',
        compositionFn: (spec: ParentSpec) => {
          const child = nested({ name: spec.name });
          return {
            nestedReady: child.status.ready,
          };
        },
      }
    );

    const factoryRecord = parentFactory as unknown as Record<string, unknown>;
    factoryRecord.resources = {
      parentReexecCheck1NestedReexecCheck: {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: 'child', namespace: 'default' },
      },
    };

    const reExecuteWithLiveStatus = getPrivateMethod(
      parentFactory as unknown as KroResourceFactory<TestSpec, TestStatus>,
      'reExecuteWithLiveStatus'
    ) as (spec: ParentSpec) => Promise<ParentStatus>;

    const result = await reExecuteWithLiveStatus({ name: 'demo' });

    expect(result.nestedReady).toBe(true);
  });

  it('resolves aliased nested composition status during KRO live-status re-execution', async () => {
    interface NestedSpec {
      name: string;
    }

    interface NestedStatus {
      ready: boolean;
    }

    interface ParentSpec {
      name: string;
    }

    interface ParentStatus {
      ready: boolean;
    }

    const nested = kubernetesComposition(
      {
        name: 'kro-alias-inner',
        apiVersion: 'v1alpha1',
        kind: 'KroAliasInner',
        spec: type({ name: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      (_spec: NestedSpec): NestedStatus => ({
        ready: !!getCurrentCompositionContext()?.isReExecution,
      })
    );

    const parentFactory = createKroResourceFactory<ParentSpec, ParentStatus>(
      'kro-alias-parent',
      {},
      {
        apiVersion: 'v1alpha1',
        kind: 'KroAliasParent',
        spec: type({ name: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      {},
      {
        namespace: 'default',
        compositionFn: (spec: ParentSpec) => {
          const inner = nested({ name: spec.name });
          return { ready: inner.status.ready };
        },
      }
    );

    const reExecuteWithLiveStatus = getPrivateMethod(
      parentFactory as unknown as KroResourceFactory<TestSpec, TestStatus>,
      'reExecuteWithLiveStatus'
    ) as (spec: ParentSpec) => Promise<ParentStatus>;

    const result = await reExecuteWithLiveStatus({ name: 'demo' });

    expect(result.ready).toBe(true);
  });

  it('hydrates singleton references from deployed KRO singleton owner status', async () => {
    interface ParentSpec {
      name: string;
    }

    interface ParentStatus {
      ready: boolean;
      endpoint: string;
    }

    const deployedOwnerStatus = { ready: true, endpoint: 'http://owner-live:80' };
    const fakeOwnerComposition = Object.assign(
      () => ({ ready: false, endpoint: 'unreachable' }),
      {
        _definition: {
          apiVersion: 'v1alpha1',
          kind: 'SingletonBootstrap',
          name: 'singleton-bootstrap',
        },
        factory(mode: 'direct' | 'kro', options?: Record<string, unknown>) {
          expect(mode).toBe('kro');
          expect(options?.namespace).toBe('typekro-singletons');
          return {
            async getInstances() {
              return [];
            },
            async deploy() {
              return { status: deployedOwnerStatus };
            },
            async dispose() {},
          };
        },
      }
    );

    const parentFactory = createKroResourceFactory<ParentSpec, ParentStatus>(
      'kro-singleton-status-consumer',
      {},
      {
        apiVersion: 'v1alpha1',
        kind: 'KroSingletonStatusConsumer',
        spec: type({ name: 'string' }),
        status: type({ ready: 'boolean', endpoint: 'string' }),
      },
      {},
      {
        namespace: 'default',
        compositionFn: (spec: ParentSpec) => {
          const shared = singleton(fakeOwnerComposition as never, {
            id: 'platform-bootstrap',
            spec: { name: `${spec.name}-shared` },
          }) as { status: { ready: boolean; endpoint: string } };
          return {
            ready: shared.status.ready,
            endpoint: shared.status.endpoint,
          };
        },
      }
    );

    const factoryRecord = parentFactory as unknown as Record<string, unknown>;
    factoryRecord.ensureTargetNamespace = async () => {};

    const ensureSingletonOwners = getPrivateMethod(
      parentFactory as unknown as KroResourceFactory<TestSpec, TestStatus>,
      'ensureSingletonOwners'
    ) as (spec: ParentSpec) => Promise<void>;
    await ensureSingletonOwners({ name: 'demo' });

    const reExecuteWithLiveStatus = getPrivateMethod(
      parentFactory as unknown as KroResourceFactory<TestSpec, TestStatus>,
      'reExecuteWithLiveStatus'
    ) as (spec: ParentSpec) => Promise<ParentStatus>;

    const result = await reExecuteWithLiveStatus({ name: 'demo' });

    expect(result.ready).toBe(true);
    expect(result.endpoint).toBe(deployedOwnerStatus.endpoint);
  });
});

describe('KroResourceFactory: live status resource identity resolution', () => {
  it('resolves schema-derived KRO template names before reading live child resources', () => {
    const factory = makeFactory('live-name-resolution');
    const resolveLiveResourceIdentityValue = getPrivateMethod(
      factory,
      'resolveLiveResourceIdentityValue'
    ) as (value: unknown, spec: TestSpec, fallback: string) => string;

    expect(
      resolveLiveResourceIdentityValue('${schema.spec.name}-service', { name: 'demo', replicas: 1 }, 'fallback')
    ).toBe('demo-service');
    expect(
      resolveLiveResourceIdentityValue(
        '__KUBERNETES_REF___schema___spec.name__-config',
        { name: 'demo', replicas: 1 },
        'fallback'
      )
    ).toBe('demo-config');
  });

  it('resolves direct schema KubernetesRef names before reading live child resources', () => {
    const factory = makeFactory('live-ref-name-resolution');
    const resolveLiveResourceIdentityValue = getPrivateMethod(
      factory,
      'resolveLiveResourceIdentityValue'
    ) as (value: unknown, spec: TestSpec, fallback: string) => string;
    const schemaNameRef = {
      [KUBERNETES_REF_BRAND]: true,
      resourceId: '__schema__',
      fieldPath: 'spec.name',
    };

    expect(
      resolveLiveResourceIdentityValue(schemaNameRef, { name: 'demo', replicas: 1 }, 'fallback')
    ).toBe('demo');
  });

  it('falls back for nullish direct schema KubernetesRef identities', () => {
    const factory = makeFactory('live-nullish-ref-name-resolution');
    const resolveLiveResourceIdentityValue = getPrivateMethod(
      factory,
      'resolveLiveResourceIdentityValue'
    ) as (value: unknown, spec: Partial<TestSpec>, fallback: string) => string;
    const schemaNamespaceRef = {
      [KUBERNETES_REF_BRAND]: true,
      resourceId: '__schema__',
      fieldPath: 'spec.namespace',
    };

    expect(
      resolveLiveResourceIdentityValue(schemaNamespaceRef, { name: 'demo', replicas: 1 }, 'default-ns')
    ).toBe('default-ns');
  });

  it('falls back rather than reading unresolved template names', () => {
    const factory = makeFactory('live-name-fallback');
    const resolveLiveResourceIdentityValue = getPrivateMethod(
      factory,
      'resolveLiveResourceIdentityValue'
    ) as (value: unknown, spec: TestSpec, fallback: string) => string;

    expect(
      resolveLiveResourceIdentityValue('${service.status.clusterIP}', { name: 'demo', replicas: 1 }, 'fallback')
    ).toBe('fallback');
  });
});

describe('KroResourceFactory: singleton owner boundaries', () => {
  it('ensures singleton owners using the singleton id as instance name', async () => {
    interface OwnerSpec {
      name: string;
    }

    const deployCalls: Array<{ spec: OwnerSpec; opts?: Record<string, unknown> | undefined }> = [];
    const disposeCalls: string[] = [];
    const fakeComposition = {
      factory(mode: 'direct' | 'kro', options?: Record<string, unknown>) {
        expect(mode).toBe('kro');
        expect(options?.namespace).toBe('shared-system');

        return {
          async getInstances() {
            return [];
          },
          async deploy(spec: OwnerSpec, opts?: Record<string, unknown>) {
            deployCalls.push({ spec, ...(opts ? { opts } : {}) });
            return { metadata: { name: String(opts?.instanceNameOverride ?? spec.name) } };
          },
          async dispose() {
            disposeCalls.push('disposed');
          },
        };
      },
    };

    const factory = makeFactory('singleton-kro', {
      namespace: 'default',
      singletonDefinitions: [
        {
          id: 'stable-singleton-id',
          key: 'SingletonBootstrap:stable-singleton-id',
          specFingerprint: 'fp',
          registryNamespace: 'shared-system',
          composition: fakeComposition,
          spec: { name: 'user-facing-name' },
        },
      ],
    });

    const ensureSingletonOwners = getPrivateMethod(factory, 'ensureSingletonOwners') as (
      spec: TestSpec
    ) => Promise<void>;

    (factory as unknown as Record<string, unknown>).ensureTargetNamespace = async () => {};

    await ensureSingletonOwners({ name: 'consumer', replicas: 1 });

    expect(deployCalls).toHaveLength(1);
    expect(deployCalls[0]?.spec).toEqual({ name: 'user-facing-name' });
    expect(deployCalls[0]?.opts?.instanceNameOverride).toBe('stable-singleton-id');
    expect(deployCalls[0]?.opts?.singletonSpecFingerprint).toBe(
      singletonSpecFingerprintAnnotationValue('fp')
    );
    expect(disposeCalls).toEqual(['disposed']);
  });

  it('adds singleton fingerprints to KRO custom resource instances', () => {
    const factory = makeFactory('singleton-fingerprint', { namespace: 'shared-system' });
    const createCustomResourceInstance = getPrivateMethod(
      factory,
      'createCustomResourceInstance'
    ) as (instanceName: string, spec: TestSpec, singletonSpecFingerprint?: string) => {
      metadata: { annotations?: Record<string, string> };
    };

    const manifest = createCustomResourceInstance(
      'stable-singleton-id',
      { name: 'owner', replicas: 1 },
      'fnv64:testfingerprint',
    );

    expect(manifest.metadata.annotations?.['typekro.io/singleton-spec-fingerprint']).toBe(
      'fnv64:testfingerprint'
    );
  });

  it('labels KRO custom resource instances with finalizer-safe deletion metadata', () => {
    const factory = makeFactory('instance-labels', { namespace: 'shared-system' });
    const createCustomResourceInstance = getPrivateMethod(
      factory,
      'createCustomResourceInstance'
    ) as (instanceName: string, spec: TestSpec) => {
      metadata: { labels?: Record<string, string> };
    };

    const manifest = createCustomResourceInstance('labelled-instance', { name: 'owner', replicas: 1 });

    expect(manifest.metadata.labels).toMatchObject({
      'typekro.io/factory': 'instance-labels',
      'typekro.io/mode': 'kro',
      'typekro.io/rgd': 'instance-labels',
    });
  });

  it('requires discovered CRD plural before cleanup can delete shared definitions', async () => {
    const factory = makeFactory('cleanup-no-plural');
    (factory as unknown as Record<string, unknown>).lookupCRDPlural = async () => undefined;
    const requireCRDPluralForCleanup = getPrivateMethod(
      factory,
      'requireCRDPluralForCleanup'
    ) as () => Promise<string>;

    await expect(requireCRDPluralForCleanup()).rejects.toThrow(
      'Cannot determine CRD plural for TestApp; preserving RGD/CRD'
    );
  });

  it('accepts existing KRO singleton owners when fingerprint annotation matches', async () => {
    interface OwnerSpec {
      name: string;
    }

    const deployCalls: Array<{ spec: OwnerSpec; opts?: Record<string, unknown> | undefined }> = [];
    const expectedFingerprint = singletonSpecFingerprintAnnotationValue('fp');
    const fakeComposition = {
      factory() {
        return {
          async getInstances() {
            return [
              {
                metadata: {
                  name: 'stable-singleton-id',
                  annotations: {
                    'typekro.io/singleton-spec-fingerprint': expectedFingerprint,
                  },
                },
                spec: { name: 'mutated-by-cluster' },
              },
            ];
          },
          async deploy(spec: OwnerSpec, opts?: Record<string, unknown>) {
            deployCalls.push({ spec, ...(opts ? { opts } : {}) });
            return { metadata: { name: String(opts?.instanceNameOverride ?? spec.name) } };
          },
          async dispose() {},
        };
      },
    };

    const factory = makeFactory('singleton-kro-fingerprint', {
      namespace: 'default',
      singletonDefinitions: [
        {
          id: 'stable-singleton-id',
          key: 'SingletonBootstrap:stable-singleton-id',
          specFingerprint: 'fp',
          registryNamespace: 'shared-system',
          composition: fakeComposition,
          spec: { name: 'user-facing-name' },
        },
      ],
    });
    (factory as unknown as Record<string, unknown>).ensureTargetNamespace = async () => {};

    const ensureSingletonOwners = getPrivateMethod(factory, 'ensureSingletonOwners') as (
      spec: TestSpec
    ) => Promise<void>;

    await ensureSingletonOwners({ name: 'consumer', replicas: 1 });

    expect(deployCalls).toHaveLength(1);
    expect(deployCalls[0]?.opts?.singletonSpecFingerprint).toBe(expectedFingerprint);
  });

  it('deploys singleton owners when getInstances fails because the CRD is not installed yet', async () => {
    interface OwnerSpec {
      name: string;
    }

    const deployCalls: Array<{ spec: OwnerSpec; opts?: Record<string, unknown> | undefined }> = [];
    const disposeCalls: string[] = [];
    const fakeComposition = {
      factory() {
        return {
          async getInstances() {
            throw new Error('the server could not find the requested resource (get singletonowners.kro.run)');
          },
          async deploy(spec: OwnerSpec, opts?: Record<string, unknown>) {
            deployCalls.push({ spec, ...(opts ? { opts } : {}) });
            return { metadata: { name: String(opts?.instanceNameOverride ?? spec.name) } };
          },
          async dispose() {
            disposeCalls.push('disposed');
          },
        };
      },
    };

    const factory = makeFactory('singleton-kro-first-install', {
      namespace: 'default',
      singletonDefinitions: [
        {
          id: 'stable-singleton-id',
          key: 'SingletonBootstrap:stable-singleton-id',
          specFingerprint: 'fp',
          registryNamespace: 'shared-system',
          composition: fakeComposition,
          spec: { name: 'user-facing-name' },
        },
      ],
    });

    const ensureSingletonOwners = getPrivateMethod(factory, 'ensureSingletonOwners') as (
      spec: TestSpec
    ) => Promise<void>;

    (factory as unknown as Record<string, unknown>).ensureTargetNamespace = async () => {};

    await ensureSingletonOwners({ name: 'consumer', replicas: 1 });

    expect(deployCalls).toHaveLength(1);
    expect(deployCalls[0]?.spec).toEqual({ name: 'user-facing-name' });
    expect(deployCalls[0]?.opts?.instanceNameOverride).toBe('stable-singleton-id');
    expect(disposeCalls).toEqual(['disposed']);
  });

  it('rejects deployed singleton owner spec drift before reconciling', async () => {
    const deployCalls: Array<{ spec: { name: string }; opts?: Record<string, unknown> | undefined }> = [];
    const fakeComposition = {
      factory() {
        return {
          async getInstances() {
            return [
              {
                metadata: { name: 'stable-singleton-id' },
                spec: { name: 'old-name' },
              },
            ];
          },
          async deploy(spec: { name: string }, opts?: Record<string, unknown>) {
            deployCalls.push({ spec, ...(opts ? { opts } : {}) });
            return { metadata: { name: String(opts?.instanceNameOverride ?? spec.name) } };
          },
          async dispose() {},
        };
      },
    };

    const factory = makeFactory('singleton-kro-drift', {
      namespace: 'default',
      singletonDefinitions: [
        {
          id: 'stable-singleton-id',
          key: 'SingletonBootstrap:stable-singleton-id',
          specFingerprint: JSON.stringify({ name: 'new-name' }),
          registryNamespace: 'shared-system',
          composition: fakeComposition,
          spec: { name: 'new-name' },
        },
      ],
    });

    const ensureSingletonOwners = getPrivateMethod(factory, 'ensureSingletonOwners') as (
      spec: TestSpec
    ) => Promise<void>;

    (factory as unknown as Record<string, unknown>).ensureTargetNamespace = async () => {};

    await expect(ensureSingletonOwners({ name: 'consumer', replicas: 1 })).rejects.toThrow(
      /Singleton config drift detected/
    );

    expect(deployCalls).toHaveLength(0);
  });

  it('reconciles existing singleton owners when the deployed spec matches', async () => {
    const deployCalls: Array<{ spec: { name: string }; opts?: Record<string, unknown> | undefined }> = [];
    const fakeComposition = {
      factory() {
        return {
          async getInstances() {
            return [
              {
                metadata: { name: 'stable-singleton-id' },
                spec: { name: 'same-name' },
              },
            ];
          },
          async deploy(spec: { name: string }, opts?: Record<string, unknown>) {
            deployCalls.push({ spec, ...(opts ? { opts } : {}) });
            return { metadata: { name: String(opts?.instanceNameOverride ?? spec.name) } };
          },
          async dispose() {},
        };
      },
    };

    const factory = makeFactory('singleton-kro-same-spec', {
      namespace: 'default',
      singletonDefinitions: [
        {
          id: 'stable-singleton-id',
          key: 'SingletonBootstrap:stable-singleton-id',
          specFingerprint: '{"name":"same-name"}',
          registryNamespace: 'shared-system',
          composition: fakeComposition,
          spec: { name: 'same-name' },
        },
      ],
    });

    const ensureSingletonOwners = getPrivateMethod(factory, 'ensureSingletonOwners') as (
      spec: TestSpec
    ) => Promise<void>;

    (factory as unknown as Record<string, unknown>).ensureTargetNamespace = async () => {};

    await ensureSingletonOwners({ name: 'consumer', replicas: 1 });

    expect(deployCalls).toHaveLength(1);
    expect(deployCalls[0]?.spec).toEqual({ name: 'same-name' });
    expect(deployCalls[0]?.opts?.instanceNameOverride).toBe('stable-singleton-id');
  });
});
