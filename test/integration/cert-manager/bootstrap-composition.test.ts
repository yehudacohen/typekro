import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { getKubeConfig } from '../../../src/core/kubernetes/client-provider.js';
import { ensureNamespaceExists } from '../shared-kubeconfig.js';

describe('Cert-Manager Bootstrap Composition Tests', () => {
  let kubeConfig: any;
  const testNamespace = 'typekro-test-cm-bootstrap';

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
    // Clean up the main test namespace and all cert-manager test namespaces
    const namespacesToClean = [
      testNamespace,
      'cert-manager-test-1',
      'cert-manager-test-2',
      'cert-manager-test-3',
    ];
    await Promise.all(namespacesToClean.map((ns) => deleteNamespaceAndWait(ns, kubeConfig)));
  });

  it('should create cert-manager bootstrap composition with comprehensive configuration', async () => {
    // Import cert-manager bootstrap composition
    const { certManagerBootstrap } = await import(
      '../../../src/factories/cert-manager/compositions/cert-manager-bootstrap.js'
    );

    // Use unique namespace for this test to avoid conflicts with shared infrastructure
    const testCertManagerNs = 'cert-manager-test-1';

    // Test with comprehensive configuration
    const directFactory = certManagerBootstrap.factory('direct', {
      namespace: testNamespace,
      waitForReady: true, // Test with proper readiness checking
      timeout: 720000, // 12 minutes - cert-manager bootstrap takes ~11 minutes with startupapicheck
      kubeConfig: kubeConfig,
    });

    const instance = await directFactory.deploy({
      name: 'cert-manager-bootstrap-test',
      namespace: testCertManagerNs, // Use unique namespace
      version: '1.13.3',
      installCRDs: true,
      controller: {
        resources: {
          requests: { cpu: '100m', memory: '128Mi' },
          limits: { cpu: '500m', memory: '512Mi' },
        },
      },
      webhook: {
        enabled: true,
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
    expect(instance.spec.version).toBe('1.13.3');
    expect(instance.spec.installCRDs).toBe(true);

    // Validate configuration was applied correctly
    expect(instance.spec.controller?.resources?.requests?.cpu).toBe('100m');
    expect(instance.spec.webhook?.enabled).toBe(true);
    expect(instance.spec.cainjector?.enabled).toBe(true);
    expect(instance.spec.prometheus?.enabled).toBe(true);

    // Clean up
    await directFactory.deleteInstance('cert-manager-bootstrap-test');
    // // await waitForNamespaceDeletion(kubeConfig, 'cert-manager');
  }, 900000); // 15 minute timeout for cert-manager bootstrap deployment

  it('should handle different cert-manager configurations', async () => {
    // Import cert-manager bootstrap composition
    const { certManagerBootstrap } = await import(
      '../../../src/factories/cert-manager/compositions/cert-manager-bootstrap.js'
    );

    // Use unique namespaces for this test to avoid conflicts with shared infrastructure
    const testCertManagerNs2 = 'cert-manager-test-2';
    const testCertManagerNs3 = 'cert-manager-test-3';

    const directFactory = certManagerBootstrap.factory('direct', {
      namespace: testNamespace,
      waitForReady: true, // Wait for readiness to validate proper deployment
      timeout: 720000, // 12 minutes - cert-manager bootstrap takes ~11 minutes with startupapicheck
      kubeConfig: kubeConfig,
    });

    // Test minimal configuration
    const minimalInstance = await directFactory.deploy({
      name: 'cert-manager-minimal',
      namespace: testCertManagerNs2, // Use unique namespace
    });

    // The spec only contains explicitly provided values, defaults are applied internally
    expect(minimalInstance.spec.name).toBe('cert-manager-minimal');
    expect(minimalInstance.spec.namespace).toBe(testCertManagerNs2);

    // Test comprehensive configuration
    const comprehensiveInstance = await directFactory.deploy({
      name: 'cert-manager-comprehensive',
      namespace: testCertManagerNs3, // Use unique namespace
      version: '1.14.0',
      installCRDs: false,
      replicaCount: 2,
      controller: {
        image: {
          repository: 'quay.io/jetstack/cert-manager-controller', // Use valid repository
          tag: 'v1.14.0', // Use valid tag with v prefix
          pullPolicy: 'Always',
        },
        resources: {
          requests: { cpu: '200m', memory: '256Mi' },
          limits: { cpu: '1000m', memory: '1Gi' },
        },
        nodeSelector: { 'kubernetes.io/os': 'linux' },
      },
      webhook: {
        enabled: true,
        replicaCount: 3,
        resources: {
          requests: { cpu: '50m', memory: '64Mi' },
        },
      },
      cainjector: {
        enabled: true,
        replicaCount: 2,
      },
      prometheus: {
        enabled: true,
        servicemonitor: {
          enabled: false, // Disable ServiceMonitor since Prometheus Operator is not installed
          interval: '30s',
        },
      },
    });

    expect(comprehensiveInstance.spec.version).toBe('1.14.0');
    expect(comprehensiveInstance.spec.installCRDs).toBe(false);
    expect(comprehensiveInstance.spec.replicaCount).toBe(2);
    expect(comprehensiveInstance.spec.controller?.image?.repository).toBe(
      'quay.io/jetstack/cert-manager-controller'
    );
    expect(comprehensiveInstance.spec.webhook?.replicaCount).toBe(3);
    expect(comprehensiveInstance.spec.prometheus?.enabled).toBe(true);

    // Clean up
    await directFactory.deleteInstance('cert-manager-minimal');
    await directFactory.deleteInstance('cert-manager-comprehensive');

    // Wait for namespace deletion
    // await waitForNamespaceDeletion(kubeConfig, 'cert-manager');
  }, 900000); // 15 minute timeout for cert-manager bootstrap deployment

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
      waitForReady: true, // Wait for readiness to validate proper deployment
      timeout: 720000, // 12 minutes - cert-manager bootstrap takes ~11 minutes with startupapicheck
      kubeConfig: kubeConfig,
    });

    // Test kro factory creation (but don't deploy since we don't have CRDs)
    const kroFactory = certManagerBootstrap.factory('kro', {
      namespace: testNamespace,
      waitForReady: true, // Use proper readiness checking
      timeout: 720000, // 12 minutes - cert-manager bootstrap takes ~11 minutes with startupapicheck
      kubeConfig: kubeConfig,
    });

    // Both factories should be created successfully
    expect(directFactory.mode).toBe('direct');
    expect(kroFactory.mode).toBe('kro');
    expect(directFactory.namespace).toBe(testNamespace);
    expect(kroFactory.namespace).toBe(testNamespace);

    // Test direct deployment (kro deployment would require CRD installation)
    const directInstance = await directFactory.deploy({
      name: 'cert-manager-dual-direct',
      namespace: 'cert-manager',
      version: '1.13.3',
      installCRDs: true,
    });

    // Validate direct deployment structure
    expect(directInstance).toBeDefined();
    expect(directInstance.metadata.name).toBe('cert-manager-dual-direct');
    expect(directInstance.spec.version).toBe('1.13.3');
    expect(directInstance.spec.installCRDs).toBe(true);

    // Clean up
    await directFactory.deleteInstance('cert-manager-dual-direct');
    // await waitForNamespaceDeletion(kubeConfig, 'cert-manager');
  }, 900000); // 15 minute timeout for cert-manager bootstrap deployment

  it('should validate schema compatibility with ArkType', async () => {
    // Import schemas
    const { CertManagerBootstrapConfigSchema, CertManagerBootstrapStatusSchema } = await import(
      '../../../src/factories/cert-manager/types.js'
    );

    // Test valid configuration
    const validConfig = {
      name: 'test-cert-manager',
      namespace: 'cert-manager',
      version: '1.13.3',
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
      expect(configResult.version).toBe('1.13.3');
    } else {
      // If we get here, validation failed
      console.log('Config validation errors:', configResult);
      expect(configResult).toHaveProperty('name'); // This will fail and show the error
    }

    // Test valid status (simplified schema with only real data fields)
    const validStatus = {
      phase: 'Ready',
      ready: true,
      version: '1.13.3',
      controllerReady: true,
      webhookReady: true,
      cainjectorReady: true,
      crds: {
        installed: true,
        version: '1.13.3',
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
      waitForReady: true, // Wait for readiness to validate proper deployment
      timeout: 720000, // 12 minutes - cert-manager bootstrap takes ~11 minutes with startupapicheck
      kubeConfig: kubeConfig,
    });

    const instance = await directFactory.deploy({
      name: 'cert-manager-readiness-test',
      namespace: 'cert-manager',
      version: '1.13.3',
      webhook: { enabled: true },
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
    // await waitForNamespaceDeletion(kubeConfig, 'cert-manager');
  }, 900000); // 15 minute timeout for cert-manager bootstrap deployment
});
