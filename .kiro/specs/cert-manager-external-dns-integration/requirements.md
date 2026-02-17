# Cert-Manager and External-DNS Integration Requirements

## Introduction

This feature will add comprehensive support for cert-manager and external-dns to TypeKro, providing type-safe factory functions for certificate management and DNS automation, bootstrap compositions for common deployment patterns, and integration with their respective Helm charts. This implementation follows the established patterns from the Cilium ecosystem integration and addresses the lessons learned from that implementation.

**Key Improvements from Cilium Experience:**
1. **Early Integration Testing**: Real integration tests will be written immediately after types are defined, before compositions and factories are implemented
2. **Dual Deployment Support**: Both kro and direct deployment strategies will be supported and tested throughout the lifecycle
3. **Exact Resource Structure**: Factories will represent the exact structure of resources deployed to Kubernetes
4. **Simple Factory Abstractions**: Simple factories will wrap exact factories to provide developer-friendly abstractions
5. **Webapp Composition**: A comprehensive webapp composition will demonstrate the integration of cert-manager and external-dns

## Requirements

### Requirement 1: Cert-Manager Helm Chart Bootstrap Composition

**User Story:** As a platform engineer, I want a type-safe bootstrap composition for deploying cert-manager via Helm using kubernetesComposition, so that I can easily configure and deploy cert-manager with sensible defaults and expose integration points for certificate management.

#### Acceptance Criteria

1. WHEN I use the cert-manager bootstrap composition THEN I SHALL get a HelmRelease and HelmRepository configured for cert-manager
2. WHEN I specify configuration options THEN they SHALL be validated against cert-manager's Helm chart schema
3. WHEN I omit configuration options THEN sensible defaults SHALL be applied matching cert-manager's chart defaults
4. WHEN I use TypeKro schema references THEN they SHALL work correctly in cert-manager Helm values
5. WHEN I deploy the composition THEN it SHALL create a functional cert-manager installation with CRDs
6. WHEN I access the composition status THEN I SHALL get CEL-based status expressions for integration points
7. WHEN other systems need to integrate with cert-manager THEN they SHALL have access to typed outputs like webhook endpoints, metrics endpoints, and readiness states
8. WHEN I configure ACME providers THEN they SHALL be properly validated and configured for Let's Encrypt integration
9. WHEN I configure DNS01 challenge providers THEN they SHALL integrate with external-dns for automated DNS record management

### Requirement 2: External-DNS Helm Chart Bootstrap Composition

**User Story:** As a platform engineer, I want a type-safe bootstrap composition for deploying external-dns via Helm using kubernetesComposition, so that I can easily configure and deploy external-dns with sensible defaults and expose integration points for DNS automation.

#### Acceptance Criteria

1. WHEN I use the external-dns bootstrap composition THEN I SHALL get a HelmRelease and HelmRepository configured for external-dns
2. WHEN I specify DNS provider configuration THEN it SHALL be validated against external-dns's supported providers
3. WHEN I configure domain filters THEN they SHALL be properly validated and applied
4. WHEN I set ownership identifiers THEN they SHALL be configured to prevent conflicts between multiple external-dns instances
5. WHEN I deploy the composition THEN it SHALL create a functional external-dns installation
6. WHEN I access the composition status THEN I SHALL get CEL-based status expressions for integration points
7. WHEN other systems need to integrate with external-dns THEN they SHALL have access to typed outputs like provider status, domain management endpoints, and readiness states
8. WHEN I configure multiple DNS providers THEN they SHALL be properly isolated and managed
9. WHEN I integrate with cert-manager THEN DNS01 challenges SHALL be automatically resolved

### Requirement 3: Cert-Manager CRD Factory Functions

**User Story:** As a developer, I want type-safe factory functions for all cert-manager Custom Resource Definitions, so that I can create and manage certificates and issuers with full TypeScript support.

#### Acceptance Criteria

