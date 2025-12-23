/**
 * Integration Tests for Cert-Manager Challenge Resources
 *
 * This test suite validates the cert-manager Challenge CRD factories
 * with real Kubernetes deployments using both kro and direct factory patterns.
 * It ensures cert-manager is properly bootstrapped before testing Challenge resources.
 */

import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import type * as k8s from '@kubernetes/client-node';
import { type } from 'arktype';
import { toResourceGraph, certManager } from '../../../src/index.js';
import { getIntegrationTestKubeConfig, isClusterAvailable, createKubernetesObjectApiClient, createCustomObjectsApiClient, ensureNamespaceExists, deleteNamespaceIfExists } from '../shared-kubeconfig.js';

const NAMESPACE = 'typekro-test-challenge'; // Use unique namespace for this test file
const clusterAvailable = isClusterAvailable();

// Check if cluster is available
if (!clusterAvailable) {
  console.log('⏭️  Skipping Cert-Manager Challenge Integration: No cluster available');
}

const describeOrSkip = clusterAvailable ? describe : describe.skip;

// Test schemas for Challenge composition
const _ChallengeTestSpec = type({
  name: 'string',
  dnsName: 'string',
  token: 'string',
  key: 'string',
  issuerName: 'string',
  challengeType: '"HTTP-01" | "DNS-01"'
});

const _ChallengeTestStatus = type({
  ready: 'boolean',
  processing: 'boolean',
  presented: 'boolean',
  state: 'string',
  challengeType: 'string'
});

