/**
 * Centralized typed mock factories for test utilities
 *
 * These factories eliminate `as any` casts in test files by providing
 * properly-typed mock objects for common testing patterns.
 */

import { expect, mock } from 'bun:test';
import type * as k8s from '@kubernetes/client-node';
import type { CelExpression, KubernetesRef } from '../../src/core/types/common.js';
import type { Enhanced, ResourceStatus } from '../../src/core/types/kubernetes.js';
import { CEL_EXPRESSION_BRAND, KUBERNETES_REF_BRAND } from '../../src/shared/brands.js';

// =============================================================================
// READINESS EVALUATOR ACCESS
// =============================================================================

/**
 * Safely extract the readinessEvaluator from an Enhanced resource.
 *
 * The readinessEvaluator is defined on the Enhanced type but set as a non-enumerable
 * property at runtime. This helper provides type-safe access without `as any`.
 *
 * @returns The readiness evaluator function, or undefined if not set.
 */
export function getReadinessEvaluator<TSpec, TStatus>(
  enhanced: Enhanced<TSpec, TStatus>
): ((liveResource: unknown) => ResourceStatus) | undefined {
  return enhanced.readinessEvaluator;
}

/**
 * Assert that an Enhanced resource has a readiness evaluator and return it.
 * Throws if the evaluator is not present.
 */
export function requireReadinessEvaluator<TSpec, TStatus>(
  enhanced: Enhanced<TSpec, TStatus>
): (liveResource: unknown) => ResourceStatus {
  const evaluator = enhanced.readinessEvaluator;
  if (!evaluator) {
    throw new Error('Expected Enhanced resource to have a readinessEvaluator');
  }
  return evaluator;
}

// =============================================================================
// KUBERNETES API MOCKS
// =============================================================================

/**
 * Options for creating a mock K8s API
 */
interface MockK8sApiOptions {
  /** Default resource to return from read() */
  readResult?: k8s.KubernetesObject;
  /** Default resource to return from create() */
  createResult?: k8s.KubernetesObject;
  /** Default resource to return from patch() */
  patchResult?: k8s.KubernetesObject;
  /** If true, read() will reject with a 404 error */
  readNotFound?: boolean;
}

/**
 * Create a typed mock of k8s.KubernetesObjectApi with common methods stubbed.
 *
 * Eliminates the pattern: `{ read: mock(...), create: mock(...) } as any`
 */
export function createMockK8sApi(options: MockK8sApiOptions = {}): k8s.KubernetesObjectApi {
  const defaultResource: k8s.KubernetesObject = options.readResult ?? {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: 'test', namespace: 'default' },
  };

  const readFn = options.readNotFound
    ? mock(() => Promise.reject(Object.assign(new Error('Not Found'), { statusCode: 404 })))
    : mock(() => Promise.resolve(options.readResult ?? defaultResource));

  const api = {
    read: readFn,
    create: mock(() => Promise.resolve(options.createResult ?? defaultResource)),
    patch: mock(() => Promise.resolve(options.patchResult ?? defaultResource)),
    delete: mock(() => Promise.resolve({})),
    list: mock(() => Promise.resolve({ items: [] })),
    replace: mock(() => Promise.resolve(options.readResult ?? defaultResource)),
  } as unknown as k8s.KubernetesObjectApi;

  return api;
}

/**
 * Create a typed mock of k8s.KubeConfig.
 *
 * Eliminates the pattern: `{ makeApiClient: mock(...) } as any`
 */
export function createMockKubeConfig(
  overrides: Partial<{
    server: string;
    currentContext: string;
  }> = {}
): k8s.KubeConfig {
  const kubeConfig = {
    loadFromDefault: mock(() => undefined),
    loadFromCluster: mock(() => undefined),
    loadFromFile: mock(() => undefined),
    loadFromString: mock(() => undefined),
    makeApiClient: mock(() => ({})),
    getCurrentCluster: mock(() => ({
      name: 'mock-cluster',
      server: overrides.server ?? 'https://mock-kubernetes-api:6443',
    })),
    getCurrentContext: mock(() => overrides.currentContext ?? 'mock-context'),
    getContexts: mock(() => [{ name: 'mock-context', cluster: 'mock-cluster' }]),
    getClusters: mock(() => [
      {
        name: 'mock-cluster',
        server: overrides.server ?? 'https://mock-kubernetes-api:6443',
      },
    ]),
    getCurrentUser: mock(() => ({ name: 'mock-user', token: 'mock-token' })),
    getUsers: mock(() => [{ name: 'mock-user' }]),
    applyToFetchOptions: mock((opts: RequestInit) => Promise.resolve(opts)),
    applyToHTTPSOptions: mock((opts: Record<string, unknown>) => opts),
  } as unknown as k8s.KubeConfig;

  return kubeConfig;
}

