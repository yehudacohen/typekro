import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { type } from 'arktype';
import {
  kubernetesComposition,
  typeKroRuntimeBootstrap,
  certManager,
  externalDns,
  simple,
} from '../../../src/index.js';

describe('Three-Composition Demo Integration', () => {
  const testNamespace = 'typekro-nested-test';

  beforeAll(async () => {
    console.log('🧪 Setting up three-composition demo integration test...');
  });

  afterAll(async () => {
    console.log('🧹 Cleaning up three-composition demo test resources...');
    // Note: In a real test, we would clean up the deployed resources
  });

  it('should create three compositions with nested composition calls', async () => {
    // Define the same compositions as in the demo
    const InfrastructureSpec = type({
      domain: 'string',
      email: 'string',
      awsRegion: 'string',
      hostedZoneId: 'string',
      acmeServer: 'string',
      runtimePhase: '"Pending" | "Installing" | "Ready" | "Failed" | "Upgrading"',
      kroSystemReady: 'boolean',
    });

    const InfrastructureStatus = type({
      certManagerReady: 'boolean',
      externalDnsReady: 'boolean',
      issuerReady: 'boolean',
      issuerName: 'string',
      dnsProvider: 'string',
    });

    const infrastructureStack = kubernetesComposition(
      {
        name: 'infrastructure-stack-test',
        apiVersion: 'demo.typekro.dev/v1alpha1',
        kind: 'InfrastructureStack',
        spec: InfrastructureSpec,
        status: InfrastructureStatus,
      },
      (spec) => {
        // Test nested composition calls
        const certManagerInstance = certManager.certManagerBootstrap({
          name: 'cert-manager-test',
          namespace: 'cert-manager',
          version: '1.13.3',
          installCRDs: true,
          controller: {
            resources: {
              requests: { cpu: '10m', memory: '32Mi' },
              limits: { cpu: '100m', memory: '128Mi' },
            },
          },
          webhook: { enabled: true, replicaCount: 1 },
          cainjector: { enabled: true, replicaCount: 1 },
        });

        const externalDnsInstance = externalDns.externalDnsBootstrap({
          name: 'external-dns-test',
          namespace: 'external-dns',
          provider: 'aws',
          domainFilters: [spec.domain],
          policy: 'sync',
          txtOwnerId: 'typekro-test',
        });

        const issuer = certManager.clusterIssuer({
          name: 'letsencrypt-test',
          spec: {
            acme: {
              server: spec.acmeServer,
              email: spec.email,
              privateKeySecretRef: { name: 'letsencrypt-test-key' },
              solvers: [
                {
                  dns01: {
                    route53: {
                      region: spec.awsRegion,
                      hostedZoneID: spec.hostedZoneId,
                    },
                  },
                },
              ],
            },
          },
          id: 'clusterIssuer',
        });

        // Test cross-composition references
        return {
          certManagerReady: certManagerInstance.status.ready,
          externalDnsReady: externalDnsInstance.status.ready,
          issuerReady:
            issuer.status.conditions?.some((c: any) => c.type === 'Ready' && c.status === 'True') ||
            false,
          issuerName: 'letsencrypt-test',
          dnsProvider: 'aws',
        };
      }
    );

    const WebappSpec = type({
      name: 'string',
      domain: 'string',
      'image?': 'string',
      'replicas?': 'number',
      issuerName: 'string',
      dnsProvider: 'string',
    });

    const WebappStatus = type({
      deploymentReady: 'boolean',
      serviceReady: 'boolean',
      certificateReady: 'boolean',
      ingressReady: 'boolean',
      url: 'string',
      ready: 'boolean',
    });

    const webappStack = kubernetesComposition(
      {
        name: 'webapp-stack-test',
        apiVersion: 'demo.typekro.dev/v1alpha1',
        kind: 'WebappStack',
        spec: WebappSpec,
        status: WebappStatus,
      },
      (spec) => {
        const deployment = simple.Deployment({
          name: spec.name,
          image: spec.image || 'nginx:alpine',
          replicas: spec.replicas || 1,
          ports: [{ containerPort: 80 }],
          id: 'deployment',
        });

        const service = simple.Service({
          name: `${spec.name}-service`,
          selector: { app: spec.name },
          ports: [{ port: 80, targetPort: 80 }],
          id: 'service',
        });

        const certificate = certManager.certificate({
          name: `${spec.name}-cert`,
          spec: {
            secretName: `${spec.name}-tls`,
            dnsNames: [spec.domain],
            issuerRef: {
              name: spec.issuerName,
              kind: 'ClusterIssuer',
            },
          },
          id: 'certificate',
        });

        const ingress = simple.Ingress({
          name: `${spec.name}-ingress`,
          namespace: testNamespace,
          annotations: {
            'cert-manager.io/cluster-issuer': spec.issuerName,
            'external-dns.alpha.kubernetes.io/hostname': spec.domain,
          },
          tls: [
            {
              hosts: [spec.domain],
              secretName: `${spec.name}-tls`,
            },
          ],
          rules: [
            {
              host: spec.domain,
              http: {
                paths: [
                  {
                    path: '/',
                    pathType: 'Prefix',
                    backend: {
                      service: {
                        name: `${spec.name}-service`,
                        port: { number: 80 },
                      },
                    },
                  },
                ],
              },
            },
          ],
          id: 'ingress',
        });

        return {
          deploymentReady: deployment.status.readyReplicas >= (spec.replicas || 1),
          serviceReady: service.status.clusterIP !== undefined,
          certificateReady:
            certificate.status.conditions?.some(
              (c: any) => c.type === 'Ready' && c.status === 'True'
            ) || false,
          ingressReady: ingress.status.loadBalancer?.ingress?.length > 0 || false,
          url: `https://${spec.domain}`,
          ready:
            deployment.status.readyReplicas >= (spec.replicas || 1) &&
            (certificate.status.conditions?.some(
              (c: any) => c.type === 'Ready' && c.status === 'True'
            ) ||
              false) &&
            (ingress.status.loadBalancer?.ingress?.length > 0 || false),
        };
      }
    );

    // Test 1: Verify compositions can be created
    expect(infrastructureStack).toBeDefined();
    expect(webappStack).toBeDefined();

    // Test 2: Verify YAML generation works
    const infraYaml = infrastructureStack.toYaml();
    const webappYaml = webappStack.toYaml();

    expect(infraYaml).toContain('kind: ResourceGraphDefinition');
    expect(infraYaml).toContain('InfrastructureStack');
    expect(webappYaml).toContain('kind: ResourceGraphDefinition');
    expect(webappYaml).toContain('WebappStack');

    // Test 3: Verify nested compositions are included in YAML
    expect(infraYaml).toContain('cert-manager'); // Should contain cert-manager resources
    expect(infraYaml).toContain('external-dns'); // Should contain external-dns resources
    expect(infraYaml).toContain('ClusterIssuer'); // Should contain the direct ClusterIssuer

    // Test 4: Verify cross-composition references in status
    expect(infraYaml).toContain('certManagerReady'); // Status field referencing nested composition
    expect(infraYaml).toContain('externalDnsReady'); // Status field referencing nested composition

    // Test 5: Verify factory creation works
    const infraFactory = infrastructureStack.factory('kro', {
      namespace: testNamespace,
      waitForReady: false, // Don't wait in test
    });

    const webappFactory = webappStack.factory('kro', {
      namespace: testNamespace,
      waitForReady: false,
    });

    expect(infraFactory).toBeDefined();
    expect(webappFactory).toBeDefined();

    console.log('✅ Three-composition demo integration test passed');
    console.log('   - Infrastructure composition with nested cert-manager and external-dns');
    console.log('   - Webapp composition with cross-composition references');
    console.log('   - YAML generation works for all compositions');
    console.log('   - Factory creation works for kro deployment mode');
  }, 30000); // 30 second timeout

  it('should validate TypeKro bootstrap composition works', async () => {
    // Test the TypeKro bootstrap composition
    // typeKroRuntimeBootstrap returns a CallableComposition
    const bootstrap = typeKroRuntimeBootstrap({
      namespace: 'flux-system',
      fluxVersion: 'v2.4.0',
      kroVersion: '0.3.0',
    });

    expect(bootstrap).toBeDefined();
    expect(typeof bootstrap).toBe('function');

    // Test YAML generation
    const bootstrapYaml = bootstrap.toYaml();
    expect(bootstrapYaml).toContain('kind: ResourceGraphDefinition');
    expect(bootstrapYaml).toContain('TypeKroRuntime');
    expect(bootstrapYaml).toContain('HelmRelease'); // Should contain Kro HelmRelease

    // Test factory creation
    const bootstrapFactory = bootstrap.factory('direct', {
      namespace: 'flux-system',
      waitForReady: false,
    });

    expect(bootstrapFactory).toBeDefined();

    console.log('✅ TypeKro bootstrap composition test passed');
  });

  it('should demonstrate complete three-composition architecture', async () => {
    // This test demonstrates the complete architecture without actual deployment
    console.log('🏗️  Testing complete three-composition architecture...');

    // 1. Bootstrap composition
    const bootstrap = typeKroRuntimeBootstrap({
      namespace: 'flux-system',
      fluxVersion: 'v2.4.0',
      kroVersion: '0.3.0',
    });
    const bootstrapYaml = bootstrap.toYaml();

    // 2. Infrastructure composition (with nested compositions)
    const InfrastructureSpec = type({
      domain: 'string',
      email: 'string',
      awsRegion: 'string',
      hostedZoneId: 'string',
      acmeServer: 'string',
      runtimePhase: '"Pending" | "Installing" | "Ready" | "Failed" | "Upgrading"',
      kroSystemReady: 'boolean',
    });

    const InfrastructureStatus = type({
      certManagerReady: 'boolean',
      externalDnsReady: 'boolean',
      issuerReady: 'boolean',
      issuerName: 'string',
      dnsProvider: 'string',
    });

    const infrastructure = kubernetesComposition(
      {
        name: 'infrastructure-demo',
        apiVersion: 'demo.typekro.dev/v1alpha1',
        kind: 'InfrastructureStack',
        spec: InfrastructureSpec,
        status: InfrastructureStatus,
      },
      (spec) => {
        // Nested composition calls
        const certMgr = certManager.certManagerBootstrap({
          name: 'cert-manager',
          namespace: 'cert-manager',
          version: '1.13.3',
          installCRDs: true,
        });

        const extDns = externalDns.externalDnsBootstrap({
          name: 'external-dns',
          namespace: 'external-dns',
          provider: 'aws',
          domainFilters: [spec.domain],
        });

        return {
          certManagerReady: certMgr.status.ready,
          externalDnsReady: extDns.status.ready,
          issuerReady: true,
          issuerName: 'letsencrypt-staging',
          dnsProvider: 'aws',
        };
      }
    );

    const infraYaml = infrastructure.toYaml();

    // 3. Webapp composition (with cross-composition references)
    const WebappSpec = type({
      name: 'string',
      domain: 'string',
      issuerName: 'string',
      dnsProvider: 'string',
    });

    const WebappStatus = type({
      ready: 'boolean',
      url: 'string',
    });

    const webapp = kubernetesComposition(
      {
        name: 'webapp-demo',
        apiVersion: 'demo.typekro.dev/v1alpha1',
        kind: 'WebappStack',
        spec: WebappSpec,
        status: WebappStatus,
      },
      (spec) => {
        const deployment = simple.Deployment({
          name: spec.name,
          image: 'nginx:alpine',
          replicas: 1,
          id: 'deployment',
        });

        return {
          ready: deployment.status.readyReplicas >= 1,
          url: `https://${spec.domain}`,
        };
      }
    );

    const webappYaml = webapp.toYaml();

    // Verify all three compositions work
    expect(bootstrapYaml.length).toBeGreaterThan(500);
    expect(infraYaml.length).toBeGreaterThan(2000); // Should be larger due to nested compositions
    expect(webappYaml.length).toBeGreaterThan(500);

    // Verify nested composition content
    expect(infraYaml).toContain('cert-manager');
    expect(infraYaml).toContain('external-dns');
    expect(infraYaml).toContain('HelmRepository');
    expect(infraYaml).toContain('HelmRelease');

    console.log('✅ Complete three-composition architecture validated');
    console.log(`   - Bootstrap YAML: ${bootstrapYaml.length} chars`);
    console.log(`   - Infrastructure YAML: ${infraYaml.length} chars (with nested compositions)`);
    console.log(`   - Webapp YAML: ${webappYaml.length} chars`);
  });
});