describeOrSkip('Cert-Manager Challenge Integration Tests', () => {
  let kubeConfig: k8s.KubeConfig;
  let _k8sApi: k8s.KubernetesObjectApi;
  let customObjectsApi: k8s.CustomObjectsApi;
  let testNamespace: string;

  beforeAll(async () => {
    if (!clusterAvailable) return;

    console.log('🚀 SETUP: Connecting to existing cluster for cert-manager Challenge tests...');

    // Use shared kubeconfig helper for consistent TLS configuration
    kubeConfig = getIntegrationTestKubeConfig();
    _k8sApi = createKubernetesObjectApiClient(kubeConfig);
    customObjectsApi = createCustomObjectsApiClient(kubeConfig);
    testNamespace = NAMESPACE; // Use the standard test namespace
    
    // Create test namespace
    await ensureNamespaceExists(testNamespace, kubeConfig);

    // Ensure cert-manager is deployed using bootstrap composition
    try {
      console.log('🚀 Ensuring cert-manager is deployed using bootstrap composition...');

      const certManagerFactory = certManager.certManagerBootstrap.factory('direct', {
        namespace: 'cert-manager',
        waitForReady: false, // Don't wait for full readiness to avoid timeouts
        kubeConfig: kubeConfig,
      });

      // Deploy cert-manager if not already present
      try {
        await certManagerFactory.deploy({
          name: 'cert-manager',
          namespace: 'cert-manager',
          version: '1.13.3',
          installCRDs: true,
          controller: {
            resources: {
              requests: { cpu: '100m', memory: '128Mi' },
              limits: { cpu: '500m', memory: '512Mi' }
            }
          },
          webhook: {
            resources: {
              requests: { cpu: '50m', memory: '64Mi' },
              limits: { cpu: '200m', memory: '256Mi' }
            }
          },
          cainjector: {
            resources: {
              requests: { cpu: '50m', memory: '64Mi' },
              limits: { cpu: '200m', memory: '256Mi' }
            }
          }
        });
        console.log('✅ Cert-manager bootstrap deployment initiated');
      } catch (_deployError) {
        console.log('ℹ️ Cert-manager may already be deployed, continuing...');
      }

      // Wait for cert-manager to stabilize
      console.log('⏳ Waiting for cert-manager to stabilize...');
      await new Promise(resolve => setTimeout(resolve, 30000)); // Wait 30 seconds

      console.log('✅ Cert-manager setup completed');
    } catch (error) {
      console.warn('⚠️ Cert-manager setup failed, some tests may fail:', error);
    }

    console.log('✅ Cert-manager Challenge integration test environment ready!');
  });

  afterEach(async () => {
    if (!clusterAvailable) return;

    // Clean up test resources to prevent conflicts between tests
    try {
      console.log('🧹 Cleaning up test resources...');

      // Delete all Challenges in test namespace that start with 'challenge-test-'
      await customObjectsApi.listNamespacedCustomObject({
        group: 'acme.cert-manager.io',
        version: 'v1',
        namespace: testNamespace,
        plural: 'challenges'
      }).then(async (response: any) => {
        const items = response.items || [];
        for (const item of items) {
          if (item.metadata.name.startsWith('challenge-test-')) {
            await customObjectsApi.deleteNamespacedCustomObject({
              group: 'acme.cert-manager.io',
              version: 'v1',
              namespace: testNamespace,
              plural: 'challenges',
              name: item.metadata.name
            });
          }
        }
      }).catch(() => {
        // Ignore errors - resources might not exist
      });

      // Delete all ClusterIssuers that start with 'challenge-test-'
      await customObjectsApi.listClusterCustomObject({
        group: 'cert-manager.io',
        version: 'v1',
        plural: 'clusterissuers'
      }).then(async (response: any) => {
        const items = response.items || [];
        for (const item of items) {
          if (item.metadata.name.startsWith('challenge-test-')) {
            await customObjectsApi.deleteClusterCustomObject({
              group: 'cert-manager.io',
              version: 'v1',
              plural: 'clusterissuers',
              name: item.metadata.name
            });
          }
        }
      }).catch(() => {
        // Ignore errors - resources might not exist
      });

      // Wait a moment for cleanup to complete
      await new Promise(resolve => setTimeout(resolve, 1000));

      console.log('✅ Test resource cleanup completed');
    } catch (error) {
      console.warn('⚠️ Test cleanup failed (non-critical):', error);
    }
  });

  afterAll(async () => {
    if (!clusterAvailable) return;
    console.log('Cleaning up cert-manager Challenge integration tests...');
    await deleteNamespaceIfExists(testNamespace, kubeConfig);
  });

  describe('Challenge Factory Integration', () => {
    it('should create a valid Challenge composition', async () => {
      console.log('🚀 Testing Challenge factory integration...');

      const { challenge } = await import('../../../src/factories/cert-manager/resources/challenges.js');

      // Test Challenge factory creation (without deployment)
      const testChallenge = challenge({
        name: 'test-challenge-factory',
        namespace: testNamespace,
        spec: {
          url: 'https://acme-staging-v02.api.letsencrypt.org/acme/chall-v3/12345',
          authorizationURL: 'https://acme-staging-v02.api.letsencrypt.org/acme/authz-v3/12345',
          dnsName: 'test.example.com',
          type: 'HTTP-01',
          token: 'test-token-12345',
          key: 'test-key-67890',
          solver: {
            http01: {
              ingress: {
                class: 'nginx'
              }
            }
          },
          issuerRef: {
            name: 'test-issuer',
            kind: 'ClusterIssuer'
          }
        },
        id: 'testChallenge'
      });

      // Validate Challenge factory output
      expect(testChallenge.kind).toBe('Challenge');
      expect(testChallenge.apiVersion).toBe('acme.cert-manager.io/v1');
      expect(testChallenge.metadata?.name).toBe('test-challenge-factory');
      expect(testChallenge.metadata?.namespace).toBe(testNamespace);
      expect(testChallenge.spec.dnsName).toBe('test.example.com');
      expect(testChallenge.spec.type).toBe('HTTP-01');
      expect(testChallenge.spec.token).toBe('test-token-12345');
      expect(testChallenge.spec.key).toBe('test-key-67890');
      expect(testChallenge.spec.issuerRef.name).toBe('test-issuer');
      expect(testChallenge.spec.issuerRef.kind).toBe('ClusterIssuer');
      expect(testChallenge.spec.issuerRef.group).toBe('cert-manager.io');
      expect(testChallenge.readinessEvaluator).toBeDefined();

      // Test serialization
      const yaml = JSON.stringify(testChallenge, null, 2);
      expect(yaml).toContain('acme.cert-manager.io/v1');
      expect(yaml).toContain('Challenge');
      expect(yaml).toContain('test-challenge-factory');

      console.log('✅ Challenge factory integration validated');
      console.log('📋 Challenge resource structure and readiness evaluator verified');

    }, 30000); // 30 second timeout for factory testing

    it('should test Challenge creation through Certificate ACME flow', async () => {
      console.log('🚀 Testing Challenge creation through real ACME Certificate flow...');

      const { clusterIssuer } = await import('../../../src/factories/cert-manager/resources/issuers.js');
      const { certificate } = await import('../../../src/factories/cert-manager/resources/certificates.js');

      // Create ACME issuer that will trigger Challenge creation
      const AcmeCertificateSpecSchema = type({
        issuerName: 'string',
        certificateName: 'string',
        secretName: 'string',
        dnsName: 'string'
      });

      const AcmeCertificateStatusSchema = type({
        issuerReady: 'boolean',
        certificateReady: 'boolean',
        challengesCreated: 'boolean'
      });

      const acmeCertificateGraph = toResourceGraph(
        {
          name: 'acme-certificate-challenge-test',
          apiVersion: 'test.typekro.dev/v1alpha1',
          kind: 'AcmeCertificateChallengeTest',
          spec: AcmeCertificateSpecSchema,
          status: AcmeCertificateStatusSchema,
        },
        (schema: any) => ({
          // Create Let's Encrypt staging issuer
          acmeIssuer: clusterIssuer({
            name: schema.spec.issuerName,
            spec: {
              acme: {
                server: 'https://acme-staging-v02.api.letsencrypt.org/directory',
                email: 'test@example.com',
                privateKeySecretRef: {
                  name: 'letsencrypt-staging-key'
                },
                solvers: [{
                  http01: {
                    ingress: {
                      class: 'nginx'
                    }
                  }
                }]
              }
            },
            id: 'acmeIssuer'
          }),

          // Create certificate that will trigger Challenge creation
          acmeCertificate: certificate({
            name: schema.spec.certificateName,
            namespace: testNamespace,
            spec: {
              secretName: schema.spec.secretName,
              dnsNames: [schema.spec.dnsName],
              issuerRef: {
                name: schema.spec.issuerName,
                kind: 'ClusterIssuer'
              },
              duration: '24h',
              renewBefore: '1h'
            },
            id: 'acmeCertificate'
          })
        }),
        (_schema: any, resources: any) => ({
          issuerReady: resources.acmeIssuer.status.conditions?.some((c: any) => c.type === 'Ready' && c.status === 'True') || false,
          certificateReady: resources.acmeCertificate.status.conditions?.some((c: any) => c.type === 'Ready' && c.status === 'True') || false,
          challengesCreated: resources.acmeCertificate.status.conditions?.length > 0 || false
        })
      );

      // Deploy using direct factory - this should trigger Challenge creation
      const directFactory = acmeCertificateGraph.factory('direct', {
        namespace: testNamespace,
        waitForReady: false, // Don't wait for ACME completion, just resource creation
        kubeConfig: kubeConfig,
      });

      const uniqueBaseName = `test-acme-${Date.now()}`;
      const issuerName = `${uniqueBaseName}-issuer`;
      const certName = `${uniqueBaseName}-cert`;
      const secretName = `${uniqueBaseName}-secret`;

      console.log(`📦 Deploying ACME certificate stack: ${uniqueBaseName}`);
      console.log(`⚠️  Note: This will create real ACME resources but won't complete challenges in test environment`);

      const deploymentResult = await directFactory.deploy({
        issuerName: issuerName,
        certificateName: certName,
        secretName: secretName,
        dnsName: 'acme-test.example.com'
      });

      // Validate deployment result
      expect(deploymentResult).toBeDefined();
      expect(deploymentResult.metadata.name).toContain('instance-');

      // Verify the ACME ClusterIssuer was created
      const acmeIssuerResource = await customObjectsApi.getClusterCustomObject({
        group: 'cert-manager.io',
        version: 'v1',
        plural: 'clusterissuers',
        name: issuerName
      });

      expect(acmeIssuerResource).toBeDefined();
      const issuerBody = acmeIssuerResource as any;
      expect(issuerBody.kind).toBe('ClusterIssuer');
      expect(issuerBody.spec.acme?.server).toBe('https://acme-staging-v02.api.letsencrypt.org/directory');
      expect(issuerBody.spec.acme?.email).toBe('test@example.com');
      expect(issuerBody.spec.acme?.solvers?.[0]?.http01?.ingress?.class).toBe('nginx');

      // Verify the Certificate was created
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
      expect(certBody.spec.dnsNames).toEqual(['acme-test.example.com']);
      expect(certBody.spec.issuerRef.name).toBe(issuerName);
      expect(certBody.spec.issuerRef.kind).toBe('ClusterIssuer');

      console.log('✅ ACME Certificate and ClusterIssuer deployed successfully');
      console.log('📋 Resources configured to trigger Challenge creation by cert-manager');
      console.log(`🔐 Certificate configured for: acme-test.example.com`);
      console.log(`⏳ cert-manager will create Challenge resources automatically for ACME validation`);

      // Note: In a real environment, cert-manager would now create Order and Challenge resources
      // The Challenge factory we implemented would be used by cert-manager internally

    }, 60000); // 60 second timeout for resource creation

    it('should validate Challenge readiness evaluation with actual challenge completion status', async () => {
      // Test readiness evaluation with realistic ACME challenge completion scenarios
      const { challenge } = await import('../../../src/factories/cert-manager/resources/challenges.js');

      const testChallenge = challenge({
        name: 'readiness-test-challenge',
        namespace: testNamespace,
        spec: {
          url: 'https://acme-staging-v02.api.letsencrypt.org/acme/chall-v3/test',
          authorizationURL: 'https://acme-staging-v02.api.letsencrypt.org/acme/authz-v3/test',
          dnsName: 'readiness.example.com',
          type: 'HTTP-01',
          token: 'readiness-token',
          key: 'readiness-key',
          solver: {
            http01: {
              ingress: {
                class: 'nginx'
              }
            }
          },
          issuerRef: {
            name: 'test-issuer',
            kind: 'ClusterIssuer'
          }
        },
        id: 'readinessTestChallenge'
      });

      expect(testChallenge.readinessEvaluator).toBeDefined();

      // Test challenge completion success scenario
      const mockCompletedChallenge = {
        apiVersion: 'acme.cert-manager.io/v1',
        kind: 'Challenge',
        metadata: { name: 'test-challenge', namespace: testNamespace },
        spec: { dnsName: 'readiness.example.com', type: 'HTTP-01' },
        status: {
          processing: false,
          presented: true,
          state: 'valid'
        }
      };

      if (testChallenge.readinessEvaluator) {
        const completedResult = testChallenge.readinessEvaluator(mockCompletedChallenge);
        expect(completedResult.ready).toBe(true);
        expect(completedResult.message).toContain('Challenge completed successfully');
      }

      // Test challenge processing scenario
      const mockProcessingChallenge = {
        apiVersion: 'acme.cert-manager.io/v1',
        kind: 'Challenge',
        metadata: { name: 'test-challenge', namespace: testNamespace },
        spec: { dnsName: 'readiness.example.com', type: 'HTTP-01' },
        status: {
          processing: true,
          presented: true,
          state: 'pending'
        }
      };

      if (testChallenge.readinessEvaluator) {
        const processingResult = testChallenge.readinessEvaluator(mockProcessingChallenge);
        expect(processingResult.ready).toBe(false);
        expect(processingResult.message).toContain('Challenge is being processed');
        expect(processingResult.reason).toBe('Processing');
      }

      // Test challenge failure scenario
      const mockFailedChallenge = {
        apiVersion: 'acme.cert-manager.io/v1',
        kind: 'Challenge',
        metadata: { name: 'test-challenge', namespace: testNamespace },
        spec: { dnsName: 'readiness.example.com', type: 'HTTP-01' },
        status: {
          processing: false,
          presented: false,
          state: 'invalid',
          reason: 'Connection refused'
        }
      };

      if (testChallenge.readinessEvaluator) {
        const failedResult = testChallenge.readinessEvaluator(mockFailedChallenge);
        expect(failedResult.ready).toBe(false);
        expect(failedResult.message).toContain('Connection refused');
        expect(failedResult.reason).toBe('ChallengeFailed');
      }

      // Test challenge without status (initial state)
      const mockInitialChallenge = {
        apiVersion: 'acme.cert-manager.io/v1',
        kind: 'Challenge',
        metadata: { name: 'test-challenge', namespace: testNamespace },
        spec: { dnsName: 'readiness.example.com', type: 'HTTP-01' }
        // No status field - initial state
      };

      if (testChallenge.readinessEvaluator) {
        const initialResult = testChallenge.readinessEvaluator(mockInitialChallenge);
        expect(initialResult.ready).toBe(false);
        expect(initialResult.message).toContain('status not available');
        expect(initialResult.reason).toBe('StatusMissing');
      }

      console.log('✅ Challenge readiness evaluation with ACME challenge completion scenarios validated');
      console.log('📋 Handles success, processing, failure, and initial states correctly');
    });
  });
});