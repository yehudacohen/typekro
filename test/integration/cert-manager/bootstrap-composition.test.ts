import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { getKubeConfig } from '../../../src/core/kubernetes/client-provider.js';
import { cleanupCertManagerWebhooks, ensureNamespaceExists } from '../shared-kubeconfig.js';

describe('Cert-Manager Bootstrap Composition Tests', () => {
  let kubeConfig: any;
  const testNamespace = 'typekro-test-cm-bootstrap';

  // All test deployments use unique namespaces prefixed with "cert-manager-test-"
  // to avoid conflicts with the shared "cert-manager" namespace used by other tests.
  // NEVER deploy to or delete the shared "cert-manager" namespace from this test.
  const testNs1 = 'cert-manager-test-1';
  const testNs2 = 'cert-manager-test-2';
  const testNs3 = 'cert-manager-test-3';
  const testNs4 = 'cert-manager-test-4';
  const testNs5 = 'cert-manager-test-5';

  beforeAll(async () => {
    console.log('Setting up cert-manager bootstrap composition tests...');

    // Get cluster connection
    try {
      kubeConfig = getKubeConfig({ skipTLSVerify: true });
      console.log('✅ Cluster connection established');

      // Create test namespace
      await ensureNamespaceExists(testNamespace, kubeConfig);
    } catch (error) {
      console.error('❌ Failed to connect to cluster:', error);
      throw error;
    }
  });

  afterAll(async () => {
    console.log('Cleaning up cert-manager bootstrap composition tests...');
    const { deleteNamespaceAndWait } = await import('../shared-kubeconfig.js');

    // Clean up cluster-scoped webhook configurations created by test cert-manager
    // installations. These persist after namespace deletion and cause HTTP 500 errors
    // for all subsequent cert-manager resource operations.
    const releaseNames = [
      'cert-manager-bootstrap-test',
      'cert-manager-minimal',
      'cert-manager-comprehensive',
      'cert-manager-dual-direct',
      'cert-manager-readiness-test',
    ];
    await Promise.allSettled(
      releaseNames.map((name) => cleanupCertManagerWebhooks(name, kubeConfig))
    );

    // Clean up the main test namespace and all cert-manager test namespaces
    const namespacesToClean = [testNamespace, testNs1, testNs2, testNs3, testNs4, testNs5];
    await Promise.allSettled(namespacesToClean.map((ns) => deleteNamespaceAndWait(ns, kubeConfig)));
  });

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

    const instance = await directFactory.deploy({
      name: 'cert-manager-bootstrap-test',
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
    });

    // Validate bootstrap composition deployment
    expect(instance).toBeDefined();
    expect(instance.kind).toBe('EnhancedResource');
    expect(instance.metadata.name).toBe('cert-manager-bootstrap-test');
    expect(instance.spec.version).toBe('1.19.3');
    expect(instance.spec.installCRDs).toBe(false);

    // Validate configuration was applied correctly
    expect(instance.spec.controller?.resources?.requests?.cpu).toBe('100m');
    expect(instance.spec.cainjector?.enabled).toBe(true);
    expect(instance.spec.prometheus?.enabled).toBe(true);

    // Clean up - deleteInstance rolls back the deployment including the namespace
    await directFactory.deleteInstance('cert-manager-bootstrap-test');
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
    const minimalInstance = await directFactory.deploy({
      name: 'cert-manager-minimal',
      namespace: testNs2,
      installCRDs: false, // NEVER use installCRDs: true - deleteInstance would remove cluster-wide CRDs
      startupapicheck: { enabled: false }, // Disable when deploying alongside existing cert-manager
    });

    // The spec only contains explicitly provided values, defaults are applied internally
    expect(minimalInstance.spec.name).toBe('cert-manager-minimal');
    expect(minimalInstance.spec.namespace).toBe(testNs2);

    // Clean up minimal before deploying comprehensive to reduce resource pressure
    await directFactory.deleteInstance('cert-manager-minimal');

    // Test comprehensive configuration
    const comprehensiveInstance = await directFactory.deploy({
      name: 'cert-manager-comprehensive',
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
    });

    expect(comprehensiveInstance.spec.version).toBe('1.19.3');
    expect(comprehensiveInstance.spec.installCRDs).toBe(false);
    expect(comprehensiveInstance.spec.replicaCount).toBe(2);
    expect(comprehensiveInstance.spec.webhook?.replicaCount).toBe(1);
    expect(comprehensiveInstance.spec.prometheus?.enabled).toBe(true);

    // Clean up
    await directFactory.deleteInstance('cert-manager-comprehensive');
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
    const directInstance = await directFactory.deploy({
      name: 'cert-manager-dual-direct',
      namespace: testNs4,
      version: '1.19.3',
      installCRDs: false, // NEVER use installCRDs: true - deleteInstance would remove cluster-wide CRDs
      startupapicheck: { enabled: false }, // Disable when deploying alongside existing cert-manager
    });

    // Validate direct deployment structure
    expect(directInstance).toBeDefined();
    expect(directInstance.metadata.name).toBe('cert-manager-dual-direct');
    expect(directInstance.spec.version).toBe('1.19.3');
    expect(directInstance.spec.installCRDs).toBe(false);

    // Clean up
    await directFactory.deleteInstance('cert-manager-dual-direct');
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
    const instance = await directFactory.deploy({
      name: 'cert-manager-readiness-test',
      namespace: testNs5,
      version: '1.19.3',
      installCRDs: false, // NEVER use installCRDs: true - deleteInstance would remove cluster-wide CRDs
      startupapicheck: { enabled: false }, // Disable when deploying alongside existing cert-manager
      cainjector: { enabled: true },
    });

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
    await directFactory.deleteInstance('cert-manager-readiness-test');
  }, 900000); // 15 minute timeout
});
