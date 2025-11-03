# Cert-Manager Testing Guide

This document explains the testing strategy for cert-manager integration in TypeKro and how to test real certificate issuance scenarios.

## Testing Levels

### 1. Unit Tests (`test/factories/cert-manager/`)
**Purpose**: Fast feedback for factory logic and configuration
**What they test**:
- Factory function behavior and defaults
- Configuration validation and type safety
- Readiness evaluator logic with mocked data
- TypeScript type checking and IDE experience

**Example**:
```bash
bun test test/factories/cert-manager/certificate.test.ts
```

**Characteristics**:
- ✅ Fast (< 1 second)
- ✅ No external dependencies
- ✅ Reliable and deterministic
- ✅ Great for TDD and development

### 2. Integration Tests (`test/integration/cert-manager/`)
**Purpose**: Validate TypeKro integration and Kubernetes deployment
**What they test**:
- Resource serialization and YAML generation
- TypeKro composition and factory patterns
- Kubernetes API integration (resource creation)
- Bootstrap composition deployment

**Example**:
```bash
bun test test/integration/cert-manager/bootstrap-composition.test.ts
bun test test/integration/cert-manager/certificate.test.ts
```

**Characteristics**:
- ✅ Test real Kubernetes deployment
- ✅ Validate TypeKro features work end-to-end
- ⚠️ Don't test actual certificate issuance (requires complex setup)
- ⚠️ Require running Kubernetes cluster

### 3. End-to-End Certificate Testing (Manual/Optional)
**Purpose**: Validate real certificate issuance and lifecycle
**What they test**:
- Actual certificate issuance with real CAs
- DNS01 and HTTP01 challenge completion
- Certificate renewal and lifecycle management
- Integration with real DNS providers

## Real Certificate Testing Setup

For testing actual certificate issuance, you need:

### Prerequisites
1. **Cert-manager deployed**: Use the bootstrap composition
2. **Working issuer**: Self-signed, ACME, or CA issuer
3. **DNS provider** (for DNS01): Route53, Cloudflare, etc.
4. **Ingress controller** (for HTTP01): nginx, traefik, etc.

### Example: Self-Signed Certificate Testing

```typescript
import { certManagerBootstrap } from 'typekro/cert-manager';
import { certificate, clusterIssuer } from 'typekro/cert-manager';

// 1. Deploy cert-manager
const certManagerFactory = certManagerBootstrap.factory('direct', {
  namespace: 'cert-manager-system',
  waitForReady: true
});

await certManagerFactory.deploy({
  name: 'cert-manager',
  namespace: 'cert-manager',
  version: '1.13.3',
  installCRDs: true
});

// 2. Create self-signed issuer
const selfSignedIssuer = clusterIssuer({
  name: 'selfsigned-issuer',
  spec: {
    selfSigned: {}
  }
});

// 3. Create certificate
const testCert = certificate({
  name: 'test-certificate',
  namespace: 'default',
  spec: {
    secretName: 'test-certificate-tls',
    commonName: 'test.example.com',
    issuerRef: {
      name: 'selfsigned-issuer',
      kind: 'ClusterIssuer'
    }
  }
});

// Deploy and wait for certificate issuance
// The certificate should become ready within 1-2 minutes
```

### Example: Let's Encrypt Staging with DNS01

```typescript
// 1. Create ACME issuer with DNS01 challenge
const letsEncryptIssuer = clusterIssuer({
  name: 'letsencrypt-staging',
  spec: {
    acme: {
      server: 'https://acme-staging-v02.api.letsencrypt.org/directory',
      email: 'your-email@example.com',
      privateKeySecretRef: {
        name: 'letsencrypt-staging'
      },
      solvers: [{
        dns01: {
          route53: {
            region: 'us-east-1',
            // Credentials should be in a Kubernetes secret
            secretAccessKeySecretRef: {
              name: 'aws-credentials',
              key: 'secret-access-key'
            }
          }
        }
      }]
    }
  }
});

// 2. Create certificate with DNS01 challenge
const dnsCert = certificate({
  name: 'dns-certificate',
  namespace: 'default',
  spec: {
    secretName: 'dns-certificate-tls',
    dnsNames: ['*.example.com', 'example.com'],
    issuerRef: {
      name: 'letsencrypt-staging',
      kind: 'ClusterIssuer'
    }
  }
});
```

## Testing Best Practices

### For Development
1. **Start with unit tests** - Fast feedback for factory logic
2. **Use integration tests** - Validate TypeKro features work
3. **Manual testing for certificates** - Test real issuance scenarios

### For CI/CD
1. **Always run unit tests** - Fast and reliable
2. **Run integration tests** - Validate Kubernetes deployment
3. **Skip certificate issuance tests** - Too complex for CI (unless you have dedicated infrastructure)

### For Production Validation
1. **Test with staging environments** - Use Let's Encrypt staging
2. **Validate DNS providers** - Test with your actual DNS setup
3. **Test certificate renewal** - Ensure automatic renewal works
4. **Monitor certificate expiry** - Set up alerts for certificate lifecycle

## Common Testing Scenarios

### Self-Signed Certificates (Easiest)
- ✅ No external dependencies
- ✅ Fast certificate issuance
- ✅ Good for development and testing
- ❌ Not trusted by browsers/clients

### Let's Encrypt Staging (Recommended for Testing)
- ✅ Real ACME protocol testing
- ✅ No rate limits
- ✅ Tests DNS01/HTTP01 challenges
- ❌ Certificates not trusted (staging CA)

### Let's Encrypt Production (Production Only)
- ✅ Trusted certificates
- ✅ Real-world validation
- ⚠️ Rate limits apply
- ⚠️ Should only be used in production

### Private CA (Enterprise)
- ✅ Full control over certificate lifecycle
- ✅ Custom certificate policies
- ✅ No external dependencies
- ❌ Requires CA infrastructure setup

## Troubleshooting Certificate Issues

### Certificate Stuck in "Issuing" State
1. Check issuer status: `kubectl describe clusterissuer <issuer-name>`
2. Check certificate events: `kubectl describe certificate <cert-name>`
3. Check cert-manager logs: `kubectl logs -n cert-manager deployment/cert-manager`

### DNS01 Challenge Failures
1. Verify DNS provider credentials
2. Check domain ownership and DNS propagation
3. Validate DNS provider permissions (Route53 zones, Cloudflare API tokens)

### HTTP01 Challenge Failures
1. Verify ingress controller is working
2. Check domain points to your cluster
3. Ensure port 80 is accessible from internet

## External Dependencies for Real Testing

### DNS Providers (for DNS01 challenges)
- **AWS Route53**: Requires AWS credentials and hosted zone
- **Cloudflare**: Requires API token and domain management
- **Google Cloud DNS**: Requires service account and DNS zone
- **Azure DNS**: Requires service principal and DNS zone

### Ingress Controllers (for HTTP01 challenges)
- **nginx-ingress**: Most common, well-supported
- **traefik**: Good for development, built-in Let's Encrypt
- **istio-gateway**: For service mesh environments
- **AWS ALB**: For AWS EKS clusters

### Monitoring and Observability
- **Prometheus**: For cert-manager metrics
- **Grafana**: For certificate expiry dashboards
- **AlertManager**: For certificate expiry alerts

## Conclusion

The TypeKro cert-manager integration provides:
1. **Fast unit tests** for development
2. **Integration tests** for TypeKro feature validation
3. **Documentation and examples** for real certificate testing
4. **Flexibility** to test with your infrastructure

This approach balances development speed with real-world validation capabilities.