1. WHEN I use cert-manager CRD factories THEN I SHALL get Enhanced resources with proper typing
2. WHEN I create Certificate THEN it SHALL have proper spec validation and status typing with renewal tracking
3. WHEN I create ClusterIssuer THEN it SHALL support all cert-manager issuer types (ACME, CA, Vault, Venafi)
4. WHEN I create Issuer THEN it SHALL support namespace-scoped certificate issuance
5. WHEN I create CertificateRequest THEN it SHALL validate certificate signing request parameters
6. WHEN I create Challenge THEN it SHALL support both HTTP01 and DNS01 challenge types
7. WHEN I create Order THEN it SHALL track ACME order lifecycle and status
8. WHEN I use ACME issuers THEN they SHALL integrate with external-dns for DNS01 challenges
9. WHEN I configure certificate templates THEN they SHALL support all standard certificate fields (SAN, key usage, etc.)
10. WHEN I use cert-manager annotations THEN they SHALL be properly typed and validated

### Requirement 4: Certificate and DNS Readiness Evaluation

**User Story:** As a developer, I want cert-manager and external-dns resources to have proper readiness evaluation, so that I can reliably wait for certificates to be issued and DNS records to be propagated before proceeding with dependent operations.

#### Acceptance Criteria

1. WHEN I deploy cert-manager resources THEN they SHALL have appropriate readiness evaluators
2. WHEN Certificate is requested THEN readiness SHALL check certificate issuance status without timing out
3. WHEN ClusterIssuer is configured THEN readiness SHALL check issuer registration and ACME account status
4. WHEN Challenge is created THEN readiness SHALL check challenge completion status
5. WHEN Order is submitted THEN readiness SHALL check ACME order fulfillment
6. WHEN external-dns records are created THEN readiness SHALL check DNS propagation status
7. WHEN I use waitForReady THEN it SHALL properly wait for certificate and DNS readiness within reasonable timeouts (< 5 minutes for certificates, < 2 minutes for DNS)
8. WHEN readiness evaluation fails THEN I SHALL get clear error messages about what's not ready
9. WHEN certificate renewal occurs THEN the system SHALL handle renewal status gracefully

### Requirement 5: Ecosystem Organization Structure

**User Story:** As a maintainer, I want cert-manager and external-dns support organized in consistent ecosystem structures, so that they follow the established patterns and can serve as examples for future integrations.

#### Acceptance Criteria

1. WHEN I look at the codebase THEN cert-manager support SHALL be organized under `src/factories/cert-manager/`
2. WHEN I look at the codebase THEN external-dns support SHALL be organized under `src/factories/external-dns/`
3. WHEN I examine the structure THEN they SHALL follow the established factory organization patterns from Cilium
4. WHEN I look at exports THEN they SHALL be properly organized in index files
5. WHEN I examine types THEN they SHALL be centralized in types files
6. WHEN I look at compositions THEN they SHALL be in dedicated compositions directories
7. WHEN I examine readiness evaluators THEN they SHALL be embedded in resource factory files
8. WHEN I look at the structure THEN it SHALL serve as a template for future ecosystem integrations

### Requirement 6: Type Safety and Developer Experience

**User Story:** As a developer, I want full TypeScript support for cert-manager and external-dns resources, so that I get autocomplete, type checking, and refactoring support.

#### Acceptance Criteria

1. WHEN I use cert-manager and external-dns factories THEN TypeScript SHALL provide full autocomplete
2. WHEN I make configuration errors THEN TypeScript SHALL show compile-time errors
3. WHEN I access resource properties THEN they SHALL be properly typed
4. WHEN I use cross-resource references THEN they SHALL work with cert-manager and external-dns resources
5. WHEN I use CEL expressions THEN they SHALL work with certificate and DNS resource fields
6. WHEN I refactor code THEN TypeScript SHALL catch breaking changes
7. WHEN I use IDE features THEN they SHALL work seamlessly with certificate and DNS resources

### Requirement 7: Bootstrap Composition Configuration Schemas

**User Story:** As a platform engineer, I want comprehensive configuration schemas for cert-manager and external-dns bootstrap compositions, so that I can configure all aspects of certificate management and DNS automation with type safety.

#### Acceptance Criteria

