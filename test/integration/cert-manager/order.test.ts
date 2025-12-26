import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import type * as k8s from '@kubernetes/client-node';
import { getKubeConfig } from '../../../src/core/kubernetes/client-provider.js';
import { createBunCompatibleCustomObjectsApi } from '../../../src/core/kubernetes/bun-api-client.js';
import { toResourceGraph, kubernetesComposition } from '../../../src/index.js';
import { type } from 'arktype';
import { ensureNamespaceExists, deleteNamespaceIfExists } from '../shared-kubeconfig.js';

describe('Cert-Manager Order Real Integration Tests', () => {
  let kubeConfig: k8s.KubeConfig;
  let customObjectsApi: k8s.CustomObjectsApi;
  const testNamespace = 'typekro-test-order';

  beforeAll(async () => {
    console.log('Setting up cert-manager Order real integration tests...');

    // Get cluster connection
    try {
      kubeConfig = getKubeConfig({ skipTLSVerify: true });
      customObjectsApi = createBunCompatibleCustomObjectsApi(kubeConfig);
      console.log('✅ Cluster connection established');
      
      // Create test namespace
      await ensureNamespaceExists(testNamespace, kubeConfig);
    } catch (error) {
      console.error('❌ Failed to connect to cluster:', error);
      throw error;
    }
  });

  afterEach(async () => {
    // Clean up test resources to prevent conflicts between tests
    try {
      console.log('🧹 Cleaning up Order test resources...');
      
      // Delete all Orders in test namespace that start with 'test-'
      await customObjectsApi.listNamespacedCustomObject({
        group: 'acme.cert-manager.io',
        version: 'v1',
        namespace: testNamespace,
        plural: 'orders'
      }).then(async (response: any) => {
        const items = response.items || [];
        for (const item of items) {
          if (item.metadata.name.startsWith('test-')) {
            try {
              await customObjectsApi.deleteNamespacedCustomObject({
                group: 'acme.cert-manager.io',
                version: 'v1',
                namespace: testNamespace,
                plural: 'orders',
                name: item.metadata.name
              });
              console.log(`🗑️ Deleted Order: ${item.metadata.name}`);
            } catch (deleteError) {
              console.warn(`⚠️ Failed to delete Order ${item.metadata.name}:`, deleteError);
            }
          }
        }
      }).catch((error) => {
        console.warn('⚠️ Failed to list Orders for cleanup:', error);
      });

      // Wait a moment for cleanup to complete
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      console.log('✅ Order test resource cleanup completed');
    } catch (error) {
      console.warn('⚠️ Order test cleanup failed (non-critical):', error);
    }
  });

  afterAll(async () => {
    console.log('Cleaning up cert-manager Order real integration tests...');
    await deleteNamespaceIfExists(testNamespace, kubeConfig);
  });

  it('should deploy Order resource to Kubernetes using direct factory', async () => {
    console.log('🚀 Testing Order deployment with direct factory...');
    
    const { order } = await import('../../../src/factories/cert-manager/resources/challenges.js');
    
    // Create a sample CSR (Certificate Signing Request) in base64 format
    // This is a minimal CSR for testing purposes
    const sampleCSR = Buffer.from(`-----BEGIN CERTIFICATE REQUEST-----
MIICWjCCAUICAQAwFTETMBEGA1UEAwwKdGVzdC5sb2NhbDCCASIwDQYJKoZIhvcN
AQEBBQADggEPADCCAQoCggEBAL2Z8Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z
9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z
9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z
9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z
9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z
9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z
wIDAQABoAAwDQYJKoZIhvcNAQELBQADggEBAK2Z8Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z
9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z
-----END CERTIFICATE REQUEST-----`).toString('base64');
    
    // Create an Order composition
    const OrderSpec = type({
      name: 'string',
      commonName: 'string',
      dnsNames: 'string[]',
      issuerName: 'string'
    });

    const OrderStatus = type({
      state: 'string',
      certificateReady: 'boolean',
      authorizationCount: 'number'
    });

    const orderComposition = kubernetesComposition(
      {
        name: 'order-test',
        apiVersion: 'test.typekro.dev/v1alpha1',
        kind: 'OrderTest',
        spec: OrderSpec,
        status: OrderStatus,
      },
      (spec) => {
        const orderResource = order({
          name: spec.name,
          namespace: testNamespace,
          spec: {
            request: sampleCSR,
            issuerRef: {
              name: spec.issuerName,
              kind: 'ClusterIssuer'
            },
            commonName: spec.commonName,
            dnsNames: spec.dnsNames,
            duration: '2160h' // 90 days
          },
          id: 'testOrder'
        });

        return {
          state: orderResource.status.state || 'pending',
          certificateReady: !!orderResource.status.certificate,
          authorizationCount: orderResource.status.authorizations?.length || 0
        };
      }
    );

    // Test with direct factory - this will actually deploy to Kubernetes
    // Note: Don't wait for readiness as Order resources won't complete in test environment
    const directFactory = orderComposition.factory('direct', {
      namespace: testNamespace,
      waitForReady: false,
      kubeConfig: kubeConfig,
    });

    const orderName = `test-order-${Date.now()}`;
    console.log(`📦 Deploying Order: ${orderName}`);
    
    const deploymentResult = await directFactory.deploy({
      name: orderName,
      commonName: 'test.example.com',
      dnsNames: ['test.example.com', 'www.test.example.com'],
      issuerName: 'test-issuer'
    });

    // Validate deployment result
    expect(deploymentResult).toBeDefined();
    expect(deploymentResult.metadata.name).toBe(orderName);
    expect(deploymentResult.spec.name).toBe(orderName);

    // Verify the Order was actually created in Kubernetes
    const orderResource = await customObjectsApi.getNamespacedCustomObject({
      group: 'acme.cert-manager.io',
      version: 'v1',
      namespace: testNamespace,
      plural: 'orders',
      name: orderName
    });

    expect(orderResource).toBeDefined();
    const orderBody = orderResource as any;
    expect(orderBody.kind).toBe('Order');
    expect(orderBody.metadata.name).toBe(orderName);
    expect(orderBody.spec.request).toBe(sampleCSR);
    expect(orderBody.spec.commonName).toBe('test.example.com');
    expect(orderBody.spec.dnsNames).toEqual(['test.example.com', 'www.test.example.com']);
    expect(orderBody.spec.issuerRef.name).toBe('test-issuer');
    expect(orderBody.spec.issuerRef.kind).toBe('ClusterIssuer');
    expect(orderBody.spec.duration).toBe('2160h0m0s'); // cert-manager normalizes duration format

    console.log('✅ Order successfully deployed to Kubernetes');
    console.log('📋 Order resource verified in cluster');
    console.log(`🔐 Order configured for domains: test.example.com, www.test.example.com`);
    
  }, 120000); // 120 second timeout for real deployment

  it('should deploy comprehensive ACME order with multiple domains', async () => {
    console.log('🚀 Testing comprehensive ACME order deployment...');
    
    const { order } = await import('../../../src/factories/cert-manager/resources/challenges.js');
    
    // Create a more comprehensive CSR for multiple domains
    const multiDomainCSR = Buffer.from(`-----BEGIN CERTIFICATE REQUEST-----
MIICZjCCAU4CAQAwGjEYMBYGA1UEAwwPbXVsdGkuZXhhbXBsZS5jb20wggEiMA0G
CSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQC9mfGfWfWfWfWfWfWfWfWfWfWfWfWf
WfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWf
WfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWf
WfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWf
WfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWf
WfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWf
WfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWfWf
wIDAQABoAAwDQYJKoZIhvcNAQELBQADggEBAK2Z8Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z
9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z
-----END CERTIFICATE REQUEST-----`).toString('base64');
    
    // Create a comprehensive Order composition
    const ComprehensiveOrderSpecSchema = type({
      name: 'string',
      commonName: 'string',
      dnsNames: 'string[]',
      ipAddresses: 'string[]',
      issuerName: 'string',
      duration: 'string'
    });

    const ComprehensiveOrderStatusSchema = type({
      state: 'string',
      certificateReady: 'boolean',
      authorizationCount: 'number',
      finalizeURL: 'string',
      orderURL: 'string'
    });

    const comprehensiveOrderGraph = toResourceGraph(
      {
        name: 'comprehensive-order-test',
        apiVersion: 'test.typekro.dev/v1alpha1',
        kind: 'ComprehensiveOrderTest',
        spec: ComprehensiveOrderSpecSchema,
        status: ComprehensiveOrderStatusSchema,
      },
      (schema) => ({
        comprehensiveOrder: order({
          name: schema.spec.name,
          namespace: testNamespace,
          spec: {
            request: multiDomainCSR,
            issuerRef: {
              name: schema.spec.issuerName,
              kind: 'ClusterIssuer'
            },
            commonName: schema.spec.commonName,
            dnsNames: schema.spec.dnsNames,
            ipAddresses: schema.spec.ipAddresses,
            duration: schema.spec.duration
          },
          id: 'comprehensiveOrder'
        })
      }),
      (_schema, resources) => ({
        state: resources.comprehensiveOrder.status.state || 'pending',
        certificateReady: !!resources.comprehensiveOrder.status.certificate,
        authorizationCount: resources.comprehensiveOrder.status.authorizations?.length || 0,
        finalizeURL: resources.comprehensiveOrder.status.finalizeURL || '',
        orderURL: resources.comprehensiveOrder.status.url || ''
      })
    );

    // Deploy using direct factory
    const directFactory = comprehensiveOrderGraph.factory('direct', {
      namespace: testNamespace,
      waitForReady: false,
      kubeConfig: kubeConfig,
    });

    const orderName = `test-comprehensive-order-${Date.now()}`;
    console.log(`📦 Deploying comprehensive Order: ${orderName}`);
    
    const deploymentResult = await directFactory.deploy({
      name: orderName,
      commonName: 'multi.example.com',
      dnsNames: ['multi.example.com', 'api.multi.example.com', 'www.multi.example.com'],
      ipAddresses: ['192.168.1.100', '10.0.0.100'],
      issuerName: 'test-comprehensive-issuer',
      duration: '8760h' // 1 year
    });

    // Validate deployment result
    expect(deploymentResult).toBeDefined();
    expect(deploymentResult.metadata.name).toBe(orderName);

    // Find the Order that was actually created
    const allOrders = await customObjectsApi.listNamespacedCustomObject({
      group: 'acme.cert-manager.io',
      version: 'v1',
      namespace: testNamespace,
      plural: 'orders'
    });
    const createdOrder = (allOrders as any).items.find((order: any) => 
      order.metadata.name.includes('comprehensive-order')
    );
    expect(createdOrder).toBeDefined();

    const orderBody = createdOrder as any;
    expect(orderBody.kind).toBe('Order');
    expect(orderBody.spec.request).toBe(multiDomainCSR);
    expect(orderBody.spec.commonName).toBe('multi.example.com');
    expect(orderBody.spec.dnsNames).toEqual(['multi.example.com', 'api.multi.example.com', 'www.multi.example.com']);
    expect(orderBody.spec.ipAddresses).toEqual(['192.168.1.100', '10.0.0.100']);
    expect(orderBody.spec.issuerRef.name).toBe('test-comprehensive-issuer');
    expect(orderBody.spec.issuerRef.kind).toBe('ClusterIssuer');
    expect(orderBody.spec.duration).toBe('8760h0m0s'); // cert-manager normalizes duration format

    console.log('✅ Comprehensive Order successfully deployed to Kubernetes');
    console.log('📋 Order resource verified with multiple domains and IP addresses');
    console.log(`🔐 Order configured for: multi.example.com, api.multi.example.com, www.multi.example.com`);
    console.log(`🌐 Order includes IP addresses: 192.168.1.100, 10.0.0.100`);
    
  }, 120000); // 120 second timeout for comprehensive deployment

  it('should validate Order readiness evaluation with actual order completion status', async () => {
    // Test readiness evaluation with realistic ACME order completion scenarios
    const { order } = await import('../../../src/factories/cert-manager/resources/challenges.js');

    const testOrder = order({
      name: 'readiness-test-order',
      namespace: testNamespace,
      spec: {
        request: 'LS0tLS1CRUdJTi...',
        issuerRef: {
          name: 'test-issuer',
          kind: 'ClusterIssuer'
        },
        commonName: 'readiness.example.com',
        dnsNames: ['readiness.example.com']
      },
      id: 'readinessTestOrder'
    });

    expect(testOrder.readinessEvaluator).toBeDefined();

    // Test order completion success scenario
    const mockCompletedOrder = {
      apiVersion: 'acme.cert-manager.io/v1',
      kind: 'Order',
      metadata: { name: 'test-order', namespace: testNamespace },
      spec: { commonName: 'readiness.example.com' },
      status: {
        state: 'valid',
        certificate: 'LS0tLS1CRUdJTi...', // Base64 encoded certificate
        url: 'https://acme-v02.api.letsencrypt.org/acme/order/12345',
        finalizeURL: 'https://acme-v02.api.letsencrypt.org/acme/finalize/12345'
      }
    };

    if (testOrder.readinessEvaluator) {
      const completedResult = testOrder.readinessEvaluator(mockCompletedOrder);
      expect(completedResult.ready).toBe(true);
      expect(completedResult.message).toContain('Order completed successfully');
    }

    // Test order processing scenario
    const mockProcessingOrder = {
      apiVersion: 'acme.cert-manager.io/v1',
      kind: 'Order',
      metadata: { name: 'test-order', namespace: testNamespace },
      spec: { commonName: 'readiness.example.com' },
      status: {
        state: 'processing',
        url: 'https://acme-v02.api.letsencrypt.org/acme/order/12345',
        authorizations: [
          {
            url: 'https://acme-v02.api.letsencrypt.org/acme/authz-v3/12345',
            identifier: { type: 'dns', value: 'readiness.example.com' }
          }
        ]
      }
    };

    if (testOrder.readinessEvaluator) {
      const processingResult = testOrder.readinessEvaluator(mockProcessingOrder);
      expect(processingResult.ready).toBe(false);
      expect(processingResult.message).toContain('Order is being processed');
      expect(processingResult.message).toContain('1 authorizations');
      expect(processingResult.reason).toBe('Processing');
    }

    // Test order failure scenario
    const mockFailedOrder = {
      apiVersion: 'acme.cert-manager.io/v1',
      kind: 'Order',
      metadata: { name: 'test-order', namespace: testNamespace },
      spec: { commonName: 'readiness.example.com' },
      status: {
        state: 'invalid',
        reason: 'Authorization failed for domain readiness.example.com'
      }
    };

    if (testOrder.readinessEvaluator) {
      const failedResult = testOrder.readinessEvaluator(mockFailedOrder);
      expect(failedResult.ready).toBe(false);
      expect(failedResult.message).toContain('Authorization failed for domain readiness.example.com');
      expect(failedResult.reason).toBe('OrderFailed');
    }

    // Test order valid but certificate pending scenario
    const mockValidNoCertOrder = {
      apiVersion: 'acme.cert-manager.io/v1',
      kind: 'Order',
      metadata: { name: 'test-order', namespace: testNamespace },
      spec: { commonName: 'readiness.example.com' },
      status: {
        state: 'valid',
        url: 'https://acme-v02.api.letsencrypt.org/acme/order/12345',
        finalizeURL: 'https://acme-v02.api.letsencrypt.org/acme/finalize/12345'
        // No certificate field - still pending
      }
    };

    if (testOrder.readinessEvaluator) {
      const validNoCertResult = testOrder.readinessEvaluator(mockValidNoCertOrder);
      expect(validNoCertResult.ready).toBe(false);
      expect(validNoCertResult.message).toContain('Order is valid but certificate not yet available');
      expect(validNoCertResult.reason).toBe('CertificatePending');
    }

    // Test order without status (initial state)
    const mockInitialOrder = {
      apiVersion: 'acme.cert-manager.io/v1',
      kind: 'Order',
      metadata: { name: 'test-order', namespace: testNamespace },
      spec: { commonName: 'readiness.example.com' }
      // No status field - initial state
    };

    if (testOrder.readinessEvaluator) {
      const initialResult = testOrder.readinessEvaluator(mockInitialOrder);
      expect(initialResult.ready).toBe(false);
      expect(initialResult.message).toContain('status not available');
      expect(initialResult.reason).toBe('StatusMissing');
    }

    console.log('✅ Order readiness evaluation with ACME order completion scenarios validated');
    console.log('📋 Handles success, processing, failure, valid-no-cert, and initial states correctly');
  });
});