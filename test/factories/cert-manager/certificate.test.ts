import { describe, it, expect } from 'bun:test';
import { certificate } from '../../../src/factories/cert-manager/resources/certificates.js';

describe('Certificate Factory Unit Tests', () => {
  
  it('should create Certificate resource with comprehensive configuration', () => {
    const testCert = certificate({
      name: 'test-certificate',
      namespace: 'default',
      spec: {
        secretName: 'test-certificate-tls',
        dnsNames: ['test.example.com', 'api.test.example.com'],
        issuerRef: {
          name: 'letsencrypt-staging',
          kind: 'ClusterIssuer',
          group: 'cert-manager.io'
        }
      },
      id: 'testCertificate'
    });

    // Validate certificate structure
    expect(testCert).toBeDefined();
    expect(testCert.kind).toBe('Certificate');
    expect(testCert.apiVersion).toBe('cert-manager.io/v1');
    expect(testCert.metadata.name).toBe('test-certificate');
    expect(testCert.metadata.namespace).toBe('default');
    expect(testCert.spec.secretName).toBe('test-certificate-tls');
    expect(testCert.spec.dnsNames).toEqual(['test.example.com', 'api.test.example.com']);
    expect(testCert.spec.issuerRef.name).toBe('letsencrypt-staging');
    expect(testCert.spec.issuerRef.kind).toBe('ClusterIssuer');
  });

  it('should support different certificate types and configurations', () => {
    // Test TLS certificate
    const tlsCert = certificate({
      name: 'tls-certificate',
      namespace: 'default',
      spec: {
        secretName: 'tls-certificate-secret',
        dnsNames: ['tls.example.com'],
        issuerRef: {
          name: 'ca-issuer',
          kind: 'Issuer'
        },
        usages: ['digital signature', 'key encipherment']
      },
      id: 'tlsCert'
    });

    expect(tlsCert.spec.usages).toEqual(['digital signature', 'key encipherment']);

    // Test client authentication certificate
    const clientCert = certificate({
      name: 'client-certificate',
      namespace: 'default',
      spec: {
        secretName: 'client-certificate-secret',
        commonName: 'client.example.com',
        issuerRef: {
          name: 'ca-issuer',
          kind: 'Issuer'
        },
        usages: ['digital signature', 'client auth']
      },
      id: 'clientCert'
    });

    expect(clientCert.spec.commonName).toBe('client.example.com');
    expect(clientCert.spec.usages).toEqual(['digital signature', 'client auth']);
  });

  it('should support ACME challenges and DNS01 configuration', () => {
    // Test certificate with DNS01 challenge configuration
    const dns01Cert = certificate({
      name: 'dns01-certificate',
      namespace: 'default',
      spec: {
        secretName: 'dns01-certificate-secret',
        dnsNames: ['dns01.example.com', '*.dns01.example.com'],
        issuerRef: {
          name: 'letsencrypt-dns01',
          kind: 'ClusterIssuer'
        }
      },
      id: 'dns01Cert'
    });

    expect(dns01Cert.spec.dnsNames).toContain('*.dns01.example.com');
    expect(dns01Cert.spec.issuerRef.name).toBe('letsencrypt-dns01');
  });

  it('should have proper readiness evaluation logic', () => {
    const testCert = certificate({
      name: 'readiness-test-certificate',
      namespace: 'default',
      spec: {
        secretName: 'readiness-test-secret',
        dnsNames: ['readiness.example.com'],
        issuerRef: {
          name: 'test-issuer',
          kind: 'Issuer'
        }
      },
      id: 'readinessCert'
    });

    // Validate that readiness evaluator is attached
    expect(testCert.readinessEvaluator).toBeDefined();
    expect(typeof testCert.readinessEvaluator).toBe('function');

    // Test readiness evaluation with mock certificate resource (entire resource, not just status)
    const mockReadyCertificate = {
      apiVersion: 'cert-manager.io/v1',
      kind: 'Certificate',
      metadata: { name: 'test-cert', namespace: 'default' },
      spec: { secretName: 'test-secret', issuerRef: { name: 'test-issuer', kind: 'Issuer' } },
      status: {
        conditions: [
          {
            type: 'Ready',
            status: 'True',
            reason: 'Ready',
            message: 'Certificate is up to date and has not expired'
          }
        ]
      }
    };

    if (testCert.readinessEvaluator) {
      const readyResult = testCert.readinessEvaluator(mockReadyCertificate);
      expect(readyResult.ready).toBe(true);
      expect(readyResult.message).toContain('Certificate is up to date and has not expired');
    }

    // Test readiness evaluation with pending certificate resource
    const mockPendingCertificate = {
      apiVersion: 'cert-manager.io/v1',
      kind: 'Certificate',
      metadata: { name: 'test-cert', namespace: 'default' },
      spec: { secretName: 'test-secret', issuerRef: { name: 'test-issuer', kind: 'Issuer' } },
      status: {
        conditions: [
          {
            type: 'Issuing',
            status: 'True',
            reason: 'Issuing',
            message: 'Issuing certificate as Secret does not exist'
          }
        ]
      }
    };

    if (testCert.readinessEvaluator) {
      const pendingResult = testCert.readinessEvaluator(mockPendingCertificate);
      expect(pendingResult.ready).toBe(false);
      expect(pendingResult.message).toContain('Issuing certificate as Secret does not exist');
    }
  });

  it('should validate certificate renewal and lifecycle configuration', () => {
    // Test certificate with renewal configuration
    const renewalCert = certificate({
      name: 'renewal-certificate',
      namespace: 'default',
      spec: {
        secretName: 'renewal-certificate-secret',
        dnsNames: ['renewal.example.com'],
        issuerRef: {
          name: 'letsencrypt-staging',
          kind: 'ClusterIssuer'
        },
        duration: '2160h', // 90 days
        renewBefore: '360h' // 15 days before expiry
      },
      id: 'renewalCert'
    });

    expect(renewalCert.spec.duration).toBe('2160h');
    expect(renewalCert.spec.renewBefore).toBe('360h');
  });

  it('should support certificate templates and advanced configuration', () => {
    // Test certificate with advanced configuration
    const advancedCert = certificate({
      name: 'advanced-certificate',
      namespace: 'default',
      spec: {
        secretName: 'advanced-certificate-secret',
        dnsNames: ['advanced.example.com'],
        ipAddresses: ['192.168.1.100'],
        uris: ['https://advanced.example.com'],
        emailAddresses: ['admin@example.com'],
        issuerRef: {
          name: 'advanced-issuer',
          kind: 'ClusterIssuer'
        },
        keystores: {
          jks: {
            create: true,
            passwordSecretRef: {
              name: 'jks-password-secret',
              key: 'password'
            }
          }
        }
      },
      id: 'advancedCert'
    });

    expect(advancedCert.spec.ipAddresses).toEqual(['192.168.1.100']);
    expect(advancedCert.spec.uris).toEqual(['https://advanced.example.com']);
    expect(advancedCert.spec.emailAddresses).toEqual(['admin@example.com']);
    expect(advancedCert.spec.keystores?.jks?.create).toBe(true);
  });

  it('should apply sensible defaults', () => {
    const defaultCert = certificate({
      name: 'default-certificate',
      spec: {
        secretName: 'default-secret',
        issuerRef: {
          name: 'test-issuer',
          kind: 'Issuer'
        }
      }
    });

    // Check that defaults are applied
    expect(defaultCert.spec.issuerRef.group).toBe('cert-manager.io');
    expect(defaultCert.spec.privateKey?.algorithm).toBe('RSA');
    expect(defaultCert.spec.privateKey?.size).toBe(2048);
    expect(defaultCert.spec.duration).toBe('2160h'); // 90 days
    expect(defaultCert.spec.renewBefore).toBe('720h'); // 30 days
  });
});