1. WHEN I configure cert-manager THEN I SHALL have typed options for all major Helm chart values
2. WHEN I set ACME configuration THEN it SHALL validate ACME server URLs and account settings
3. WHEN I configure DNS01 providers THEN it SHALL validate provider-specific credentials and settings
4. WHEN I set webhook configuration THEN it SHALL validate webhook endpoints and TLS settings
5. WHEN I configure external-dns THEN I SHALL have typed options for all supported DNS providers
6. WHEN I set domain filters THEN it SHALL validate domain patterns and ownership settings
7. WHEN I configure provider credentials THEN it SHALL validate credential formats and requirements
8. WHEN I set sync policies THEN it SHALL validate record types and update strategies
9. WHEN I configure integration between cert-manager and external-dns THEN it SHALL validate compatibility

### Requirement 8: Integration with Existing TypeKro Features

**User Story:** As a developer, I want cert-manager and external-dns resources to work seamlessly with all existing TypeKro features, so that I can leverage the full power of the TypeKro ecosystem.

#### Acceptance Criteria

1. WHEN I use cert-manager and external-dns resources in compositions THEN they SHALL work with kubernetesComposition
2. WHEN I create resource graphs THEN cert-manager and external-dns resources SHALL serialize properly to YAML
3. WHEN I use direct deployment THEN cert-manager and external-dns resources SHALL deploy correctly
4. WHEN I use Kro deployment THEN cert-manager and external-dns resources SHALL work with ResourceGraphDefinitions
5. WHEN I use dependency resolution THEN cert-manager and external-dns resources SHALL participate correctly
6. WHEN I use status expressions THEN they SHALL work with certificate and DNS resource status fields and generate proper CEL expressions
7. WHEN I use the factory pattern THEN cert-manager and external-dns compositions SHALL work as factories
8. WHEN I use toResourceGraph THEN cert-manager and external-dns resources SHALL work with the declarative API pattern

### Requirement 9: Webapp Integration Composition

**User Story:** As a developer, I want a comprehensive webapp composition that demonstrates the integration of cert-manager and external-dns, so that I can easily deploy web applications with automated certificate management and DNS configuration.

#### Acceptance Criteria

1. WHEN I use the webapp composition THEN it SHALL deploy a complete web application stack
2. WHEN I specify a domain name THEN it SHALL automatically create DNS records via external-dns
3. WHEN I request TLS certificates THEN it SHALL automatically issue certificates via cert-manager
4. WHEN I deploy the webapp THEN it SHALL configure ingress with proper TLS termination
5. WHEN certificates need renewal THEN it SHALL handle automatic renewal without downtime
6. WHEN DNS records need updates THEN it SHALL handle automatic DNS management
7. WHEN I access the webapp status THEN it SHALL report certificate validity, DNS propagation, and application readiness
8. WHEN I use different DNS providers THEN it SHALL work with multiple external-dns configurations
9. WHEN I use different certificate authorities THEN it SHALL work with multiple cert-manager issuers
10. WHEN I deploy multiple webapps THEN they SHALL not conflict with each other's certificates or DNS records

### Requirement 10: Early Integration Testing Strategy

**User Story:** As a developer, I want comprehensive integration tests that validate real deployments from the beginning of implementation, so that I can ensure functionality works end-to-end throughout the development process.

#### Acceptance Criteria

1. WHEN I implement type definitions THEN integration test scaffolds SHALL be created immediately
2. WHEN I implement factory functions THEN they SHALL be tested with real Kubernetes deployments using both kro and direct strategies
3. WHEN I implement bootstrap compositions THEN they SHALL be tested with actual Helm deployments in test clusters
4. WHEN I implement readiness evaluators THEN they SHALL be tested with real resource lifecycle events
5. WHEN I implement the webapp composition THEN it SHALL be tested with complete end-to-end scenarios
6. WHEN tests run THEN they SHALL use the established integration test infrastructure (`scripts/e2e-setup.sh`)
7. WHEN tests fail THEN they SHALL provide clear diagnostics about what went wrong
8. WHEN I make changes THEN all integration tests SHALL continue to pass
9. WHEN I add new functionality THEN corresponding integration tests SHALL be added simultaneously

### Requirement 11: Helm Chart Integration Best Practices

**User Story:** As a platform engineer, I want cert-manager and external-dns Helm integrations to follow best practices learned from the Cilium implementation, so that deployments are reliable and maintainable.