// =============================================================================
// PARTIAL KUBERNETES RESOURCE BUILDERS
// =============================================================================

/**
 * Create a partial Deployment resource for readiness evaluation testing.
 *
 * Eliminates the pattern:
 * ```typescript
 * { status: { readyReplicas: 3 } } as any
 * ```
 */
export function createPartialDeployment(overrides: {
  readyReplicas?: number;
  availableReplicas?: number;
  replicas?: number;
  updatedReplicas?: number;
  unavailableReplicas?: number;
  conditions?: Array<{ type: string; status: string; reason?: string; message?: string }>;
  specReplicas?: number;
  name?: string;
  namespace?: string;
}): Record<string, unknown> {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: overrides.name ?? 'test-deployment',
      namespace: overrides.namespace ?? 'default',
    },
    spec: {
      replicas: overrides.specReplicas ?? overrides.replicas ?? 1,
    },
    status: {
      readyReplicas: overrides.readyReplicas,
      availableReplicas: overrides.availableReplicas,
      replicas: overrides.replicas,
      updatedReplicas: overrides.updatedReplicas,
      unavailableReplicas: overrides.unavailableReplicas,
      conditions: overrides.conditions,
    },
  };
}

/**
 * Create a partial StatefulSet resource for readiness evaluation testing.
 */
export function createPartialStatefulSet(overrides: {
  readyReplicas?: number;
  currentReplicas?: number;
  updatedReplicas?: number;
  replicas?: number;
  specReplicas?: number;
  updateStrategy?: string;
  name?: string;
}): Record<string, unknown> {
  return {
    apiVersion: 'apps/v1',
    kind: 'StatefulSet',
    metadata: {
      name: overrides.name ?? 'test-statefulset',
      namespace: 'default',
    },
    spec: {
      replicas: overrides.specReplicas ?? overrides.replicas ?? 1,
      updateStrategy: { type: overrides.updateStrategy ?? 'RollingUpdate' },
    },
    status: {
      readyReplicas: overrides.readyReplicas,
      currentReplicas: overrides.currentReplicas,
      updatedReplicas: overrides.updatedReplicas,
      replicas: overrides.replicas,
    },
  };
}

/**
 * Create a partial Service resource for readiness evaluation testing.
 */
export function createPartialService(overrides: {
  type?: string;
  clusterIP?: string;
  externalName?: string;
  loadBalancerIngress?: Array<{ ip?: string; hostname?: string }>;
  name?: string;
}): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: overrides.name ?? 'test-service',
      namespace: 'default',
    },
    spec: {
      type: overrides.type ?? 'ClusterIP',
      clusterIP: overrides.clusterIP,
      externalName: overrides.externalName,
    },
    status: {
      loadBalancer: {
        ingress: overrides.loadBalancerIngress,
      },
    },
  };
}

/**
 * Create a partial Pod resource for readiness evaluation testing.
 */
export function createPartialPod(overrides: {
  phase?: string;
  conditions?: Array<{ type: string; status: string }>;
  name?: string;
}): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: overrides.name ?? 'test-pod',
      namespace: 'default',
    },
    status: {
      phase: overrides.phase ?? 'Running',
      conditions: overrides.conditions,
    },
  };
}

/**
 * Create a partial Namespace resource for readiness evaluation testing.
 */
export function createPartialNamespace(overrides: {
  phase?: string;
  name?: string;
}): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: {
      name: overrides.name ?? 'test-namespace',
    },
    status: {
      phase: overrides.phase ?? 'Active',
    },
  };
}

/**
 * Create a partial Job resource for readiness evaluation testing.
 */
export function createPartialJob(overrides: {
  succeeded?: number;
  failed?: number;
  active?: number;
  completionTime?: string;
  conditions?: Array<{ type: string; status: string }>;
  name?: string;
}): Record<string, unknown> {
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: overrides.name ?? 'test-job',
      namespace: 'default',
    },
    status: {
      succeeded: overrides.succeeded,
      failed: overrides.failed,
      active: overrides.active,
      completionTime: overrides.completionTime,
      conditions: overrides.conditions,
    },
  };
}

/**
 * Create a partial CronJob resource for readiness evaluation testing.
 */
export function createPartialCronJob(overrides: {
  lastScheduleTime?: string;
  lastSuccessfulTime?: string;
  active?: Record<string, unknown>[];
  suspend?: boolean;
  name?: string;
}): Record<string, unknown> {
  return {
    apiVersion: 'batch/v1',
    kind: 'CronJob',
    metadata: {
      name: overrides.name ?? 'test-cronjob',
      namespace: 'default',
    },
    spec: {
      suspend: overrides.suspend ?? false,
    },
    status: {
      lastScheduleTime: overrides.lastScheduleTime,
      lastSuccessfulTime: overrides.lastSuccessfulTime,
      active: overrides.active,
    },
  };
}

