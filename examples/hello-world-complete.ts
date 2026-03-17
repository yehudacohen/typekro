#!/usr/bin/env bun

/**
 * Complete Hello World Example with TypeKro
 *
 * This example demonstrates the full power of TypeKro:
 * 1. TypeKro runtime bootstrap (direct mode)
 * 2. Infrastructure setup with cert-manager and external-dns (direct mode)
 * 3. Complete webapp with automatic TLS certificate (kro mode)
 * 4. Event monitoring integration
 * 5. Real Route53 integration with DNS-01 challenges
 *
 * Prerequisites:
 * - AWS credentials configured (default profile)
 * - Route53 hosted zone for your domain
 * - kubectl connected to a cluster
 *
 * Usage:
 *   bun run examples/hello-world-complete.ts
 */

import { type } from 'arktype';
import { typeKroRuntimeBootstrap } from '../src/compositions/typekro-runtime/index.js';
import { certManager, externalDns, kubernetesComposition, simple } from '../src/index.js';

// Configuration - Update these for your environment
const CONFIG = {
  // Your domain (must have Route53 hosted zone)
  domain: 'funwiththe.cloud',
  subdomain: 'hello-typekro',

  // AWS Route53 configuration
  aws: {
    region: 'us-east-1',
    hostedZoneId: 'Z1D633PJN98FT9', // Replace with your hosted zone ID
  },

  // Let's Encrypt configuration
  acme: {
    email: 'admin@funwiththe.cloud', // Replace with your email
    server: 'https://acme-staging-v02.api.letsencrypt.org/directory', // Staging for testing
    // server: 'https://acme-v02.api.letsencrypt.org/directory', // Production
  },
};

const FULL_DOMAIN = `${CONFIG.subdomain}.${CONFIG.domain}`;

// =============================================================================
// WEBAPP COMPOSITION WITH AUTOMATIC TLS
// =============================================================================

const WebappSpec = type({
  domain: 'string',
  replicas: 'number',
  'image?': 'string',
});

const WebappStatus = type({
  ready: 'boolean',
  url: 'string',
  certificateReady: 'boolean',
  deploymentReady: 'boolean',
  serviceReady: 'boolean',
  ingressReady: 'boolean',
});

// Complete webapp composition with automatic TLS certificate
const webappComposition = kubernetesComposition(
  {
    name: 'webapp',
    apiVersion: 'examples.typekro.dev/v1alpha1',
    kind: 'Webapp',
    spec: WebappSpec,
    status: WebappStatus,
  },
  (spec) => {
    console.log(`🚀 Deploying webapp for ${spec.domain}`);

    // Create the webapp deployment
    const deployment = simple.Deployment({
      name: 'hello-world',
      namespace: 'default',
      image: spec.image || 'nginx:alpine',
      replicas: spec.replicas,
      ports: [{ containerPort: 80 }],
      id: 'deployment',
    });

    // Create service to expose the deployment
    const service = simple.Service({
      name: 'hello-world-service',
      namespace: 'default',
      selector: { app: 'hello-world' },
      ports: [{ port: 80, targetPort: 80 }],
      id: 'service',
    });

    // Create ingress with automatic TLS certificate
    const ingress = simple.Ingress({
      name: 'hello-world-ingress',
      namespace: 'default',
      annotations: {
        'cert-manager.io/cluster-issuer': 'letsencrypt-staging',
        'external-dns.alpha.kubernetes.io/hostname': spec.domain,
        'kubernetes.io/ingress.class': 'nginx',
      },
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
                    name: 'hello-world-service',
                    port: { number: 80 },
                  },
                },
              },
            ],
          },
        },
      ],
      tls: [
        {
          hosts: [spec.domain],
          secretName: 'hello-world-tls',
        },
      ],
      id: 'ingress',
    });

    // Create certificate resource for explicit certificate management
    const certificate = certManager.certificate({
      name: 'hello-world-cert',
      namespace: 'default',
      spec: {
        secretName: 'hello-world-tls',
        issuerRef: {
          name: 'letsencrypt-staging',
          kind: 'ClusterIssuer',
        },
        dnsNames: [spec.domain],
      },
      id: 'certificate',
    });

    // Return status expressions using actual resource status
    return {
      deploymentReady: deployment.status.readyReplicas >= spec.replicas,
      serviceReady: service.spec.clusterIP !== undefined,
      ingressReady: (ingress.status.loadBalancer?.ingress?.length ?? 0) > 0,
      certificateReady:
        certificate.status?.conditions?.some(
          (c: any) => c.type === 'Ready' && c.status === 'True'
        ) || false,
      ready:
        deployment.status.readyReplicas >= spec.replicas &&
        (certificate.status?.conditions?.some(
          (c: any) => c.type === 'Ready' && c.status === 'True'
        ) ||
          false),
      url: `https://${spec.domain}`,
    };
  }
);