#### Acceptance Criteria

1. WHEN I deploy cert-manager THEN CRDs SHALL be installed separately before the main chart (following cert-manager best practices)
2. WHEN I configure Helm values THEN they SHALL be properly mapped from TypeKro configuration to chart values
3. WHEN I use schema proxy values THEN they SHALL resolve to actual values during deployment (not proxy functions)
4. WHEN I deploy via Kro factory THEN ResourceGraphDefinitions SHALL be created without schema resolution errors
5. WHEN I deploy via direct factory THEN resources SHALL be created in the correct dependency order
6. WHEN Helm releases fail THEN I SHALL get clear error messages with troubleshooting guidance
7. WHEN I upgrade versions THEN the system SHALL handle version compatibility and migration
8. WHEN I use custom values THEN they SHALL override defaults without breaking core functionality

### Requirement 12: DNS Provider Support

**User Story:** As a platform engineer, I want comprehensive support for major DNS providers in external-dns, so that I can use the system with my existing DNS infrastructure.

#### Acceptance Criteria

1. WHEN I configure AWS Route53 THEN it SHALL support all Route53 features (hosted zones, health checks, etc.)
2. WHEN I configure Cloudflare THEN it SHALL support both API token and API key authentication
3. WHEN I configure Google Cloud DNS THEN it SHALL support service account authentication
4. WHEN I configure Azure DNS THEN it SHALL support managed identity and service principal authentication
5. WHEN I configure multiple providers THEN they SHALL be isolated and not interfere with each other
6. WHEN I use provider-specific features THEN they SHALL be properly typed and validated
7. WHEN I configure credentials THEN they SHALL be handled securely via Kubernetes secrets
8. WHEN provider APIs change THEN the system SHALL handle API versioning gracefully

### Requirement 13: Certificate Authority Support

**User Story:** As a platform engineer, I want comprehensive support for major certificate authorities in cert-manager, so that I can use the system with my existing PKI infrastructure.

#### Acceptance Criteria

1. WHEN I configure Let's Encrypt THEN it SHALL support both staging and production environments
2. WHEN I configure private CA THEN it SHALL support custom certificate authorities
3. WHEN I configure Vault THEN it SHALL integrate with HashiCorp Vault PKI
4. WHEN I configure Venafi THEN it SHALL integrate with Venafi Trust Protection Platform
5. WHEN I use ACME challenges THEN it SHALL support both HTTP01 and DNS01 challenge types
6. WHEN I configure certificate templates THEN they SHALL support all standard X.509 certificate fields
7. WHEN I use multiple issuers THEN they SHALL be isolated and not interfere with each other
8. WHEN certificates expire THEN they SHALL be automatically renewed before expiration

## Success Criteria

- Complete type-safe support for cert-manager and external-dns ecosystem deployment and management
- Bootstrap compositions that handle common certificate management and DNS automation scenarios
- Factory functions for all major cert-manager and external-dns CRDs with proper typing and validation
- Seamless integration with existing TypeKro features and patterns
- Comprehensive webapp composition demonstrating end-to-end integration
- Early integration testing throughout the implementation process
- Structure that serves as a template for future ecosystem integrations
- Performance suitable for production certificate management and DNS automation

## Example Usage