// =============================================================================
// DEPLOYED RESOURCE HELPERS
// =============================================================================

/**
 * Create a DeployedResource-compatible object for testing.
 */
export function createMockDeployedResource(overrides: {
  id?: string;
  kind?: string;
  name?: string;
  namespace?: string;
  status?: 'deployed' | 'ready' | 'failed';
  manifest?: Record<string, unknown>;
}): {
  id: string;
  kind: string;
  name: string;
  namespace: string;
  manifest: Record<string, unknown>;
  status: string;
  deployedAt: Date;
} {
  const kind = overrides.kind ?? 'Deployment';
  const name = overrides.name ?? 'test-resource';
  return {
    id: overrides.id ?? `${name}-id`,
    kind,
    name,
    namespace: overrides.namespace ?? 'default',
    manifest: overrides.manifest ?? {
      apiVersion: 'apps/v1',
      kind,
      metadata: { name, namespace: overrides.namespace ?? 'default' },
    },
    status: overrides.status ?? 'deployed',
    deployedAt: new Date(),
  };
}

// =============================================================================
// KUBERNETES REF TEST HELPERS
// =============================================================================

/**
 * Type-safe representation of a KubernetesRef object at runtime.
 *
 * At runtime, KubernetesRef values are callable functions with branded symbol properties.
 * TypeScript types them as their declared type (boolean, string, etc.), so tests need
 * a way to inspect the proxy internals without `as any`.
 */
interface KubernetesRefRuntime {
  readonly [key: symbol]: true;
  readonly resourceId: string;
  readonly fieldPath: string;
  readonly __nestedComposition?: boolean;
  readonly __externalRef?: boolean;
}

/**
 * Cast a value to KubernetesRefRuntime for inspecting proxy internals.
 *
 * Use this instead of `(value as any).resourceId` etc.
 *
 * @example
 * ```ts
 * const ref = asKubernetesRef(deployment.status.readyReplicas);
 * expect(ref.resourceId).toBe('deployment');
 * expect(ref.fieldPath).toBe('status.readyReplicas');
 * ```
 */
export function asKubernetesRef(value: unknown): KubernetesRefRuntime {
  return value as KubernetesRefRuntime;
}

/**
 * Assert that a value is a KubernetesRef and optionally validate its properties.
 *
 * Eliminates the pattern:
 * ```ts
 * expect(KUBERNETES_REF_BRAND in (value as any)).toBe(true);
 * expect((value as any).resourceId).toBe('...');
 * expect((value as any).fieldPath).toBe('...');
 * ```
 *
 * @example
 * ```ts
 * expectKubernetesRef(deployment.status.readyReplicas, {
 *   resourceId: 'deploymentMyApp',
 *   fieldPath: 'status.readyReplicas',
 * });
 * ```
 */
export function expectKubernetesRef(
  value: unknown,
  expected?: {
    resourceId?: string;
    fieldPath?: string;
    nestedComposition?: boolean;
    externalRef?: boolean;
  }
): void {
  // KubernetesRefs can be functions (factory proxies) or objects (composition status proxies)
  expect(typeof value === 'function' || typeof value === 'object').toBe(true);
  const ref = value as unknown as KubernetesRefRuntime;
  expect(KUBERNETES_REF_BRAND in ref).toBe(true);

  if (expected?.resourceId !== undefined) {
    expect(ref.resourceId).toBe(expected.resourceId);
  }
  if (expected?.fieldPath !== undefined) {
    expect(ref.fieldPath).toBe(expected.fieldPath);
  }
  if (expected?.nestedComposition !== undefined) {
    expect(ref.__nestedComposition).toBe(expected.nestedComposition);
  }
  if (expected?.externalRef !== undefined) {
    expect(ref.__externalRef).toBe(expected.externalRef);
  }
}

/**
 * Assert that a value is a KubernetesRef (brand check only, no property validation).
 *
 * Eliminates the pattern:
 * ```ts
 * expect(KUBERNETES_REF_BRAND in (field as any)).toBe(true);
 * ```
 */
export function isKubernetesRef(value: unknown): boolean {
  return (
    (typeof value === 'function' || typeof value === 'object') &&
    value !== null &&
    KUBERNETES_REF_BRAND in (value as unknown as KubernetesRefRuntime)
  );
}

// =============================================================================
// MOCK KUBERNETES REF & CEL EXPRESSION FACTORIES
// =============================================================================

/**
 * Create a properly branded KubernetesRef object for testing.
 *
 * Eliminates the pattern:
 * ```ts
 * { resourceId: 'webapp', fieldPath: 'status.ready', _type: 'boolean' } as any
 * ```
 *
 * @example
 * ```ts
 * const ref = createMockKubernetesRef<number>('webapp', 'status.readyReplicas');
 * resourceValidator.validateKubernetesRef(ref, availableResources);
 * ```
 */
