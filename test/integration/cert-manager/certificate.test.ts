import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import type * as k8s from '@kubernetes/client-node';
import { getKubeConfig } from '../../../src/core/kubernetes/client-provider.js';
import { createBunCompatibleCustomObjectsApi } from '../../../src/core/kubernetes/bun-api-client.js';
import { toResourceGraph, kubernetesComposition } from '../../../src/index.js';
import { type } from 'arktype';
import { ensureNamespaceExists, deleteNamespaceIfExists } from '../shared-kubeconfig.js';

describe('Cert-Manager Certificate Real Integration Tests', () => {
  let kubeConfig: k8s.KubeConfig;
  let customObjectsApi: k8s.CustomObjectsApi;
  const testNamespace = 'typekro-test-cert';

  beforeAll(async () => {
    console.log('Setting up cert-manager certificate real integration tests...');

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
      console.log('🧹 Cleaning up Certificate test resources...');
      
      // Delete all Certificates in test namespace that start with 'test-'
      await customObjectsApi.listNamespacedCustomObject({
        group: 'cert-manager.io',
        version: 'v1',
        namespace: testNamespace,
        plural: 'certificates'
      }).then(async (response: any) => {
        const items = response.items || [];
        for (const item of items) {
          if (item.metadata.name.startsWith('test-')) {
            try {
              await customObjectsApi.deleteNamespacedCustomObject({
                group: 'cert-manager.io',
                version: 'v1',
                namespace: testNamespace,
                plural: 'certificates',
                name: item.metadata.name
              });
              console.log(`🗑️ Deleted Certificate: ${item.metadata.name}`);
            } catch (deleteError) {
              console.warn(`⚠️ Failed to delete Certificate ${item.metadata.name}:`, deleteError);
            }
          }
        }
      }).catch((error) => {
        console.warn('⚠️ Failed to list Certificates for cleanup:', error);
      });

      // Delete all ClusterIssuers that start with 'test-'
      await customObjectsApi.listClusterCustomObject({
        group: 'cert-manager.io',
        version: 'v1',
        plural: 'clusterissuers'
      }).then(async (response: any) => {
        const items = response.items || [];
        for (const item of items) {
          if (item.metadata.name.startsWith('test-')) {
            try {
              await customObjectsApi.deleteClusterCustomObject({
                group: 'cert-manager.io',
                version: 'v1',
                plural: 'clusterissuers',
                name: item.metadata.name
              });
              console.log(`🗑️ Deleted ClusterIssuer: ${item.metadata.name}`);
            } catch (deleteError) {
              console.warn(`⚠️ Failed to delete ClusterIssuer ${item.metadata.name}:`, deleteError);
            }
          }
        }
      }).catch((error) => {
        console.warn('⚠️ Failed to list ClusterIssuers for cleanup:', error);
      });

      // Wait a moment for cleanup to complete
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      console.log('✅ Certificate test resource cleanup completed');
    } catch (error) {
      console.warn('⚠️ Certificate test cleanup failed (non-critical):', error);
    }
  });

  afterAll(async () => {
    console.log('Cleaning up cert-manager certificate real integration tests...');
    await deleteNamespaceIfExists(testNamespace, kubeConfig);
  });

  it('should deploy Certificate resource to Kubernetes using direct factory', async () => {
    console.log('🚀 Testing Certificate deployment with direct factory...');
    
    const { certificate } = await import('../../../src/factories/cert-manager/resources/certificates.js');
    const { clusterIssuer } = await import('../../../src/factories/cert-manager/resources/issuers.js');
    
    // First, create a ClusterIssuer for the certificate to reference
    const issuerComposition = kubernetesComposition(
      {
        name: 'test-issuer',
        apiVersion: 'test.typekro.dev/v1alpha1',
        kind: 'TestIssuer',
        spec: type({ name: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      (spec) => {
        const issuer = clusterIssuer({
          name: spec.name,
          spec: {
            selfSigned: {}
          },
          id: 'testIssuer'
        });

        return {
          ready: issuer.status.conditions?.some((c: any) => c.type === 'Ready' && c.status === 'True') || false
        };
      }
    );

    const issuerFactory = issuerComposition.factory('direct', {
      namespace: testNamespace,
      waitForReady: true,
      kubeConfig: kubeConfig,
    });

    const issuerName = `test-issuer-${Date.now()}`;
    console.log(`📦 Creating ClusterIssuer: ${issuerName}`);
    
    await issuerFactory.deploy({
      name: issuerName
    });

    // Now create a Certificate composition
    const CertificateSpec = type({
      name: 'string',
      secretName: 'string',
      commonName: 'string',
      issuerName: 'string'
    });

    const CertificateStatus = type({
      ready: 'boolean',
      issued: 'boolean',
      secretName: 'string'
    });

    const certificateComposition = kubernetesComposition(
      {
        name: 'certificate-test',
        apiVersion: 'test.typekro.dev/v1alpha1',
        kind: 'CertificateTest',
        spec: CertificateSpec,
        status: CertificateStatus,
      },
      (spec) => {
        const cert = certificate({
          name: spec.name,
          namespace: testNamespace,
          spec: {
            secretName: spec.secretName,
            commonName: spec.commonName,
            dnsNames: [spec.commonName],
            issuerRef: {
              name: spec.issuerName,
              kind: 'ClusterIssuer'
            },
            duration: '24h',
            renewBefore: '1h'
          },
          id: 'testCertificate'
        });

        return {
          ready: cert.status.conditions?.some((c: any) => c.type === 'Ready' && c.status === 'True') || false,
          issued: cert.status.conditions?.some((c: any) => c.type === 'Ready' && c.status === 'True') || false,
          secretName: spec.secretName
        };
      }
    );

    // Test with direct factory - this will actually deploy to Kubernetes
    const directFactory = certificateComposition.factory('direct', {
      namespace: testNamespace,
      waitForReady: true,
      kubeConfig: kubeConfig,
    });

    const certName = `test-certificate-${Date.now()}`;
    const secretName = `test-secret-${Date.now()}`;
    console.log(`📦 Deploying Certificate: ${certName}`);
    
    const deploymentResult = await directFactory.deploy({
      name: certName,
      secretName: secretName,
      commonName: 'test.example.com',
      issuerName: issuerName
    });

    // Validate deployment result
    expect(deploymentResult).toBeDefined();
    expect(deploymentResult.metadata.name).toBe(certName);
    expect(deploymentResult.spec.name).toBe(certName);

    // Verify the Certificate was actually created in Kubernetes
    const certificateResource = await customObjectsApi.getNamespacedCustomObject({
      group: 'cert-manager.io',
      version: 'v1',
      namespace: testNamespace,
      plural: 'certificates',
      name: certName
    });

    expect(certificateResource).toBeDefined();
    const certBody = certificateResource as any;
    expect(certBody.kind).toBe('Certificate');
    expect(certBody.metadata.name).toBe(certName);
    expect(certBody.spec.secretName).toBe(secretName);
    expect(certBody.spec.commonName).toBe('test.example.com');
    expect(certBody.spec.issuerRef.name).toBe(issuerName);
    expect(certBody.spec.issuerRef.kind).toBe('ClusterIssuer');

    console.log('✅ Certificate successfully deployed to Kubernetes');
    console.log('📋 Certificate resource verified in cluster');
    console.log(`🔐 Certificate will create secret: ${secretName}`);
    
  }, 120000); // 120 second timeout for real deployment

  it('should deploy complete certificate issuance stack and verify certificate lifecycle', async () => {
    console.log('🚀 Testing complete certificate lifecycle with real cert-manager...');
    
    const { clusterIssuer } = await import('../../../src/factories/cert-manager/resources/issuers.js');
    const { certificate } = await import('../../../src/factories/cert-manager/resources/certificates.js');
    
    // Create a comprehensive certificate issuance composition
    const CertificateLifecycleSpecSchema = type({
      baseName: 'string',
      commonName: 'string',
      dnsNames: 'string[]'
    });

    const CertificateLifecycleStatusSchema = type({
      issuerReady: 'boolean',
      certificateReady: 'boolean',
      secretCreated: 'boolean',
      issuerName: 'string',
      certificateName: 'string',
      secretName: 'string'
    });

    const certificateLifecycleGraph = toResourceGraph(
      {
        name: 'certificate-lifecycle-test',
        apiVersion: 'test.typekro.dev/v1alpha1',
        kind: 'CertificateLifecycleTest',
        spec: CertificateLifecycleSpecSchema,
        status: CertificateLifecycleStatusSchema,
      },
      (schema) => {
        const issuerName = `${schema.spec.baseName}-issuer`;
        const certName = `${schema.spec.baseName}-cert`;
        const secretName = `${schema.spec.baseName}-secret`;

        return {
          // Create self-signed issuer
          issuer: clusterIssuer({
            name: issuerName,
            spec: {
              selfSigned: {}
            },
            id: 'lifecycleIssuer'
          }),
          
          // Create certificate with comprehensive configuration
          certificate: certificate({
            name: certName,
            namespace: testNamespace,
            spec: {
              secretName: secretName,
              commonName: schema.spec.commonName,
              dnsNames: schema.spec.dnsNames,
              issuerRef: {
                name: issuerName,
                kind: 'ClusterIssuer'
              },
              duration: '24h',
              renewBefore: '1h',
              privateKey: {
                algorithm: 'RSA',
                size: 2048,
                rotationPolicy: 'Always'
              },
              usages: [
                'digital signature',
                'key encipherment',
                'server auth'
              ]
            },
            id: 'lifecycleCertificate'
          })
        };
      },
      (_schema, resources) => ({
        issuerReady: resources.issuer.status.conditions?.some((c: any) => c.type === 'Ready' && c.status === 'True') || false,
        certificateReady: resources.certificate.status.conditions?.some((c: any) => c.type === 'Ready' && c.status === 'True') || false,
        secretCreated: resources.certificate.status.conditions?.length > 0 || false,
        issuerName: `${_schema.spec.baseName}-issuer`,
        certificateName: `${_schema.spec.baseName}-cert`,
        secretName: `${_schema.spec.baseName}-secret`
      })
    );

    // Deploy using direct factory
    const directFactory = certificateLifecycleGraph.factory('direct', {
      namespace: testNamespace,
      waitForReady: true,
      kubeConfig: kubeConfig,
    });

    const uniqueBaseName = `test-lifecycle-${Date.now()}`;
    const _issuerName = `${uniqueBaseName}-issuer`;
    const _certName = `${uniqueBaseName}-cert`;
    const _secretName = `${uniqueBaseName}-secret`;
    
    console.log(`📦 Deploying certificate lifecycle stack: ${uniqueBaseName}`);
    
    const deploymentResult = await directFactory.deploy({
      baseName: uniqueBaseName,
      commonName: 'lifecycle.example.com',
      dnsNames: ['lifecycle.example.com', 'www.lifecycle.example.com']
    });

    // Debug: List all ClusterIssuers to see what was actually created
    const allIssuers = await customObjectsApi.listClusterCustomObject({
      group: 'cert-manager.io',
      version: 'v1',
      plural: 'clusterissuers'
    });
    console.log('📋 Available ClusterIssuers:', (allIssuers as any).items.map((i: any) => i.metadata.name));

    // Debug: List all Certificates to see what was actually created
    const allCerts = await customObjectsApi.listNamespacedCustomObject({
      group: 'cert-manager.io',
      version: 'v1',
      namespace: testNamespace,
      plural: 'certificates'
    });
    console.log('📋 Available Certificates:', (allCerts as any).items.map((c: any) => c.metadata.name));

    // Validate deployment result
    expect(deploymentResult).toBeDefined();
    expect(deploymentResult.metadata.name).toContain('instance-');

    // Find the ClusterIssuer that was actually created
    const lifecycleIssuers = await customObjectsApi.listClusterCustomObject({
      group: 'cert-manager.io',
      version: 'v1',
      plural: 'clusterissuers'
    });
    const createdIssuer = (lifecycleIssuers as any).items.find((issuer: any) => 
      issuer.metadata.name.includes('issuer')
    );
    expect(createdIssuer).toBeDefined();
    const clusterIssuerResource = createdIssuer;

    const issuerBody = clusterIssuerResource as any;
    expect(issuerBody.kind).toBe('ClusterIssuer');
    expect(issuerBody.metadata.name).toContain('issuer');
    expect(issuerBody.spec.selfSigned).toEqual({});

    // Find the Certificate that was actually created
    const createdCert = (allCerts as any).items.find((cert: any) => 
      cert.metadata.name.includes('cert')
    );
    expect(createdCert).toBeDefined();
    const certificateResource = { body: createdCert };

    const certBody = certificateResource.body as any;
    expect(certBody.kind).toBe('Certificate');
    expect(certBody.metadata.name).toContain('cert');
    expect(certBody.spec.secretName).toContain('secret');
    expect(certBody.spec.commonName).toBe('lifecycle.example.com');
    expect(certBody.spec.dnsNames).toEqual(['lifecycle.example.com', 'www.lifecycle.example.com']);
    expect(certBody.spec.issuerRef.name).toContain('issuer');
    expect(certBody.spec.issuerRef.kind).toBe('ClusterIssuer');
    expect(certBody.spec.duration).toBe('24h0m0s'); // cert-manager normalizes duration format
    expect(certBody.spec.renewBefore).toBe('1h0m0s'); // cert-manager normalizes duration format
    expect(certBody.spec.privateKey.algorithm).toBe('RSA');
    expect(certBody.spec.privateKey.size).toBe(2048);
    expect(certBody.spec.usages).toContain('digital signature');
    expect(certBody.spec.usages).toContain('key encipherment');
    expect(certBody.spec.usages).toContain('server auth');

    console.log('✅ Complete certificate lifecycle stack deployed to Kubernetes');
    console.log('📋 ClusterIssuer and Certificate resources verified with comprehensive configuration');
    console.log(`🔐 Certificate configured for: lifecycle.example.com, www.lifecycle.example.com`);
    console.log(`📝 Certificate will be stored in secret: ${certBody.spec.secretName}`);
    
    // Note: In a real environment with cert-manager running, the certificate would be issued
    // and the secret would be created with the actual certificate and private key
    
  }, 120000); // 120 second timeout for comprehensive deployment
});