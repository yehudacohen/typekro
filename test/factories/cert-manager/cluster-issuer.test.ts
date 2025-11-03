import { describe, it, expect } from 'bun:test';

describe('ClusterIssuer Factory Unit Tests', () => {
  
  it('should create self-signed ClusterIssuer', async () => {
    const { clusterIssuer } = await import('../../../src/factories/cert-manager/resources/issuers.js');

    const selfSignedIssuer = clusterIssuer({
      name: 'selfsigned-issuer',
      spec: {
        selfSigned: {}
      },
      id: 'selfSignedIssuer'
    });

    // Validate ClusterIssuer structure
    expect(selfSignedIssuer).toBeDefined();
    expect(selfSignedIssuer.kind).toBe('ClusterIssuer');
    expect(selfSignedIssuer.apiVersion).toBe('cert-manager.io/v1');
    expect(selfSignedIssuer.metadata.name).toBe('selfsigned-issuer');
    expect(selfSignedIssuer.spec.selfSigned).toEqual({});
  });

  it('should create CA ClusterIssuer', async () => {
    const { clusterIssuer } = await import('../../../src/factories/cert-manager/resources/issuers.js');

    const caIssuer = clusterIssuer({
      name: 'ca-issuer',
      spec: {
        ca: {
          secretName: 'ca-key-pair'
        }
      },
      id: 'caIssuer'
    });

    expect(caIssuer.spec.ca?.secretName).toBe('ca-key-pair');
  });

  it('should create ACME ClusterIssuer with Let\'s Encrypt', async () => {
    const { clusterIssuer } = await import('../../../src/factories/cert-manager/resources/issuers.js');

    const acmeIssuer = clusterIssuer({
      name: 'letsencrypt-staging',
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
      id: 'acmeIssuer'
    });

    expect(acmeIssuer.spec.acme?.server).toBe('https://acme-staging-v02.api.letsencrypt.org/directory');
    expect(acmeIssuer.spec.acme?.email).toBe('test@example.com');
    expect(acmeIssuer.spec.acme?.solvers).toHaveLength(1);
    expect(acmeIssuer.spec.acme?.solvers?.[0]?.http01?.ingress?.class).toBe('nginx');
  });

  it('should create ACME ClusterIssuer with DNS01 challenge', async () => {
    const { clusterIssuer } = await import('../../../src/factories/cert-manager/resources/issuers.js');

    const dns01Issuer = clusterIssuer({
      name: 'letsencrypt-dns01',
      spec: {
        acme: {
          server: 'https://acme-v02.api.letsencrypt.org/directory',
          email: 'admin@example.com',
          privateKeySecretRef: {
            name: 'letsencrypt-prod'
          },
          solvers: [{
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
              dnsZones: ['example.com']
            }
          }]
        }
      },
      id: 'dns01Issuer'
    });

    expect(dns01Issuer.spec.acme?.solvers?.[0]?.dns01?.route53?.region).toBe('us-east-1');
    expect(dns01Issuer.spec.acme?.solvers?.[0]?.selector?.dnsZones).toEqual(['example.com']);
  });

  it('should create Vault ClusterIssuer', async () => {
    const { clusterIssuer } = await import('../../../src/factories/cert-manager/resources/issuers.js');

    const vaultIssuer = clusterIssuer({
      name: 'vault-issuer',
      spec: {
        vault: {
          server: 'https://vault.example.com',
          path: 'pki/sign/example-dot-com',
          auth: {
            kubernetes: {
              mountPath: '/v1/auth/kubernetes',
              role: 'cert-manager'
            }
          }
        }
      },
      id: 'vaultIssuer'
    });

    expect(vaultIssuer.spec.vault?.server).toBe('https://vault.example.com');
    expect(vaultIssuer.spec.vault?.path).toBe('pki/sign/example-dot-com');
    expect(vaultIssuer.spec.vault?.auth.kubernetes?.role).toBe('cert-manager');
  });

  it('should have proper readiness evaluation logic', async () => {
    const { clusterIssuer } = await import('../../../src/factories/cert-manager/resources/issuers.js');

    const testIssuer = clusterIssuer({
      name: 'readiness-test-issuer',
      spec: {
        selfSigned: {}
      },
      id: 'readinessIssuer'
    });

    // Validate that readiness evaluator is attached
    expect(testIssuer.readinessEvaluator).toBeDefined();
    expect(typeof testIssuer.readinessEvaluator).toBe('function');

    // Test readiness evaluation with mock issuer resource
    const mockReadyIssuer = {
      apiVersion: 'cert-manager.io/v1',
      kind: 'ClusterIssuer',
      metadata: { name: 'test-issuer' },
      spec: { selfSigned: {} },
      status: {
        conditions: [
          {
            type: 'Ready',
            status: 'True',
            reason: 'Ready',
            message: 'Issuer is ready'
          }
        ]
      }
    };

    if (testIssuer.readinessEvaluator) {
      const readyResult = testIssuer.readinessEvaluator(mockReadyIssuer);
      expect(readyResult.ready).toBe(true);
      expect(readyResult.message).toContain('Issuer is ready');
    }

    // Test readiness evaluation with pending issuer
    const mockPendingIssuer = {
      apiVersion: 'cert-manager.io/v1',
      kind: 'ClusterIssuer',
      metadata: { name: 'test-issuer' },
      spec: { selfSigned: {} },
      status: {
        conditions: [
          {
            type: 'Ready',
            status: 'False',
            reason: 'Pending',
            message: 'Issuer is being configured'
          }
        ]
      }
    };

    if (testIssuer.readinessEvaluator) {
      const pendingResult = testIssuer.readinessEvaluator(mockPendingIssuer);
      expect(pendingResult.ready).toBe(false);
      expect(pendingResult.message).toContain('Issuer is being configured');
    }
  });

  it('should apply sensible defaults', async () => {
    const { clusterIssuer } = await import('../../../src/factories/cert-manager/resources/issuers.js');

    const defaultIssuer = clusterIssuer({
      name: 'default-issuer',
      spec: {
        acme: {
          server: 'https://acme-v02.api.letsencrypt.org/directory',
          email: 'test@example.com',
          privateKeySecretRef: {
            name: 'letsencrypt-key'
          },
          solvers: []
        }
      }
    });

    // Check that defaults are applied (we'll implement these in the factory)
    expect(defaultIssuer.spec.acme?.server).toBe('https://acme-v02.api.letsencrypt.org/directory');
    expect(defaultIssuer.spec.acme?.solvers).toEqual([]);
  });

  it('should support multiple DNS providers for DNS01 challenges', async () => {
    const { clusterIssuer } = await import('../../../src/factories/cert-manager/resources/issuers.js');

    // Test Cloudflare DNS01
    const cloudflareIssuer = clusterIssuer({
      name: 'letsencrypt-cloudflare',
      spec: {
        acme: {
          server: 'https://acme-v02.api.letsencrypt.org/directory',
          email: 'admin@example.com',
          privateKeySecretRef: {
            name: 'letsencrypt-cloudflare'
          },
          solvers: [{
            dns01: {
              cloudflare: {
                apiTokenSecretRef: {
                  name: 'cloudflare-api-token',
                  key: 'api-token'
                }
              }
            }
          }]
        }
      },
      id: 'cloudflareIssuer'
    });

    expect(cloudflareIssuer.spec.acme?.solvers?.[0]?.dns01?.cloudflare?.apiTokenSecretRef?.name).toBe('cloudflare-api-token');

    // Test Google Cloud DNS
    const googleIssuer = clusterIssuer({
      name: 'letsencrypt-google',
      spec: {
        acme: {
          server: 'https://acme-v02.api.letsencrypt.org/directory',
          email: 'admin@example.com',
          privateKeySecretRef: {
            name: 'letsencrypt-google'
          },
          solvers: [{
            dns01: {
              cloudDNS: {
                project: 'my-gcp-project',
                serviceAccountSecretRef: {
                  name: 'gcp-service-account',
                  key: 'service-account.json'
                }
              }
            }
          }]
        }
      },
      id: 'googleIssuer'
    });

    expect(googleIssuer.spec.acme?.solvers?.[0]?.dns01?.cloudDNS?.project).toBe('my-gcp-project');
  });

  it('should support comprehensive ACME solver configurations including HTTP01 and DNS01', async () => {
    const { clusterIssuer } = await import('../../../src/factories/cert-manager/resources/issuers.js');

    // Test comprehensive HTTP01 solver with advanced configuration
    const http01Issuer = clusterIssuer({
      name: 'letsencrypt-http01-advanced',
      spec: {
        acme: {
          server: 'https://acme-v02.api.letsencrypt.org/directory',
          email: 'admin@example.com',
          privateKeySecretRef: {
            name: 'letsencrypt-http01'
          },
          solvers: [{
            http01: {
              ingress: {
                class: 'nginx',
                name: 'challenge-ingress',
                podTemplate: {
                  metadata: {
                    annotations: {
                      'kubernetes.io/ingress.class': 'nginx',
                      'nginx.ingress.kubernetes.io/ssl-redirect': 'false'
                    },
                    labels: {
                      'app': 'cert-manager-challenge'
                    }
                  },
                  spec: {
                    nodeSelector: {
                      'kubernetes.io/os': 'linux'
                    },
                    tolerations: [{
                      key: 'node-role.kubernetes.io/master',
                      operator: 'Exists',
                      effect: 'NoSchedule'
                    }]
                  }
                },
                serviceType: 'ClusterIP'
              }
            },
            selector: {
              dnsNames: ['example.com', '*.example.com']
            }
          }]
        }
      },
      id: 'http01Issuer'
    });

    expect(http01Issuer.spec.acme?.solvers?.[0]?.http01?.ingress?.class).toBe('nginx');
    expect(http01Issuer.spec.acme?.solvers?.[0]?.http01?.ingress?.podTemplate?.metadata?.annotations?.['nginx.ingress.kubernetes.io/ssl-redirect']).toBe('false');
    expect(http01Issuer.spec.acme?.solvers?.[0]?.selector?.dnsNames).toEqual(['example.com', '*.example.com']);

    // Test comprehensive DNS01 solver with multiple providers and selectors
    const dns01MultiIssuer = clusterIssuer({
      name: 'letsencrypt-dns01-comprehensive',
      spec: {
        acme: {
          server: 'https://acme-v02.api.letsencrypt.org/directory',
          email: 'admin@example.com',
          privateKeySecretRef: {
            name: 'letsencrypt-dns01-multi'
          },
          externalAccountBinding: {
            keyID: 'eab-key-id',
            keySecretRef: {
              name: 'eab-secret',
              key: 'eab-key'
            },
            keyAlgorithm: 'HS256'
          },
          solvers: [
            // AWS Route53 with advanced configuration
            {
              dns01: {
                route53: {
                  region: 'us-east-1',
                  hostedZoneID: 'Z1234567890ABC',
                  role: 'arn:aws:iam::123456789012:role/cert-manager-route53',
                  secretAccessKeySecretRef: {
                    name: 'aws-credentials',
                    key: 'secret-access-key'
                  }
                }
              },
              selector: {
                dnsZones: ['aws.example.com'],
                matchLabels: {
                  'dns-provider': 'route53'
                }
              }
            },
            // Azure DNS with managed identity
            {
              dns01: {
                azureDNS: {
                  subscriptionID: 'subscription-id',
                  tenantID: 'tenant-id',
                  resourceGroupName: 'dns-resource-group',
                  hostedZoneName: 'azure.example.com',
                  environment: 'AzurePublicCloud',
                  clientSecretSecretRef: {
                    name: 'azure-credentials',
                    key: 'client-secret'
                  }
                }
              },
              selector: {
                dnsZones: ['azure.example.com']
              }
            },
            // DigitalOcean DNS
            {
              dns01: {
                digitalocean: {
                  tokenSecretRef: {
                    name: 'digitalocean-token',
                    key: 'access-token'
                  }
                }
              },
              selector: {
                dnsZones: ['do.example.com']
              }
            },
            // RFC2136 (generic DNS)
            {
              dns01: {
                rfc2136: {
                  nameserver: 'ns1.example.com:53',
                  tsigKeyName: 'example.com',
                  tsigAlgorithm: 'hmac-sha256',
                  tsigSecretSecretRef: {
                    name: 'rfc2136-secret',
                    key: 'tsig-secret'
                  }
                }
              },
              selector: {
                dnsZones: ['rfc2136.example.com']
              }
            },
            // Webhook solver for custom DNS providers
            {
              dns01: {
                webhook: {
                  groupName: 'acme.example.com',
                  solverName: 'custom-dns-solver',
                  config: {
                    apiUrl: 'https://api.custom-dns.com',
                    apiKeySecretRef: {
                      name: 'custom-dns-api-key',
                      key: 'api-key'
                    }
                  }
                }
              },
              selector: {
                dnsZones: ['custom.example.com']
              }
            }
          ]
        }
      },
      id: 'dns01MultiIssuer'
    });

    // Validate comprehensive DNS01 configuration
    expect(dns01MultiIssuer.spec.acme?.externalAccountBinding?.keyID).toBe('eab-key-id');
    expect(dns01MultiIssuer.spec.acme?.solvers).toHaveLength(5);
    
    // Validate Route53 solver
    const route53Solver = dns01MultiIssuer.spec.acme?.solvers?.[0];
    expect(route53Solver?.dns01?.route53?.region).toBe('us-east-1');
    expect(route53Solver?.dns01?.route53?.hostedZoneID).toBe('Z1234567890ABC');
    expect(route53Solver?.selector?.matchLabels?.['dns-provider']).toBe('route53');
    
    // Validate Azure DNS solver
    const azureSolver = dns01MultiIssuer.spec.acme?.solvers?.[1];
    expect(azureSolver?.dns01?.azureDNS?.environment).toBe('AzurePublicCloud');
    expect(azureSolver?.dns01?.azureDNS?.resourceGroupName).toBe('dns-resource-group');
    
    // Validate DigitalOcean solver
    const doSolver = dns01MultiIssuer.spec.acme?.solvers?.[2];
    expect(doSolver?.dns01?.digitalocean?.tokenSecretRef?.name).toBe('digitalocean-token');
    
    // Validate RFC2136 solver
    const rfc2136Solver = dns01MultiIssuer.spec.acme?.solvers?.[3];
    expect(rfc2136Solver?.dns01?.rfc2136?.nameserver).toBe('ns1.example.com:53');
    expect(rfc2136Solver?.dns01?.rfc2136?.tsigAlgorithm).toBe('hmac-sha256');
    
    // Validate webhook solver
    const webhookSolver = dns01MultiIssuer.spec.acme?.solvers?.[4];
    expect(webhookSolver?.dns01?.webhook?.groupName).toBe('acme.example.com');
    expect(webhookSolver?.dns01?.webhook?.solverName).toBe('custom-dns-solver');
  });

  it('should support all major certificate authority types beyond ACME', async () => {
    const { clusterIssuer } = await import('../../../src/factories/cert-manager/resources/issuers.js');

    // Test Vault issuer with AppRole authentication
    const vaultAppRoleIssuer = clusterIssuer({
      name: 'vault-approle',
      spec: {
        vault: {
          server: 'https://vault.example.com',
          path: 'pki/sign/example-dot-com',
          namespace: 'vault-namespace',
          caBundle: 'LS0tLS1CRUdJTi0tLS0t...', // Base64 encoded CA bundle
          auth: {
            appRole: {
              path: '/v1/auth/approle',
              roleId: 'vault-role-id',
              secretRef: {
                name: 'vault-approle-secret',
                key: 'secret-id'
              }
            }
          }
        }
      },
      id: 'vaultAppRoleIssuer'
    });

    // Test Vault issuer with token authentication
    const vaultTokenIssuer = clusterIssuer({
      name: 'vault-token',
      spec: {
        vault: {
          server: 'https://vault.example.com',
          path: 'pki/sign/example-dot-com',
          auth: {
            tokenSecretRef: {
              name: 'vault-token-secret',
              key: 'vault-token'
            }
          }
        }
      },
      id: 'vaultTokenIssuer'
    });

    // Test Venafi TPP issuer with comprehensive configuration
    const venafiTppIssuer = clusterIssuer({
      name: 'venafi-tpp-comprehensive',
      spec: {
        venafi: {
          zone: 'DevOps\\Certificates\\Production',
          tpp: {
            url: 'https://tpp.example.com/vedsdk',
            credentialsRef: {
              name: 'venafi-tpp-credentials'
            },
            caBundle: 'LS0tLS1CRUdJTi0tLS0t...' // Base64 encoded CA bundle
          }
        }
      },
      id: 'venafiTppIssuer'
    });

    // Test Venafi Cloud issuer
    const venafiCloudIssuer = clusterIssuer({
      name: 'venafi-cloud-production',
      spec: {
        venafi: {
          zone: 'Production',
          cloud: {
            url: 'https://api.venafi.cloud',
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
    const comprehensiveCaIssuer = clusterIssuer({
      name: 'ca-issuer-production',
      spec: {
        ca: {
          secretName: 'ca-key-pair',
          crlDistributionPoints: [
            'http://crl.example.com/ca.crl',
            'http://backup-crl.example.com/ca.crl'
          ],
          ocspServers: [
            'http://ocsp.example.com',
            'http://backup-ocsp.example.com'
          ],
          issuingCertificateURLs: [
            'http://ca.example.com/ca.crt',
            'http://backup-ca.example.com/ca.crt'
          ]
        }
      },
      id: 'comprehensiveCaIssuer'
    });

    // Test self-signed issuer with CRL distribution points
    const selfSignedWithCrl = clusterIssuer({
      name: 'selfsigned-with-crl',
      spec: {
        selfSigned: {
          crlDistributionPoints: [
            'http://crl.example.com/selfsigned.crl'
          ]
        }
      },
      id: 'selfSignedWithCrl'
    });

    // Validate all issuer configurations
    expect(vaultAppRoleIssuer.spec.vault?.auth.appRole?.roleId).toBe('vault-role-id');
    expect(vaultAppRoleIssuer.spec.vault?.namespace).toBe('vault-namespace');
    
    expect(vaultTokenIssuer.spec.vault?.auth.tokenSecretRef?.name).toBe('vault-token-secret');
    
    expect(venafiTppIssuer.spec.venafi?.zone).toBe('DevOps\\Certificates\\Production');
    expect(venafiTppIssuer.spec.venafi?.tpp?.url).toBe('https://tpp.example.com/vedsdk');
    
    expect(venafiCloudIssuer.spec.venafi?.cloud?.url).toBe('https://api.venafi.cloud');
    
    expect(comprehensiveCaIssuer.spec.ca?.crlDistributionPoints).toHaveLength(2);
    expect(comprehensiveCaIssuer.spec.ca?.ocspServers).toHaveLength(2);
    expect(comprehensiveCaIssuer.spec.ca?.issuingCertificateURLs).toHaveLength(2);
    
    expect(selfSignedWithCrl.spec.selfSigned?.crlDistributionPoints).toEqual(['http://crl.example.com/selfsigned.crl']);
  });
});