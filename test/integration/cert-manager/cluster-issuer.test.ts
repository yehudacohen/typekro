import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import * as k8s from '@kubernetes/client-node';
import { getKubeConfig } from '../../../src/core/kubernetes/client-provider.js';
import { toResourceGraph, kubernetesComposition } from '../../../src/index.js';
import { type } from 'arktype';

describe('Cert-Manager ClusterIssuer Real Integration Tests', () => {
  let kubeConfig: k8s.KubeConfig;
  let customObjectsApi: k8s.CustomObjectsApi;
  const testNamespace = 'typekro-test';

  beforeAll(async () => {
    console.log('Setting up cert-manager ClusterIssuer real integration tests...');

    // Get cluster connection
    try {
      kubeConfig = getKubeConfig({ skipTLSVerify: true });
      customObjectsApi = kubeConfig.makeApiClient(k8s.CustomObjectsApi);
      console.log('✅ Cluster connection established');
    } catch (error) {
      console.error('❌ Failed to connect to cluster:', error);
      throw error;
    }
  });

  afterEach(async () => {
    // Clean up test resources to prevent conflicts between tests
    try {
      console.log('🧹 Cleaning up ClusterIssuer test resources...');

      // Delete all ClusterIssuers that start with 'test-' or 'integration-'
      await customObjectsApi.listClusterCustomObject(
        'cert-manager.io',
        'v1',
        'clusterissuers'
      ).then(async (response: any) => {
        const items = response.body.items || [];
        for (const item of items) {
          if (item.metadata.name.startsWith('test-') || item.metadata.name.startsWith('integration-')) {
            try {
              await customObjectsApi.deleteClusterCustomObject(
                'cert-manager.io',
                'v1',
                'clusterissuers',
                item.metadata.name
              );
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

      console.log('✅ ClusterIssuer test resource cleanup completed');
    } catch (error) {
      console.warn('⚠️ ClusterIssuer test cleanup failed (non-critical):', error);
    }
  });

  afterAll(async () => {
    console.log('Cleaning up cert-manager ClusterIssuer real integration tests...');
  });

  it('should deploy ClusterIssuer resource to Kubernetes using direct factory', async () => {
    console.log('🚀 Testing ClusterIssuer deployment with direct factory...');

    const { clusterIssuer } = await import('../../../src/factories/cert-manager/resources/issuers.js');

    // Create a composition for ClusterIssuer deployment
    const ClusterIssuerSpec = type({
      name: 'string',
      email: 'string'
    });

    const ClusterIssuerStatus = type({
      ready: 'boolean',
      issuerType: 'string',
      message: 'string'
    });

    const clusterIssuerComposition = kubernetesComposition(
      {
        name: 'cluster-issuer-test',
        apiVersion: 'test.typekro.dev/v1alpha1',
        kind: 'ClusterIssuerTest',
        spec: ClusterIssuerSpec,
        status: ClusterIssuerStatus,
      },
      (spec) => {
        // Create a self-signed ClusterIssuer (doesn't require external dependencies)
        const issuer = clusterIssuer({
          name: spec.name,
          spec: {
            selfSigned: {}
          },
          id: 'testIssuer'
        });

        // Return status - will be evaluated by readiness evaluator
        return {
          ready: issuer.status.conditions?.some((c: any) => c.type === 'Ready' && c.status === 'True') || false,
          issuerType: 'self-signed',
          message: 'ClusterIssuer deployed successfully'
        };
      }
    );

    // Test with direct factory - this will actually deploy to Kubernetes
    const directFactory = clusterIssuerComposition.factory('direct', {
      namespace: testNamespace,
      waitForReady: true,
      kubeConfig: kubeConfig,
    });

    const uniqueName = `test-self-signed-${Date.now()}`;
    console.log(`📦 Deploying ClusterIssuer: ${uniqueName}`);

    const deploymentResult = await directFactory.deploy({
      name: uniqueName,
      email: 'test@example.com'
    });

    // Validate deployment result
    expect(deploymentResult).toBeDefined();
    expect(deploymentResult.metadata.name).toBe(uniqueName);
    expect(deploymentResult.spec.name).toBe(uniqueName);

    // Verify the ClusterIssuer was actually created in Kubernetes
    const clusterIssuerResource = await customObjectsApi.getClusterCustomObject(
      'cert-manager.io',
      'v1',
      'clusterissuers',
      uniqueName
    );

    expect(clusterIssuerResource.body).toBeDefined();
    const issuerBody = clusterIssuerResource.body as any;
    expect(issuerBody.kind).toBe('ClusterIssuer');
    expect(issuerBody.metadata.name).toBe(uniqueName);
    expect(issuerBody.spec.selfSigned).toEqual({});

    console.log('✅ ClusterIssuer successfully deployed to Kubernetes');
    console.log('📋 ClusterIssuer resource verified in cluster');

  }, 60000); // 60 second timeout for real deployment

  it('should deploy complete certificate issuance stack with ClusterIssuer and Certificate to Kubernetes', async () => {
    console.log('🚀 Testing complete certificate issuance with ClusterIssuer and Certificate...');

    const { clusterIssuer } = await import('../../../src/factories/cert-manager/resources/issuers.js');
    const { certificate } = await import('../../../src/factories/cert-manager/resources/certificates.js');

    // Create a resource graph that includes both issuer and certificate
    const CertificateIssuanceSpecSchema = type({
      issuerName: 'string',
      certificateName: 'string',
      secretName: 'string',
      commonName: 'string'
    });

    const CertificateIssuanceStatusSchema = type({
      issuerReady: 'boolean',
      certificateReady: 'boolean',
      secretCreated: 'boolean'
    });

    const certificateIssuanceGraph = toResourceGraph(
      {
        name: 'certificate-issuance-test',
        apiVersion: 'test.typekro.dev/v1alpha1',
        kind: 'CertificateIssuanceTest',
        spec: CertificateIssuanceSpecSchema,
        status: CertificateIssuanceStatusSchema,
      },
      (schema) => ({
        // Create self-signed issuer first
        selfSignedIssuer: clusterIssuer({
          name: schema.spec.issuerName,
          spec: {
            selfSigned: {}
          },
          id: 'selfSignedIssuer'
        }),

        // Create certificate that references the issuer
        testCertificate: certificate({
          name: schema.spec.certificateName,
          namespace: testNamespace,
          spec: {
            secretName: schema.spec.secretName,
            commonName: schema.spec.commonName,
            dnsNames: [schema.spec.commonName],
            issuerRef: {
              name: schema.spec.issuerName, // Reference the issuer we created
              kind: 'ClusterIssuer'
            },
            duration: '24h', // Short duration for testing
            renewBefore: '1h'
          },
          id: 'testCertificate'
        })
      }),
      (_schema, resources) => ({
        issuerReady: resources.selfSignedIssuer.status.conditions?.some((c: any) => c.type === 'Ready' && c.status === 'True') || false,
        certificateReady: resources.testCertificate.status.conditions?.some((c: any) => c.type === 'Ready' && c.status === 'True') || false,
        secretCreated: resources.testCertificate.status.conditions?.length > 0 || false
      })
    );

    // Deploy using direct factory - this will actually deploy both resources to Kubernetes
    const directFactory = certificateIssuanceGraph.factory('direct', {
      namespace: testNamespace,
      waitForReady: true,
      kubeConfig: kubeConfig,
    });

    const uniqueBaseName = `test-cert-issuance-${Date.now()}`;
    const issuerName = `${uniqueBaseName}-issuer`;
    const certName = `${uniqueBaseName}-cert`;
    const secretName = `${uniqueBaseName}-secret`;

    console.log(`📦 Deploying certificate issuance stack: ${uniqueBaseName}`);

    const deploymentResult = await directFactory.deploy({
      issuerName: issuerName,
      certificateName: certName,
      secretName: secretName,
      commonName: 'test.example.com'
    });

    // Validate deployment result
    expect(deploymentResult).toBeDefined();
    expect(deploymentResult.metadata.name).toContain('instance-');

    // Verify the ClusterIssuer was actually created in Kubernetes
    const clusterIssuerResource = await customObjectsApi.getClusterCustomObject(
      'cert-manager.io',
      'v1',
      'clusterissuers',
      issuerName
    );

    expect(clusterIssuerResource.body).toBeDefined();
    const issuerBody = clusterIssuerResource.body as any;
    expect(issuerBody.kind).toBe('ClusterIssuer');
    expect(issuerBody.metadata.name).toBe(issuerName);
    expect(issuerBody.spec.selfSigned).toEqual({});

    // Verify the Certificate was actually created in Kubernetes
    const certificateResource = await customObjectsApi.getNamespacedCustomObject(
      'cert-manager.io',
      'v1',
      testNamespace,
      'certificates',
      certName
    );

    expect(certificateResource.body).toBeDefined();
    const certBody = certificateResource.body as any;
    expect(certBody.kind).toBe('Certificate');
    expect(certBody.metadata.name).toBe(certName);
    expect(certBody.spec.secretName).toBe(secretName);
    expect(certBody.spec.commonName).toBe('test.example.com');
    expect(certBody.spec.issuerRef.name).toBe(issuerName);
    expect(certBody.spec.issuerRef.kind).toBe('ClusterIssuer');

    console.log('✅ Complete certificate issuance stack deployed to Kubernetes');
    console.log('📋 Both ClusterIssuer and Certificate resources verified in cluster');
    console.log(`🔐 Certificate will be issued to secret: ${secretName}`);

    // Clean up the certificate (ClusterIssuer will be cleaned up by afterEach)
    try {
      await customObjectsApi.deleteNamespacedCustomObject(
        'cert-manager.io',
        'v1',
        testNamespace,
        'certificates',
        certName
      );
      console.log(`🗑️ Cleaned up Certificate: ${certName}`);
    } catch (error) {
      console.warn(`⚠️ Failed to clean up Certificate ${certName}:`, error);
    }

  }, 120000); // 120 second timeout for real certificate issuance

  it('should validate ClusterIssuer factory integration with TypeKro features', async () => {
    // Test that ClusterIssuer factory works with TypeKro's serialization and deployment features
    const { clusterIssuer } = await import('../../../src/factories/cert-manager/resources/issuers.js');

    const testIssuer = clusterIssuer({
      name: 'integration-test-issuer-features',
      spec: {
        acme: {
          server: 'https://acme-staging-v02.api.letsencrypt.org/directory',
          email: 'test@example.com',
          privateKeySecretRef: {
            name: 'letsencrypt-staging'
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
      id: 'integrationIssuer'
    });

    // Validate TypeKro integration features
    expect(testIssuer.kind).toBe('ClusterIssuer');
    expect(testIssuer.apiVersion).toBe('cert-manager.io/v1');
    expect(testIssuer.readinessEvaluator).toBeDefined();

    // Test serialization (this should work without errors)
    const yaml = JSON.stringify(testIssuer, null, 2);
    expect(yaml).toContain('cert-manager.io/v1');
    expect(yaml).toContain('ClusterIssuer');
    expect(yaml).toContain('integration-test-issuer-features');

    console.log('✅ ClusterIssuer factory TypeKro integration validated');
  });

  it('should support comprehensive ACME solver configurations for real certificate issuance', async () => {
    // Test comprehensive ACME configurations that would work with real ACME providers
    const { clusterIssuer } = await import('../../../src/factories/cert-manager/resources/issuers.js');

    // Test Let's Encrypt production with HTTP01 challenge
    const letsEncryptProd = clusterIssuer({
      name: 'letsencrypt-prod-http01',
      spec: {
        acme: {
          server: 'https://acme-v02.api.letsencrypt.org/directory',
          email: 'admin@example.com',
          privateKeySecretRef: {
            name: 'letsencrypt-prod'
          },
          solvers: [{
            http01: {
              ingress: {
                class: 'nginx',
                podTemplate: {
                  metadata: {
                    annotations: {
                      'kubernetes.io/ingress.class': 'nginx'
                    }
                  },
                  spec: {
                    nodeSelector: {
                      'kubernetes.io/os': 'linux'
                    }
                  }
                }
              }
            }
          }]
        }
      },
      id: 'letsEncryptProd'
    });

    // Test Let's Encrypt with DNS01 challenge using multiple providers
    const letsEncryptDns01 = clusterIssuer({
      name: 'letsencrypt-dns01-multi',
      spec: {
        acme: {
          server: 'https://acme-v02.api.letsencrypt.org/directory',
          email: 'admin@example.com',
          privateKeySecretRef: {
            name: 'letsencrypt-dns01'
          },
          solvers: [
            // AWS Route53 solver
            {
              dns01: {
                route53: {
                  region: 'us-east-1',
                  secretAccessKeySecretRef: {
                    name: 'aws-credentials',
                    key: 'secret-access-key'
                  }
                }
              },
              selector: {
                dnsZones: ['aws.example.com']
              }
            },
            // Cloudflare solver
            {
              dns01: {
                cloudflare: {
                  apiTokenSecretRef: {
                    name: 'cloudflare-api-token',
                    key: 'api-token'
                  }
                }
              },
              selector: {
                dnsZones: ['cloudflare.example.com']
              }
            },
            // Google Cloud DNS solver
            {
              dns01: {
                cloudDNS: {
                  project: 'my-gcp-project',
                  serviceAccountSecretRef: {
                    name: 'gcp-service-account',
                    key: 'service-account.json'
                  }
                }
              },
              selector: {
                dnsZones: ['gcp.example.com']
              }
            }
          ]
        }
      },
      id: 'letsEncryptDns01'
    });

    // Validate comprehensive ACME configurations
    expect(letsEncryptProd.spec.acme?.server).toBe('https://acme-v02.api.letsencrypt.org/directory');
    expect(letsEncryptProd.spec.acme?.solvers?.[0]?.http01?.ingress?.class).toBe('nginx');

    expect(letsEncryptDns01.spec.acme?.solvers).toHaveLength(3);
    expect(letsEncryptDns01.spec.acme?.solvers?.[0]?.dns01?.route53?.region).toBe('us-east-1');
    expect(letsEncryptDns01.spec.acme?.solvers?.[1]?.dns01?.cloudflare?.apiTokenSecretRef?.name).toBe('cloudflare-api-token');
    expect(letsEncryptDns01.spec.acme?.solvers?.[2]?.dns01?.cloudDNS?.project).toBe('my-gcp-project');

    console.log('✅ Comprehensive ACME solver configurations validated');
    console.log('📋 HTTP01 and DNS01 challenges with multiple providers supported');
  });

  it('should support all major issuer types for comprehensive certificate authority integration', async () => {
    // Test all supported issuer types to ensure comprehensive CA support
    const { clusterIssuer } = await import('../../../src/factories/cert-manager/resources/issuers.js');

    // Test Vault issuer with Kubernetes auth
    const vaultIssuer = clusterIssuer({
      name: 'vault-kubernetes-auth',
      spec: {
        vault: {
          server: 'https://vault.example.com',
          path: 'pki/sign/example-dot-com',
          auth: {
            kubernetes: {
              mountPath: '/v1/auth/kubernetes',
              role: 'cert-manager',
              secretRef: {
                name: 'vault-service-account',
                key: 'token'
              }
            }
          }
        }
      },
      id: 'vaultIssuer'
    });

    // Test Venafi TPP issuer
    const venafiTppIssuer = clusterIssuer({
      name: 'venafi-tpp',
      spec: {
        venafi: {
          zone: 'DevOps\\Certificates',
          tpp: {
            url: 'https://tpp.example.com/vedsdk',
            credentialsRef: {
              name: 'venafi-tpp-credentials'
            },
            caBundle: 'LS0tLS1CRUdJTi...' // Base64 encoded CA bundle
          }
        }
      },
      id: 'venafiTppIssuer'
    });

    // Test Venafi Cloud issuer
    const venafiCloudIssuer = clusterIssuer({
      name: 'venafi-cloud',
      spec: {
        venafi: {
          zone: 'Default',
          cloud: {
            apiTokenSecretRef: {
              name: 'venafi-cloud-token',
              key: 'api-token'
            }
          }
        }
      },
      id: 'venafiCloudIssuer'
    });

    // Test CA issuer with comprehensive configuration
    const caIssuer = clusterIssuer({
      name: 'ca-issuer-comprehensive',
      spec: {
        ca: {
          secretName: 'ca-key-pair',
          crlDistributionPoints: ['http://crl.example.com/ca.crl'],
          ocspServers: ['http://ocsp.example.com'],
          issuingCertificateURLs: ['http://ca.example.com/ca.crt']
        }
      },
      id: 'caIssuer'
    });

    // Validate all issuer types
    expect(vaultIssuer.spec.vault?.server).toBe('https://vault.example.com');
    expect(vaultIssuer.spec.vault?.auth.kubernetes?.role).toBe('cert-manager');

    expect(venafiTppIssuer.spec.venafi?.tpp?.url).toBe('https://tpp.example.com/vedsdk');
    expect(venafiTppIssuer.spec.venafi?.zone).toBe('DevOps\\Certificates');

    expect(venafiCloudIssuer.spec.venafi?.cloud?.apiTokenSecretRef?.name).toBe('venafi-cloud-token');

    expect(caIssuer.spec.ca?.secretName).toBe('ca-key-pair');
    expect(caIssuer.spec.ca?.crlDistributionPoints).toEqual(['http://crl.example.com/ca.crl']);

    console.log('✅ All major issuer types (ACME, CA, Vault, Venafi, self-signed) validated');
    console.log('📋 Comprehensive certificate authority integration supported');
  });

  it('should validate readiness evaluation with actual issuer registration status scenarios', async () => {
    // Test readiness evaluation with realistic ACME account registration scenarios
    const { clusterIssuer } = await import('../../../src/factories/cert-manager/resources/issuers.js');

    const testIssuer = clusterIssuer({
      name: 'readiness-test-acme',
      spec: {
        acme: {
          server: 'https://acme-staging-v02.api.letsencrypt.org/directory',
          email: 'test@example.com',
          privateKeySecretRef: {
            name: 'letsencrypt-staging'
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
      id: 'readinessTestIssuer'
    });

    expect(testIssuer.readinessEvaluator).toBeDefined();

    // Test ACME account registration success scenario
    const mockRegisteredIssuer = {
      apiVersion: 'cert-manager.io/v1',
      kind: 'ClusterIssuer',
      metadata: { name: 'test-acme-issuer' },
      spec: { acme: { server: 'https://acme-staging-v02.api.letsencrypt.org/directory' } },
      status: {
        conditions: [
          {
            type: 'Ready',
            status: 'True',
            reason: 'ACMEAccountRegistered',
            message: 'The ACME account was registered with the ACME server'
          }
        ],
        acme: {
          uri: 'https://acme-staging-v02.api.letsencrypt.org/acme/acct/12345',
          lastRegisteredEmail: 'test@example.com'
        }
      }
    };

    if (testIssuer.readinessEvaluator) {
      const registeredResult = testIssuer.readinessEvaluator(mockRegisteredIssuer);
      expect(registeredResult.ready).toBe(true);
      expect(registeredResult.message).toContain('ACME account was registered');
    }

    // Test ACME account registration failure scenario
    const mockFailedIssuer = {
      apiVersion: 'cert-manager.io/v1',
      kind: 'ClusterIssuer',
      metadata: { name: 'test-acme-issuer' },
      spec: { acme: { server: 'https://acme-staging-v02.api.letsencrypt.org/directory' } },
      status: {
        conditions: [
          {
            type: 'Ready',
            status: 'False',
            reason: 'ACMEAccountRegistrationFailed',
            message: 'Failed to register ACME account: invalid email address'
          }
        ]
      }
    };

    if (testIssuer.readinessEvaluator) {
      const failedResult = testIssuer.readinessEvaluator(mockFailedIssuer);
      expect(failedResult.ready).toBe(false);
      expect(failedResult.message).toContain('invalid email address');
      expect(failedResult.reason).toBe('ACMEAccountRegistrationFailed');
    }

    // Test issuer without status (initial state)
    const mockInitialIssuer = {
      apiVersion: 'cert-manager.io/v1',
      kind: 'ClusterIssuer',
      metadata: { name: 'test-acme-issuer' },
      spec: { acme: { server: 'https://acme-staging-v02.api.letsencrypt.org/directory' } }
      // No status field - initial state
    };

    if (testIssuer.readinessEvaluator) {
      const initialResult = testIssuer.readinessEvaluator(mockInitialIssuer);
      expect(initialResult.ready).toBe(false);
      expect(initialResult.message).toContain('status not available');
      expect(initialResult.reason).toBe('StatusMissing');
    }

    console.log('✅ Readiness evaluation with ACME account registration scenarios validated');
    console.log('📋 Handles success, failure, and initial states correctly');
  });
});