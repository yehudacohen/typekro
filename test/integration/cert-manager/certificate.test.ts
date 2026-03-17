import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type * as k8s from '@kubernetes/client-node';
import { type } from 'arktype';
import { createBunCompatibleCustomObjectsApi } from '../../../src/core/kubernetes/bun-api-client.js';
import { getKubeConfig } from '../../../src/core/kubernetes/client-provider.js';
import { kubernetesComposition, toResourceGraph } from '../../../src/index.js';
import { deleteNamespaceAndWait, ensureNamespaceExists } from '../shared-kubeconfig.js';

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

      // Ensure cert-manager is installed and ready
      const { ensureCertManagerInstalled } = await import('../shared-kubeconfig.js');
      await ensureCertManagerInstalled({
        namespace: 'cert-manager',
        version: '1.19.3',
        kubeConfig,
      });

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
      await customObjectsApi
        .listNamespacedCustomObject({
          group: 'cert-manager.io',
          version: 'v1',
          namespace: testNamespace,
          plural: 'certificates',
        })
        .then(async (response: any) => {
          const items = response.items || [];
          for (const item of items) {
            if (item.metadata.name.startsWith('test-')) {
              try {
                await customObjectsApi.deleteNamespacedCustomObject({
                  group: 'cert-manager.io',
                  version: 'v1',
                  namespace: testNamespace,
                  plural: 'certificates',
                  name: item.metadata.name,
                });
                console.log(`🗑️ Deleted Certificate: ${item.metadata.name}`);
              } catch (deleteError) {
                console.warn(`⚠️ Failed to delete Certificate ${item.metadata.name}:`, deleteError);
              }
            }
          }
        })
        .catch((error) => {
          console.warn('⚠️ Failed to list Certificates for cleanup:', error);
        });

      // Delete all ClusterIssuers that start with 'test-'
      await customObjectsApi
        .listClusterCustomObject({
          group: 'cert-manager.io',
          version: 'v1',
          plural: 'clusterissuers',
        })
        .then(async (response: any) => {
          const items = response.items || [];
          for (const item of items) {
            if (item.metadata.name.startsWith('test-')) {
              try {
                await customObjectsApi.deleteClusterCustomObject({
                  group: 'cert-manager.io',
                  version: 'v1',
                  plural: 'clusterissuers',
                  name: item.metadata.name,
                });
                console.log(`🗑️ Deleted ClusterIssuer: ${item.metadata.name}`);
              } catch (deleteError) {
                console.warn(
                  `⚠️ Failed to delete ClusterIssuer ${item.metadata.name}:`,
                  deleteError
                );
              }
            }
          }
        })
        .catch((error) => {
          console.warn('⚠️ Failed to list ClusterIssuers for cleanup:', error);
        });

      // Wait a moment for cleanup to complete
      await new Promise((resolve) => setTimeout(resolve, 2000));

      console.log('✅ Certificate test resource cleanup completed');
    } catch (error) {
      console.warn('⚠️ Certificate test cleanup failed (non-critical):', error);
    }
  });

  afterAll(async () => {
    console.log('Cleaning up cert-manager certificate real integration tests...');
    await deleteNamespaceAndWait(testNamespace, kubeConfig);
  });

  it('should deploy Certificate resource to Kubernetes using direct factory', async () => {
    console.log('🚀 Testing Certificate deployment with direct factory...');

    const { certificate } = await import(
      '../../../src/factories/cert-manager/resources/certificates.js'
    );
    const { clusterIssuer } = await import(
      '../../../src/factories/cert-manager/resources/issuers.js'
    );

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
            selfSigned: {},
          },
          id: 'testIssuer',
        });

        return {
          ready:
            issuer.status.conditions?.some((c: any) => c.type === 'Ready' && c.status === 'True') ||
            false,
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
      name: issuerName,
    });

    // Now create a Certificate composition
    const CertificateSpec = type({
      name: 'string',
      secretName: 'string',
      commonName: 'string',
      issuerName: 'string',
    });

    const CertificateStatus = type({
      ready: 'boolean',
      issued: 'boolean',
      secretName: 'string',
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
              kind: 'ClusterIssuer',
            },
            duration: '24h',
            renewBefore: '1h',
          },
          id: 'testCertificate',
        });

        return {
          ready:
            cert.status.conditions?.some((c: any) => c.type === 'Ready' && c.status === 'True') ||
            false,
          issued:
            cert.status.conditions?.some((c: any) => c.type === 'Ready' && c.status === 'True') ||
            false,
          secretName: spec.secretName,
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
      issuerName: issuerName,
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
      name: certName,
    });

    expect(certificateResource).toBeDefined();
    const certBody = certificateResource as unknown as Record<string, unknown>;
    expect(certBody.kind).toBe('Certificate');
    const certMeta = certBody.metadata as Record<string, unknown>;
    expect(certMeta.name).toBe(certName);
    const certSpec = certBody.spec as Record<string, unknown>;
    expect(certSpec.secretName).toBe(secretName);
    expect(certSpec.commonName).toBe('test.example.com');
    const certIssuerRef = certSpec.issuerRef as Record<string, unknown>;
    expect(certIssuerRef.name).toBe(issuerName);
    expect(certIssuerRef.kind).toBe('ClusterIssuer');

    console.log('✅ Certificate successfully deployed to Kubernetes');
    console.log('📋 Certificate resource verified in cluster');
    console.log(`🔐 Certificate will create secret: ${secretName}`);
  }, 120000); // 120 second timeout for real deployment

  it('should deploy complete certificate issuance stack and verify certificate lifecycle', async () => {
    console.log('🚀 Testing complete certificate lifecycle with real cert-manager...');

    const { clusterIssuer } = await import(
      '../../../src/factories/cert-manager/resources/issuers.js'
    );
    const { certificate } = await import(
      '../../../src/factories/cert-manager/resources/certificates.js'
    );

    // Create a comprehensive certificate issuance composition
    const CertificateLifecycleSpecSchema = type({
      baseName: 'string',
      commonName: 'string',
      dnsNames: 'string[]',
    });

    const CertificateLifecycleStatusSchema = type({
      issuerReady: 'boolean',
      certificateReady: 'boolean',
      secretCreated: 'boolean',
      issuerName: 'string',
      certificateName: 'string',
      secretName: 'string',
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
              selfSigned: {},
            },
            id: 'lifecycleIssuer',
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
                kind: 'ClusterIssuer',
              },
              duration: '24h',
              renewBefore: '1h',
              privateKey: {
                algorithm: 'RSA',
                size: 2048,
                rotationPolicy: 'Always',
              },
              usages: ['digital signature', 'key encipherment', 'server auth'],
            },
            id: 'lifecycleCertificate',
          }),
        };
      },
      (_schema, resources) => ({
        issuerReady:
          resources.issuer.status.conditions?.some(
            (c: any) => c.type === 'Ready' && c.status === 'True'
          ) || false,
        certificateReady:
          resources.certificate.status.conditions?.some(
            (c: any) => c.type === 'Ready' && c.status === 'True'
          ) || false,
        secretCreated: resources.certificate.status.conditions?.length > 0 || false,
        issuerName: `${_schema.spec.baseName}-issuer`,
        certificateName: `${_schema.spec.baseName}-cert`,
        secretName: `${_schema.spec.baseName}-secret`,
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
      dnsNames: ['lifecycle.example.com', 'www.lifecycle.example.com'],
    });

    // Debug: List all ClusterIssuers to see what was actually created
    const allIssuers = await customObjectsApi.listClusterCustomObject({
      group: 'cert-manager.io',
      version: 'v1',
      plural: 'clusterissuers',
    });
    console.log(
      '📋 Available ClusterIssuers:',
      (allIssuers as unknown as Record<string, Record<string, unknown>[]>).items!.map(
        (i) => (i.metadata as Record<string, string>).name
      )
    );

    // Debug: List all Certificates to see what was actually created
    const allCerts = await customObjectsApi.listNamespacedCustomObject({
      group: 'cert-manager.io',
      version: 'v1',
      namespace: testNamespace,
      plural: 'certificates',
    });
    console.log(
      '📋 Available Certificates:',
      (allCerts as unknown as Record<string, Record<string, unknown>[]>).items!.map(
        (c) => (c.metadata as Record<string, string>).name
      )
    );

    // Validate deployment result
    expect(deploymentResult).toBeDefined();
    expect(deploymentResult.metadata.name).toContain('instance-');

    // Find the ClusterIssuer that was actually created
    const lifecycleIssuers = await customObjectsApi.listClusterCustomObject({
      group: 'cert-manager.io',
      version: 'v1',
      plural: 'clusterissuers',
    });
    const createdIssuer = (
      lifecycleIssuers as unknown as Record<string, Record<string, unknown>[]>
    ).items!.find((issuer) =>
      ((issuer.metadata as Record<string, string>).name ?? '').includes('issuer')
    );
    expect(createdIssuer).toBeDefined();

    const issuerBody = createdIssuer as Record<string, unknown>;
    expect(issuerBody.kind).toBe('ClusterIssuer');
    expect((issuerBody.metadata as Record<string, string>).name).toContain('issuer');
    expect((issuerBody.spec as Record<string, unknown>).selfSigned).toEqual({});

    // Find the Certificate that was actually created
    const createdCert = (
      allCerts as unknown as Record<string, Record<string, unknown>[]>
    ).items!.find((cert) =>
      ((cert.metadata as Record<string, string>).name ?? '').includes('cert')
    );
    expect(createdCert).toBeDefined();

    const certBody2 = createdCert as Record<string, unknown>;
    const certBody2Spec = certBody2.spec as Record<string, unknown>;
    const certBody2Meta = certBody2.metadata as Record<string, string>;
    expect(certBody2.kind).toBe('Certificate');
    expect(certBody2Meta.name).toContain('cert');
    expect(certBody2Spec.secretName).toContain('secret');
    expect(certBody2Spec.commonName).toBe('lifecycle.example.com');
    expect(certBody2Spec.dnsNames).toEqual(['lifecycle.example.com', 'www.lifecycle.example.com']);
    const certBody2IssuerRef = certBody2Spec.issuerRef as Record<string, unknown>;
    expect(certBody2IssuerRef.name).toContain('issuer');
    expect(certBody2IssuerRef.kind).toBe('ClusterIssuer');
    expect(certBody2Spec.duration).toBe('24h'); // cert-manager 1.19.3 normalizes duration format
    expect(certBody2Spec.renewBefore).toBe('1h'); // cert-manager 1.19.3 normalizes duration format
    const certBody2PK = certBody2Spec.privateKey as Record<string, unknown>;
    expect(certBody2PK.algorithm).toBe('RSA');
    expect(certBody2PK.size).toBe(2048);
    expect(certBody2Spec.usages).toContain('digital signature');
    expect(certBody2Spec.usages).toContain('key encipherment');
    expect(certBody2Spec.usages).toContain('server auth');

    console.log('✅ Complete certificate lifecycle stack deployed to Kubernetes');
    console.log(
      '📋 ClusterIssuer and Certificate resources verified with comprehensive configuration'
    );
    console.log(`🔐 Certificate configured for: lifecycle.example.com, www.lifecycle.example.com`);
    console.log(`📝 Certificate will be stored in secret: ${certBody2Spec.secretName}`);

    // Note: In a real environment with cert-manager running, the certificate would be issued
    // and the secret would be created with the actual certificate and private key
  }, 120000); // 120 second timeout for comprehensive deployment
});