### Cert-Manager Bootstrap Composition
```typescript
import { type } from 'arktype';
import { kubernetesComposition } from 'typekro';
import { certManagerBootstrap } from 'typekro/cert-manager';

const CertManagerStackSpec = type({
  clusterName: 'string',
  acmeEmail: 'string',
  acmeServer: 'string',
  enableWebhook: 'boolean',
  enableCainjector: 'boolean'
});

const CertManagerStackStatus = type({
  phase: 'string',
  ready: 'boolean',
  webhookReady: 'boolean',
  cainjectorReady: 'boolean',
  controllerReady: 'boolean',
  webhookEndpoint: 'string',
  metricsEndpoint: 'string'
});

const certManagerStack = kubernetesComposition(
  {
    name: 'cert-manager-stack',
    apiVersion: 'platform.example.com/v1alpha1',
    kind: 'CertManagerStack',
    spec: CertManagerStackSpec,
    status: CertManagerStackStatus,
  },
  (spec) => {
    const certManager = certManagerBootstrap({
      name: 'cert-manager',
      namespace: 'cert-manager',
      acme: {
        email: spec.acmeEmail,
        server: spec.acmeServer
      },
      webhook: {
        enabled: spec.enableWebhook
      },
      cainjector: {
        enabled: spec.enableCainjector
      },
      id: 'certManager'
    });

    return {
      phase: certManager.helmRelease.status.phase === 'Ready' ? 'Ready' : 'Installing',
      ready: certManager.helmRelease.status.phase === 'Ready',
      webhookReady: certManager.webhookDeployment.status.readyReplicas > 0,
      cainjectorReady: certManager.cainjectorDeployment.status.readyReplicas > 0,
      controllerReady: certManager.controllerDeployment.status.readyReplicas > 0,
      webhookEndpoint: `https://cert-manager-webhook.cert-manager.svc.cluster.local:10250/mutate`,
      metricsEndpoint: `http://cert-manager.cert-manager.svc.cluster.local:9402/metrics`
    };
  }
);
```

### External-DNS Bootstrap Composition
```typescript
import { type } from 'arktype';
import { kubernetesComposition } from 'typekro';
import { externalDnsBootstrap } from 'typekro/external-dns';

const ExternalDnsStackSpec = type({
  provider: '"aws" | "cloudflare" | "google" | "azure"',
  domainFilters: 'string[]',
  txtOwnerId: 'string',
  dryRun: 'boolean'
});

const ExternalDnsStackStatus = type({
  phase: 'string',
  ready: 'boolean',
  provider: 'string',
  managedDomains: 'string[]',
  recordsManaged: 'number'
});

const externalDnsStack = kubernetesComposition(
  {
    name: 'external-dns-stack',
    apiVersion: 'platform.example.com/v1alpha1',
    kind: 'ExternalDnsStack',
    spec: ExternalDnsStackSpec,
    status: ExternalDnsStackStatus,
  },
  (spec) => {
    const externalDns = externalDnsBootstrap({
      name: 'external-dns',
      namespace: 'external-dns',
      provider: {
        name: spec.provider
      },
      domainFilters: spec.domainFilters,
      txtOwnerId: spec.txtOwnerId,
      dryRun: spec.dryRun,
      id: 'externalDns'
    });

    return {
      phase: externalDns.helmRelease.status.phase === 'Ready' ? 'Ready' : 'Installing',
      ready: externalDns.helmRelease.status.phase === 'Ready',
      provider: spec.provider,
      managedDomains: spec.domainFilters,
      recordsManaged: 0 // Will be hydrated from actual external-dns metrics
    };
  }
);
```

### Certificate Factory Usage
```typescript
import { certificate, clusterIssuer } from 'typekro/cert-manager';

const letsEncryptIssuer = clusterIssuer({
  name: 'letsencrypt-prod',
  spec: {
    acme: {
      server: 'https://acme-v02.api.letsencrypt.org/directory',
      email: 'admin@example.com',
      privateKeySecretRef: {
        name: 'letsencrypt-prod'
      },
      solvers: [{
        dns01: {
          cloudflare: {
            email: 'admin@example.com',
            apiTokenSecretRef: {
              name: 'cloudflare-api-token',
              key: 'api-token'
            }
          }
        }
      }]
    }
  }
});

const tlsCertificate = certificate({
  name: 'example-com-tls',
  namespace: 'default',
  spec: {
    secretName: 'example-com-tls',
    issuerRef: {
      name: 'letsencrypt-prod',
      kind: 'ClusterIssuer'
    },
    dnsNames: [
      'example.com',
      '*.example.com'
    ]
  }
});
```

### Webapp Integration Composition
```typescript
import { type } from 'arktype';
import { kubernetesComposition } from 'typekro';
import { certManagerStack, externalDnsStack } from './infrastructure';
import { Deployment, Service, Ingress } from 'typekro/simple';

const WebappSpec = type({
  name: 'string',
  domain: 'string',
  image: 'string',
  replicas: 'number'
});

