import { describe, it, expect } from 'bun:test';
import { challenge, order } from '../../../src/factories/cert-manager/resources/challenges.js';

describe('Cert-Manager Challenge and Order Factories', () => {
  describe('Challenge Factory', () => {
    it('should create a valid Challenge resource', () => {
      const testChallenge = challenge({
        name: 'test-challenge',
        namespace: 'default',
        spec: {
          url: 'https://acme-staging-v02.api.letsencrypt.org/acme/chall-v3/12345',
          authorizationURL: 'https://acme-staging-v02.api.letsencrypt.org/acme/authz-v3/12345',
          dnsName: 'test.funwiththe.cloud',
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

      expect(testChallenge.kind).toBe('Challenge');
      expect(testChallenge.apiVersion).toBe('acme.cert-manager.io/v1');
      expect(testChallenge.metadata?.name).toBe('test-challenge');
      expect(testChallenge.metadata?.namespace).toBe('default');
      expect(testChallenge.spec.dnsName).toBe('test.funwiththe.cloud');
      expect(testChallenge.spec.type).toBe('HTTP-01');
      expect(testChallenge.spec.token).toBe('test-token-12345');
      expect(testChallenge.spec.key).toBe('test-key-67890');
      expect(testChallenge.spec.issuerRef.name).toBe('test-issuer');
      expect(testChallenge.spec.issuerRef.kind).toBe('ClusterIssuer');
      expect(testChallenge.spec.issuerRef.group).toBe('cert-manager.io');
      expect(testChallenge.readinessEvaluator).toBeDefined();
    });

    it('should have working readiness evaluator', () => {
      const testChallenge = challenge({
        name: 'test-challenge',
        namespace: 'default',
        spec: {
          url: 'https://acme-staging-v02.api.letsencrypt.org/acme/chall-v3/12345',
          authorizationURL: 'https://acme-staging-v02.api.letsencrypt.org/acme/authz-v3/12345',
          dnsName: 'test.funwiththe.cloud',
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

      expect(testChallenge.readinessEvaluator).toBeDefined();

      // Test successful challenge
      const mockValidChallenge = {
        status: {
          processing: false,
          presented: true,
          state: 'valid'
        }
      };

      if (testChallenge.readinessEvaluator) {
        const result = testChallenge.readinessEvaluator(mockValidChallenge);
        expect(result.ready).toBe(true);
        expect(result.message).toContain('Challenge completed successfully');
      }

      // Test failed challenge
      const mockFailedChallenge = {
        status: {
          processing: false,
          presented: false,
          state: 'invalid',
          reason: 'Connection refused'
        }
      };

      if (testChallenge.readinessEvaluator) {
        const result = testChallenge.readinessEvaluator(mockFailedChallenge);
        expect(result.ready).toBe(false);
        expect(result.message).toContain('Connection refused');
        expect(result.reason).toBe('ChallengeFailed');
      }
    });
  });

  describe('Order Factory', () => {
    it('should create a valid Order resource', () => {
      const sampleCSR = Buffer.from('-----BEGIN CERTIFICATE REQUEST-----\nMIICWjCCAUICAQAwFTETMBEGA1UEAwwKdGVzdC5sb2NhbDCCASIwDQYJKoZIhvcN\n-----END CERTIFICATE REQUEST-----').toString('base64');

      const testOrder = order({
        name: 'test-order',
        namespace: 'default',
        spec: {
          request: sampleCSR,
          issuerRef: {
            name: 'test-issuer',
            kind: 'ClusterIssuer'
          },
          commonName: 'test.funwiththe.cloud',
          dnsNames: ['test.funwiththe.cloud', 'api.test.funwiththe.cloud'],
          duration: '2160h'
        },
        id: 'testOrder'
      });

      expect(testOrder.kind).toBe('Order');
      expect(testOrder.apiVersion).toBe('acme.cert-manager.io/v1');
      expect(testOrder.metadata?.name).toBe('test-order');
      expect(testOrder.metadata?.namespace).toBe('default');
      expect(testOrder.spec.request).toBe(sampleCSR);
      expect(testOrder.spec.commonName).toBe('test.funwiththe.cloud');
      expect(testOrder.spec.dnsNames).toEqual(['test.funwiththe.cloud', 'api.test.funwiththe.cloud']);
      expect(testOrder.spec.issuerRef.name).toBe('test-issuer');
      expect(testOrder.spec.issuerRef.kind).toBe('ClusterIssuer');
      expect(testOrder.spec.issuerRef.group).toBe('cert-manager.io');
      expect(testOrder.readinessEvaluator).toBeDefined();
    });

    it('should have working readiness evaluator', () => {
      const sampleCSR = Buffer.from('-----BEGIN CERTIFICATE REQUEST-----\nMIICWjCCAUICAQAwFTETMBEGA1UEAwwKdGVzdC5sb2NhbDCCASIwDQYJKoZIhvcN\n-----END CERTIFICATE REQUEST-----').toString('base64');

      const testOrder = order({
        name: 'test-order',
        namespace: 'default',
        spec: {
          request: sampleCSR,
          issuerRef: {
            name: 'test-issuer',
            kind: 'ClusterIssuer'
          },
          commonName: 'test.funwiththe.cloud',
          dnsNames: ['test.funwiththe.cloud']
        },
        id: 'testOrder'
      });

      expect(testOrder.readinessEvaluator).toBeDefined();

      // Test successful order with certificate
      const mockValidOrder = {
        status: {
          state: 'valid',
          certificate: 'LS0tLS1CRUdJTi...' // Base64 encoded certificate
        }
      };

      if (testOrder.readinessEvaluator) {
        const result = testOrder.readinessEvaluator(mockValidOrder);
        expect(result.ready).toBe(true);
        expect(result.message).toContain('Order completed successfully and certificate issued');
      }

      // Test valid order without certificate yet
      const mockValidNoCertOrder = {
        status: {
          state: 'valid'
          // No certificate field
        }
      };

      if (testOrder.readinessEvaluator) {
        const result = testOrder.readinessEvaluator(mockValidNoCertOrder);
        expect(result.ready).toBe(false);
        expect(result.message).toContain('Order is valid but certificate not yet available');
        expect(result.reason).toBe('CertificatePending');
      }

      // Test failed order
      const mockFailedOrder = {
        status: {
          state: 'invalid',
          reason: 'Authorization failed'
        }
      };

      if (testOrder.readinessEvaluator) {
        const result = testOrder.readinessEvaluator(mockFailedOrder);
        expect(result.ready).toBe(false);
        expect(result.message).toContain('Authorization failed');
        expect(result.reason).toBe('OrderFailed');
      }
    });
  });
});