// =============================================================================
// DEPLOYMENT ORCHESTRATION
// =============================================================================

async function deployCompleteStack() {
  console.log('🌟 Starting Complete Hello World TypeKro Demo');
  console.log('===============================================');
  console.log(`📋 Target domain: ${FULL_DOMAIN}`);
  console.log(`🌍 AWS Region: ${CONFIG.aws.region}`);
  console.log(`📧 ACME Email: ${CONFIG.acme.email}`);
  console.log('');

  try {
    // Step 1: Bootstrap TypeKro Runtime (Direct Mode)
    console.log('🚀 Step 1: Bootstrapping TypeKro Runtime...');
    const runtimeFactory = typeKroRuntimeBootstrap({
      namespace: 'flux-system',
      fluxVersion: 'v2.4.0',
      kroVersion: '0.8.5',
    }).factory('direct', {
      namespace: 'flux-system',
      skipTLSVerify: true,
      timeout: 300000,
      waitForReady: true,
      eventMonitoring: {
        enabled: true,
        eventTypes: ['Warning', 'Error', 'Normal'],
        includeChildResources: true,
      },
      progressCallback: (event) => {
        console.log(`📡 Runtime: ${event.message}`);
      },
    });

    const runtime = await runtimeFactory.deploy({
      namespace: 'flux-system',
    });

    console.log('✅ TypeKro Runtime deployed successfully!');
    console.log('Runtime status:', runtime.status);
    console.log('');

    // Step 2: Deploy cert-manager (Direct Mode)
    console.log('🔐 Step 2: Deploying cert-manager...');
    const certManagerFactory = certManager.certManagerBootstrap.factory('direct', {
      namespace: 'cert-manager',
      skipTLSVerify: true,
      timeout: 300000,
      waitForReady: true,
      eventMonitoring: {
        enabled: true,
        eventTypes: ['Warning', 'Error', 'Normal'],
        includeChildResources: true,
      },
      progressCallback: (event) => {
        console.log(`📡 CertManager: ${event.message}`);
      },
    });

    await certManagerFactory.deploy({
      name: 'cert-manager',
      namespace: 'cert-manager',
      version: '1.19.3',
      installCRDs: true,
      controller: {
        resources: {
          requests: { cpu: '10m', memory: '32Mi' },
          limits: { cpu: '100m', memory: '128Mi' },
        },
      },
      webhook: {
        replicaCount: 1,
      },
      cainjector: {
        enabled: true,
        replicaCount: 1,
      },
    });

    console.log('✅ cert-manager deployed successfully!');
    console.log('');

    // Step 3: Deploy external-dns (Direct Mode)
    console.log('🌐 Step 3: Deploying external-dns...');
    const externalDnsFactory = externalDns.externalDnsBootstrap.factory('direct', {
      namespace: 'external-dns',
      skipTLSVerify: true,
      timeout: 300000,
      waitForReady: true,
      eventMonitoring: {
        enabled: true,
        eventTypes: ['Warning', 'Error', 'Normal'],
        includeChildResources: true,
      },
      progressCallback: (event) => {
        console.log(`📡 ExternalDNS: ${event.message}`);
      },
    });

    await externalDnsFactory.deploy({
      name: 'external-dns',
      namespace: 'external-dns',
      provider: 'aws',
      domainFilters: [CONFIG.domain],
      policy: 'sync',
      txtOwnerId: 'typekro-hello-world',
    });

    console.log('✅ external-dns deployed successfully!');
    console.log('');

    // Step 4: Create ClusterIssuer (Direct Mode)
    console.log('🔑 Step 4: Creating ClusterIssuer...');

    // Create a simple composition for the ClusterIssuer
    const clusterIssuerComposition = kubernetesComposition(
      {
        name: 'cluster-issuer',
        apiVersion: 'examples.typekro.dev/v1alpha1',
        kind: 'ClusterIssuer',
        spec: type({ ready: 'boolean' }),
        status: type({ ready: 'boolean' }),
      },
      () => {
        const clusterIssuer = certManager.clusterIssuer({
          name: 'letsencrypt-staging',
          spec: {
            acme: {
              server: CONFIG.acme.server,
              email: CONFIG.acme.email,
              privateKeySecretRef: {
                name: 'letsencrypt-staging-private-key',
              },
              solvers: [
                {
                  dns01: {
                    route53: {
                      region: CONFIG.aws.region,
                      hostedZoneID: CONFIG.aws.hostedZoneId,
                    },
                  },
                },
              ],
            },
          },
          id: 'clusterIssuer',
        });

        return {
          ready:
            clusterIssuer.status.conditions?.some(
              (c) => c.type === 'Ready' && c.status === 'True'
            ) || false,
        };
      }
    );

    const clusterIssuerFactory = clusterIssuerComposition.factory('direct', {
      namespace: 'default',
      skipTLSVerify: true,
      timeout: 120000,
      waitForReady: true,
    });

    await clusterIssuerFactory.deploy({ ready: true });
    console.log('✅ ClusterIssuer created successfully!');
    console.log('');

    // Step 5: Deploy Webapp Composition (Kro Mode)
    console.log('🌟 Step 5: Deploying Webapp Composition (with automatic TLS certificate)...');
    const webappFactory = webappComposition.factory('kro', {
      namespace: 'default',
      skipTLSVerify: true,
      timeout: 600000,
      waitForReady: true,
      eventMonitoring: {
        enabled: true,
        eventTypes: ['Warning', 'Error', 'Normal'],
        includeChildResources: true,
      },
      progressCallback: (event) => {
        console.log(`📡 Webapp: ${event.message}`);
      },
    });

    const webappInstance = await webappFactory.deploy({
      domain: FULL_DOMAIN,
      replicas: 2,
      image: 'nginx:alpine',
    });

    console.log('✅ Webapp composition deployed successfully!');
    console.log(`📋 Webapp Status:`, webappInstance.status);
    console.log('');

    // Step 6: Test with curl
    console.log('🧪 Step 6: Testing with curl...');
    console.log('⏳ Waiting 120 seconds for DNS propagation and certificate issuance...');
    await new Promise((resolve) => setTimeout(resolve, 120000));

    try {
      const { execFileSync } = await import('node:child_process');
      const curlResult = execFileSync(
        'curl',
        ['-s', '-o', '/dev/null', '-w', '%{http_code}', `https://${FULL_DOMAIN}`],
        {
          encoding: 'utf8',
          timeout: 30000,
        }
      );

      if (curlResult.trim() === '200') {
        console.log('✅ Webapp is accessible via HTTPS!');
        console.log(`🎉 Success! Visit https://${FULL_DOMAIN} in your browser`);
      } else {
        console.log(`⚠️  Webapp returned HTTP ${curlResult.trim()}`);
        console.log(`🔍 Try visiting https://${FULL_DOMAIN} manually`);
      }
    } catch (_error) {
      console.log('⚠️  Could not test with curl, but deployment completed');
      console.log(`🔍 Try visiting https://${FULL_DOMAIN} manually`);
    }

    console.log('');
    console.log('🎊 Complete TypeKro Demo Finished Successfully!');
    console.log('============================================');
    console.log('📋 What was deployed:');
    console.log('  ✅ TypeKro Runtime (Flux + Kro) - Direct Mode');
    console.log('  ✅ cert-manager - Direct Mode');
    console.log('  ✅ external-dns - Direct Mode');
    console.log('  ✅ ClusterIssuer for DNS-01 challenges - Direct Mode');
    console.log('  ✅ Webapp Composition - Kro Mode');
    console.log('    - Nginx deployment with service and ingress');
    console.log('    - Automatic TLS certificate via cert-manager');
    console.log('    - Automatic DNS record via external-dns');
    console.log('');
    console.log(`🌐 Your webapp: https://${FULL_DOMAIN}`);
    console.log('');
    console.log('🧹 To clean up:');
    console.log('  kubectl delete resourcegraphdefinition --all');
    console.log('  kubectl delete namespace cert-manager external-dns flux-system kro-system');
  } catch (error) {
    console.error('❌ Deployment failed:', error);
    process.exit(1);
  }
}

// Run the demo if this script is executed directly
if (import.meta.main) {
  deployCompleteStack().catch((error) => {
    console.error('❌ Demo failed:', error);
    process.exit(1);
  });
}

export { deployCompleteStack, webappComposition };