const WebappStatus = type({
  ready: 'boolean',
  url: 'string',
  certificateReady: 'boolean',
  dnsReady: 'boolean',
  applicationReady: 'boolean'
});

const webapp = kubernetesComposition(
  {
    name: 'webapp',
    apiVersion: 'example.com/v1alpha1',
    kind: 'Webapp',
    spec: WebappSpec,
    status: WebappStatus,
  },
  (spec) => {
    // Deploy infrastructure first
    const certManager = certManagerStack.deploy({
      clusterName: 'production',
      acmeEmail: 'admin@example.com',
      acmeServer: 'https://acme-v02.api.letsencrypt.org/directory',
      enableWebhook: true,
      enableCainjector: true
    });

    const externalDns = externalDnsStack.deploy({
      provider: 'cloudflare',
      domainFilters: [spec.domain],
      txtOwnerId: 'webapp-cluster',
      dryRun: false
    });

    // Deploy application
    const app = Deployment({
      name: spec.name,
      image: spec.image,
      replicas: spec.replicas,
      id: 'app'
    });

    const service = Service({
      name: `${spec.name}-service`,
      selector: { app: spec.name },
      ports: [{ port: 80, targetPort: 8080 }],
      id: 'service'
    });

    // Create certificate
    const certificate = certificate({
      name: `${spec.name}-tls`,
      namespace: 'default',
      spec: {
        secretName: `${spec.name}-tls`,
        issuerRef: {
          name: 'letsencrypt-prod',
          kind: 'ClusterIssuer'
        },
        dnsNames: [spec.domain]
      },
      id: 'certificate'
    });

    // Create ingress with TLS and external-dns annotation
    const ingress = Ingress({
      name: spec.name,
      annotations: {
        'external-dns.alpha.kubernetes.io/hostname': spec.domain,
        'cert-manager.io/cluster-issuer': 'letsencrypt-prod'
      },
      rules: [{
        host: spec.domain,
        http: {
          paths: [{
            path: '/',
            pathType: 'Prefix',
            backend: {
              service: {
                name: service.metadata.name,
                port: { number: 80 }
              }
            }
          }]
        }
      }],
      tls: [{
        hosts: [spec.domain],
        secretName: `${spec.name}-tls`
      }],
      id: 'ingress'
    });

    return {
      ready: app.status.readyReplicas > 0 && certificate.status.conditions?.find(c => c.type === 'Ready')?.status === 'True',
      url: `https://${spec.domain}`,
      certificateReady: certificate.status.conditions?.find(c => c.type === 'Ready')?.status === 'True',
      dnsReady: externalDns.ready,
      applicationReady: app.status.readyReplicas > 0
    };
  }
);
```

## Non-Functional Requirements

- **Performance**: Bootstrap compositions should deploy cert-manager and external-dns within typical timeframes (2-3 minutes)
- **Type Safety**: Full TypeScript type checking for all cert-manager and external-dns resources and configurations
- **Usability**: API should feel natural and consistent with existing TypeKro patterns
- **Compatibility**: Must work with all existing TypeKro deployment strategies (direct, Kro)
- **Reliability**: Readiness evaluation should accurately reflect certificate and DNS resource states
- **Security**: Certificate private keys and DNS provider credentials must be handled securely
- **Maintainability**: Code structure should be easy to extend and maintain
- **Documentation**: Comprehensive documentation with practical examples
- **Template Quality**: Structure should serve as a high-quality template for future ecosystems

## Future Ecosystem Template Structure

This spec establishes the following structure for ecosystem support:

```
src/factories/{ecosystem}/
├── index.ts                    # Main exports
├── types.ts                    # Type definitions
├── compositions/               # Bootstrap compositions
│   ├── index.ts
│   └── {ecosystem}-bootstrap.ts
└── resources/                  # CRD factory functions with embedded readiness evaluators
    ├── index.ts
    ├── helm.ts                 # Ecosystem-specific Helm wrappers
    ├── {resource-category-1}.ts
    ├── {resource-category-2}.ts
    └── ...
```

This structure should be followed for future ecosystem integrations while incorporating the lessons learned from both Cilium and this cert-manager/external-dns implementation.