export function createMockKubernetesRef<T = unknown>(
  resourceId: string,
  fieldPath: string
): KubernetesRef<T> {
  return {
    [KUBERNETES_REF_BRAND]: true,
    resourceId,
    fieldPath,
    _type: undefined,
  } as KubernetesRef<T>;
}

/**
 * Create a properly branded CelExpression object for testing.
 *
 * Eliminates the pattern:
 * ```ts
 * { expression: 'resources.webapp.status.readyReplicas > 0', _type: 'boolean' } as any
 * ```
 *
 * @example
 * ```ts
 * const cel = createMockCelExpression('resources.webapp.status.readyReplicas > 0');
 * typeInferenceEngine.inferType(cel, context);
 * ```
 */
export function createMockCelExpression<T = unknown>(expression: string): CelExpression<T> {
  return {
    [CEL_EXPRESSION_BRAND]: true,
    expression,
    _type: undefined,
  } as CelExpression<T>;
}

/**
 * Create a minimal Enhanced resource stub for testing contexts that only
 * inspect `constructor.name` (e.g., resource validators, type inference).
 *
 * Eliminates the pattern:
 * ```ts
 * { constructor: { name: 'Deployment' } } as Enhanced<any, any>
 * ```
 *
 * @example
 * ```ts
 * const mockResource = createMockEnhancedStub('Deployment');
 * const context = { availableResources: { webapp: mockResource } };
 * ```
 */
export function createMockEnhancedStub(
  constructorName: string
): Enhanced<Record<string, unknown>, Record<string, unknown>> {
  return {
    constructor: { name: constructorName },
  } as Enhanced<Record<string, unknown>, Record<string, unknown>>;
}

// =============================================================================
// PRIVATE MEMBER ACCESS HELPERS
// =============================================================================

/**
 * Type-safe interface for accessing AlchemyDeploymentStrategy internals in tests.
 *
 * The AlchemyDeploymentStrategy has private/protected members that tests need to inspect.
 * This interface exposes them without `as any` casts.
 *
 * Usage:
 * ```ts
 * const internals = strategyInternals(strategy);
 * expect(internals.factoryName).toBe('test-factory');
 * await internals.executeDeployment(spec, 'instance');
 * ```
 */
export interface AlchemyStrategyInternals {
  readonly factoryName: string;
  readonly namespace: string;
  readonly alchemyScope: unknown;
  readonly baseStrategy: unknown;
  readonly factoryOptions: unknown;
  readonly schemaDefinition: unknown;
  readonly statusBuilder: unknown;
  readonly resourceKeys: unknown;
  executeDeployment(spec: unknown, instanceName: string, opts?: unknown): Promise<unknown>;
  getStrategyMode(): 'direct' | 'kro';
  createResourceGraphForInstance(spec: unknown, instanceName?: string): unknown;
  extractKubeConfigOptions(): Record<string, unknown>;
}

/**
 * Casts a strategy instance to its internal interface for white-box testing.
 * NOTE: This is a documentation cast, not a type-safe accessor. If private methods
 * on AlchemyDeploymentStrategy are renamed, TypeScript will NOT catch the mismatch here.
 * When refactoring AlchemyDeploymentStrategy, also update AlchemyStrategyInternals.
 *
 * Eliminates patterns like:
 * ```ts
 * (strategy as any).factoryName
 * (strategy as any).executeDeployment(spec, name)
 * ```
 */
export function strategyInternals(strategy: unknown): AlchemyStrategyInternals {
  return strategy as AlchemyStrategyInternals;
}

// =============================================================================
// KUBERNETES ERROR HELPERS
// =============================================================================

/**
 * Create a Kubernetes API error with a statusCode property.
 *
 * Eliminates the pattern:
 * ```ts
 * Object.assign(new Error('Not Found'), { statusCode: 404 }) as any
 * ```
 */
export function createK8sError(
  message: string,
  statusCode: number
): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

// =============================================================================
// GLOBALTHIS HELPERS
// =============================================================================

/**
 * Type-safe access to globalThis with TypeKro internal properties.
 *
 * Eliminates the pattern:
 * ```ts
 * (globalThis as any).__TYPEKRO_STATUS_BUILDER_CONTEXT__ = true;
 * delete (globalThis as any).__TYPEKRO_STATUS_BUILDER_CONTEXT__;
 * ```
 */
export function setStatusBuilderContext(value: boolean): void {
  (globalThis as Record<string, unknown>).__TYPEKRO_STATUS_BUILDER_CONTEXT__ = value;
}

export function clearStatusBuilderContext(): void {
  delete (globalThis as Record<string, unknown>).__TYPEKRO_STATUS_BUILDER_CONTEXT__;
}
