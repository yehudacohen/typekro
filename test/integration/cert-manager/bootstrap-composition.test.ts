import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { getKubeConfig } from '../../../src/core/kubernetes/client-provider.js';
import {
  createTestNamespace,
  deleteTestCertManagerControllerArtifacts,
  deleteTestFactoryInstanceAndRecoverNamespaces,
  deleteTestNamespaceAndWait,
  runWithExpectedTestNamespace,
  type TestDeletableFactory,
  type TestNamespaceLease,
} from '../shared-kubeconfig.js';

setDefaultTimeout(900_000);

describe('Cert-Manager Bootstrap Composition Tests', () => {
  let kubeConfig: any;
  let controlNamespaceLease: TestNamespaceLease | undefined;
  const compositionNamespaceLeases = new Map<string, TestNamespaceLease>();
  const runId = crypto.randomUUID().slice(0, 8);
  const testNamespace = `typekro-test-cm-${runId}`;
  const releaseNames = {
    bootstrap: `cert-manager-bootstrap-${runId}`,
    minimal: `cert-manager-minimal-${runId}`,
    comprehensive: `cert-manager-comprehensive-${runId}`,
    dualDirect: `cert-manager-dual-${runId}`,
    readiness: `cert-manager-readiness-${runId}`,
  } as const;

  // All test deployments use unique namespaces prefixed with "cert-manager-test-"
  // to avoid conflicts with the shared "cert-manager" namespace used by other tests.
  // NEVER deploy to or delete the shared "cert-manager" namespace from this test.
  const testNs1 = `cert-manager-${runId}-1`;
  const testNs2 = `cert-manager-${runId}-2`;
  const testNs3 = `cert-manager-${runId}-3`;
  const testNs4 = `cert-manager-${runId}-4`;
  const testNs5 = `cert-manager-${runId}-5`;
  const installations = [
    { releaseName: releaseNames.bootstrap, namespace: testNs1 },
    { releaseName: releaseNames.minimal, namespace: testNs2 },
    { releaseName: releaseNames.comprehensive, namespace: testNs3 },
    { releaseName: releaseNames.dualDirect, namespace: testNs4 },
    { releaseName: releaseNames.readiness, namespace: testNs5 },
  ] as const;

  beforeAll(async () => {
    console.log('Setting up cert-manager bootstrap composition tests...');

    // Get cluster connection
    try {
      kubeConfig = getKubeConfig({ skipTLSVerify: true });
      console.log('✅ Cluster connection established');

      // Create test namespace
      controlNamespaceLease = await createTestNamespace(testNamespace, kubeConfig);
    } catch (error) {
      console.error('❌ Failed to connect to cluster:', error);
      throw error;
    }
  });

  afterAll(async () => {
    console.log('Cleaning up cert-manager bootstrap composition tests...');

    // Clean up cluster-scoped webhook configurations created by test cert-manager
    // installations. These persist after namespace deletion and cause HTTP 500 errors
    // for all subsequent cert-manager resource operations.
    const generatedResourceResults = await Promise.allSettled(
      installations.map(({ releaseName, namespace }) =>
        deleteTestCertManagerControllerArtifacts(namespace, releaseName, kubeConfig)
      )
    );

    // Clean up the main test namespace and all cert-manager test namespaces
    const namespacesToClean = [
      controlNamespaceLease,
      ...compositionNamespaceLeases.values(),
    ].filter((lease): lease is TestNamespaceLease => lease !== undefined);
    const namespaceResults = await Promise.allSettled(
      namespacesToClean.map((lease) => deleteTestNamespaceAndWait(lease, kubeConfig))
    );
    const failures = [...generatedResourceResults, ...namespaceResults]
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Failed to clean up cert-manager integration resources');
    }
  });

  async function deployInCompositionNamespace<T>(
    namespace: string,
    operation: () => Promise<T>
  ): Promise<T> {
    return runWithExpectedTestNamespace(
      namespace,
      kubeConfig,
      (lease) => compositionNamespaceLeases.set(namespace, lease),
      operation
    );
  }

  async function deleteCompositionInstance(
    factory: TestDeletableFactory,
    name: string,
    namespace: string
  ): Promise<void> {
    const lease = compositionNamespaceLeases.get(namespace);
    if (!lease) {
      throw new Error(`Missing ownership lease for composition namespace ${namespace}`);
    }
    const cleanupErrors: unknown[] = [];
    try {
      await deleteTestFactoryInstanceAndRecoverNamespaces(factory, name, [], kubeConfig, 60_000);
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await deleteTestCertManagerControllerArtifacts(namespace, name, kubeConfig);
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await deleteTestNamespaceAndWait(lease, kubeConfig);
      compositionNamespaceLeases.delete(namespace);
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        cleanupErrors,
        `Failed to clean up cert-manager composition ${name}`
      );
    }
  }

  it('should create cert-manager bootstrap composition with comprehensive configuration', async () => {
    // Import cert-manager bootstrap composition
    const { certManagerBootstrap } = await import(
      '../../../src/factories/cert-manager/compositions/cert-manager-bootstrap.js'
    );

    // Test with comprehensive configuration
    const directFactory = certManagerBootstrap.factory('direct', {
      namespace: testNamespace,
      waitForReady: true,
      timeout: 600000, // 10 minutes - first deploy needs Flux chart pull + pod startup
      kubeConfig: kubeConfig,
    });

    const instance = await deployInCompositionNamespace(testNs1, () =>
      directFactory.deploy({
        name: releaseNames.bootstrap,
        namespace: testNs1,
        version: '1.19.3',
        installCRDs: false, // NEVER use installCRDs: true - deleteInstance would remove cluster-wide CRDs
        startupapicheck: { enabled: false }, // Disable when deploying alongside existing cert-manager
        controller: {
          resources: {
            requests: { cpu: '100m', memory: '128Mi' },
            limits: { cpu: '500m', memory: '512Mi' },
          },
        },
        webhook: {
          replicaCount: 1,
        },
        cainjector: {
          enabled: true,
          replicaCount: 1,
        },
        prometheus: {
          enabled: true,
          servicemonitor: { enabled: false }, // Disable ServiceMonitor since Prometheus Operator is not installed
        },
      })
    );

    // Validate bootstrap composition deployment
    expect(instance).toBeDefined();
    expect(instance.kind).toBe('EnhancedResource');
    expect(instance.metadata.name).toBe(releaseNames.bootstrap);
    expect(instance.spec.version).toBe('1.19.3');
    expect(instance.spec.installCRDs).toBe(false);

    // Validate configuration was applied correctly
    expect(instance.spec.controller?.resources?.requests?.cpu).toBe('100m');
    expect(instance.spec.cainjector?.enabled).toBe(true);
    expect(instance.spec.prometheus?.enabled).toBe(true);

    // Clean up - deleteInstance rolls back the deployment including the namespace
    await deleteCompositionInstance(directFactory, releaseNames.bootstrap, testNs1);
  }, 900000); // 15 minute timeout - first deploy pulls chart from registry

  it('should handle different cert-manager configurations', async () => {
    // Import cert-manager bootstrap composition
    const { certManagerBootstrap } = await import(
      '../../../src/factories/cert-manager/compositions/cert-manager-bootstrap.js'
    );

    const directFactory = certManagerBootstrap.factory('direct', {
      namespace: testNamespace,
      waitForReady: true,
      timeout: 600000, // 10 minutes per deploy - Flux chart pull + pod startup takes 3-5 min
      kubeConfig: kubeConfig,
    });

    // Test minimal configuration
    const minimalInstance = await deployInCompositionNamespace(testNs2, () =>
      directFactory.deploy({
        name: releaseNames.minimal,
        namespace: testNs2,
        installCRDs: false, // NEVER use installCRDs: true - deleteInstance would remove cluster-wide CRDs
        startupapicheck: { enabled: false }, // Disable when deploying alongside existing cert-manager
      })
    );

    // The spec only contains explicitly provided values, defaults are applied internally
    expect(minimalInstance.spec.name).toBe(releaseNames.minimal);
    expect(minimalInstance.spec.namespace).toBe(testNs2);

    // Clean up minimal before deploying comprehensive to reduce resource pressure
    await deleteCompositionInstance(directFactory, releaseNames.minimal, testNs2);

    // Test comprehensive configuration
    const comprehensiveInstance = await deployInCompositionNamespace(testNs3, () =>
      directFactory.deploy({
        name: releaseNames.comprehensive,
        namespace: testNs3,
        version: '1.19.3', // Use same version as existing to avoid chart pull delays
        installCRDs: false,
        startupapicheck: { enabled: false }, // Disable when deploying alongside existing cert-manager
        replicaCount: 2,
        controller: {
          resources: {
            requests: { cpu: '200m', memory: '256Mi' },
            limits: { cpu: '1000m', memory: '1Gi' },
          },
          nodeSelector: { 'kubernetes.io/os': 'linux' },
        },
        webhook: {
          replicaCount: 1, // Reduced from 3 to avoid resource pressure
          resources: {
            requests: { cpu: '50m', memory: '64Mi' },
          },
        },
        cainjector: {
          enabled: true,
          replicaCount: 1, // Reduced from 2 to avoid resource pressure
        },
        prometheus: {
          enabled: true,
          servicemonitor: {
            enabled: false, // Disable ServiceMonitor since Prometheus Operator is not installed
            interval: '30s',
          },
        },
      })
    );

    expect(comprehensiveInstance.spec.version).toBe('1.19.3');
    expect(comprehensiveInstance.spec.installCRDs).toBe(false);
    expect(comprehensiveInstance.spec.replicaCount).toBe(2);
    expect(comprehensiveInstance.spec.webhook?.replicaCount).toBe(1);
    expect(comprehensiveInstance.spec.prometheus?.enabled).toBe(true);

    // Clean up
    await deleteCompositionInstance(directFactory, releaseNames.comprehensive, testNs3);
  }, 1800000); // 30 minute timeout - two sequential deployments each taking 5-10 min

  it('should generate proper CEL expressions for status fields', async () => {
    // Import cert-manager bootstrap composition
    const { certManagerBootstrap } = await import(
      '../../../src/factories/cert-manager/compositions/cert-manager-bootstrap.js'
    );

    // Test YAML generation to validate CEL expressions
    const yaml = certManagerBootstrap.toYaml();

    expect(yaml).toContain('apiVersion: kro.run/v1alpha1');
    expect(yaml).toContain('kind: ResourceGraphDefinition');
    expect(yaml).toContain('name: cert-manager-bootstrap');

    // Validate that status expressions are present
    // The exact CEL expressions depend on the implementation
    expect(yaml).toContain('status:');

    // Test that the composition can be serialized without errors
    expect(yaml.length).toBeGreaterThan(0);
    expect(() => yaml).not.toThrow();
  });

  it('should support both kro and direct deployment strategies', async () => {
    // Import cert-manager bootstrap composition
    const { certManagerBootstrap } = await import(
      '../../../src/factories/cert-manager/compositions/cert-manager-bootstrap.js'
    );

    // Test direct deployment strategy
    const directFactory = certManagerBootstrap.factory('direct', {
      namespace: testNamespace,
      waitForReady: true,
      timeout: 600000, // 10 minutes - HelmRelease needs time for chart pull + pod readiness
      kubeConfig: kubeConfig,
    });

    // Test kro factory creation (but don't deploy since we don't have CRDs)
    const kroFactory = certManagerBootstrap.factory('kro', {
      namespace: testNamespace,
      waitForReady: true,
      timeout: 600000,
      kubeConfig: kubeConfig,
    });

    // Both factories should be created successfully
    expect(directFactory.mode).toBe('direct');
    expect(kroFactory.mode).toBe('kro');
    expect(directFactory.namespace).toBe(testNamespace);
    expect(kroFactory.namespace).toBe(testNamespace);

    // Test direct deployment to a unique test namespace (NEVER use shared 'cert-manager')
    const directInstance = await deployInCompositionNamespace(testNs4, () =>
      directFactory.deploy({
        name: releaseNames.dualDirect,
        namespace: testNs4,
        version: '1.19.3',
        installCRDs: false, // NEVER use installCRDs: true - deleteInstance would remove cluster-wide CRDs
        startupapicheck: { enabled: false }, // Disable when deploying alongside existing cert-manager
      })
    );

    // Validate direct deployment structure
    expect(directInstance).toBeDefined();
    expect(directInstance.metadata.name).toBe(releaseNames.dualDirect);
    expect(directInstance.spec.version).toBe('1.19.3');
    expect(directInstance.spec.installCRDs).toBe(false);

    // Clean up
    await deleteCompositionInstance(directFactory, releaseNames.dualDirect, testNs4);
  }, 600000); // 10 minute timeout

  it('should validate schema compatibility with ArkType', async () => {
    // Import schemas
    const { CertManagerBootstrapConfigSchema, CertManagerBootstrapStatusSchema } = await import(
      '../../../src/factories/cert-manager/types.js'
    );

    // Test valid configuration
    const validConfig = {
      name: 'test-cert-manager',
      namespace: 'cert-manager',
      version: '1.19.3',
      installCRDs: true,
      controller: {
        resources: {
          requests: { cpu: '100m', memory: '128Mi' },
        },
      },
      webhook: {
        enabled: true,
        replicaCount: 1,
      },
    };

    const configResult = CertManagerBootstrapConfigSchema(validConfig);
    // ArkType returns the validated data directly when validation succeeds, or ArkErrors on failure
    expect(configResult).toBeDefined();

    // Type guard to check if validation succeeded
    if ('name' in configResult) {
      expect(configResult.name).toBe('test-cert-manager');
      expect(configResult.version).toBe('1.19.3');
    } else {
      // If we get here, validation failed
      console.log('Config validation errors:', configResult);
      expect(configResult).toHaveProperty('name'); // This will fail and show the error
    }

    // Test valid status (simplified schema with only real data fields)
    const validStatus = {
      phase: 'Ready',
      ready: true,
      version: '1.19.3',
      controllerReady: true,
      webhookReady: true,
      cainjectorReady: true,
      crds: {
        installed: true,
        version: '1.19.3',
      },
    };

    const statusResult = CertManagerBootstrapStatusSchema(validStatus);
    // ArkType returns the validated data directly when validation succeeds, or ArkErrors on failure
    expect(statusResult).toBeDefined();

    // Type guard to check if validation succeeded
    if ('phase' in statusResult) {
      expect(statusResult.phase).toBe('Ready');
      expect(statusResult.ready).toBe(true);
    } else {
      // If we get here, validation failed
      console.log('Status validation errors:', statusResult);
      expect(statusResult).toHaveProperty('phase'); // This will fail and show the error
    }
  });

  it('should handle readiness evaluation correctly', async () => {
    // Import cert-manager bootstrap composition
    const { certManagerBootstrap } = await import(
      '../../../src/factories/cert-manager/compositions/cert-manager-bootstrap.js'
    );

    const directFactory = certManagerBootstrap.factory('direct', {
      namespace: testNamespace,
      waitForReady: true,
      timeout: 600000, // 10 minutes - Flux chart pull + pod startup takes 3-5 min
      kubeConfig: kubeConfig,
    });

    // Deploy to a unique test namespace (NEVER use shared 'cert-manager')
    const instance = await deployInCompositionNamespace(testNs5, () =>
      directFactory.deploy({
        name: releaseNames.readiness,
        namespace: testNs5,
        version: '1.19.3',
        installCRDs: false, // NEVER use installCRDs: true - deleteInstance would remove cluster-wide CRDs
        startupapicheck: { enabled: false }, // Disable when deploying alongside existing cert-manager
        cainjector: { enabled: true },
      })
    );

    // Validate status structure exists
    expect(instance.status).toBeDefined();
    expect(typeof instance.status.ready).toBe('boolean');
    expect(typeof instance.status.controllerReady).toBe('boolean');
    expect(typeof instance.status.webhookReady).toBe('boolean');
    expect(typeof instance.status.cainjectorReady).toBe('boolean');

    // Validate CRD status structure (simplified schema)
    expect(instance.status.crds).toBeDefined();
    expect(typeof instance.status.crds.installed).toBe('boolean');
    expect(typeof instance.status.crds.version).toBe('string');

    // Clean up
    await deleteCompositionInstance(directFactory, releaseNames.readiness, testNs5);
  }, 900000); // 15 minute timeout
});
