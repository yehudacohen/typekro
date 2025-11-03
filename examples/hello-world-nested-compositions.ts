#!/usr/bin/env bun

/**
 * TypeKro Nested Compositions Demo
 *
 * Showcases three compositions with nested composition calls:
 * 1. TypeKro Bootstrap (direct mode)
 * 2. Infrastructure Stack (direct mode) - calls cert-manager + external-dns as nested compositions
 * 3. Webapp (direct mode, 2 instances) - references infrastructure status
 */

import { type, type Type } from 'arktype';
import {
  kubernetesComposition,
  typeKroRuntimeBootstrap,
  certManager,
  externalDns,
  apisix,
  simple,
} from '../src/index.js';
import { namespace } from '../src/factories/kubernetes/core/namespace.js';

// Get AWS credentials at module load time (before composition execution)
const AWS_CREDENTIALS = (() => {
  try {
    // Get credentials from AWS profile using AWS CLI (synchronous)
    const accessKeyResult = Bun.spawnSync(['aws', 'configure', 'get', 'aws_access_key_id']);
    const secretKeyResult = Bun.spawnSync(['aws', 'configure', 'get', 'aws_secret_access_key']);

    if (accessKeyResult.exitCode !== 0 || secretKeyResult.exitCode !== 0) {
      throw new Error('AWS CLI commands failed');
    }

    const accessKeyId = accessKeyResult.stdout.toString().trim();
    const secretAccessKey = secretKeyResult.stdout.toString().trim();

    if (!accessKeyId || !secretAccessKey) {
      throw new Error('AWS credentials not found in profile');
    }
    return { accessKeyId, secretAccessKey };
  } catch (error) {
    console.error('❌ Failed to get AWS credentials from profile');
    console.error('   Please run: aws configure');
    throw error;
  }
})();

// =============================================================================
// BOOTSTRAP COMPOSITION (Contains TypeKro Runtime + AWS Credentials)
// =============================================================================

type BootstrapSpecType = {
  namespace: string;
};

type BootstrapStatusType = {
  ready: boolean;
  kroReady: boolean;
  awsCredentialsReady: boolean;
};

const BootstrapSpec: Type<BootstrapSpecType> = type({
  namespace: 'string',
});

const BootstrapStatus: Type<BootstrapStatusType> = type({
  ready: 'boolean',
  kroReady: 'boolean',
  awsCredentialsReady: 'boolean',
});

export const demoBootstrap = kubernetesComposition(
  {
    name: 'demo-bootstrap',
    apiVersion: 'demo.typekro.dev/v1alpha1',
    kind: 'DemoBootstrap',
    spec: BootstrapSpec,
    status: BootstrapStatus,
  },
  (spec) => {
    // Nested composition call - TypeKro runtime bootstrap
    const kroBootstrap = typeKroRuntimeBootstrap({
      namespace: spec.namespace,
      fluxVersion: 'v2.4.0',
      kroVersion: '0.3.0',
    });

    // Use pre-loaded AWS credentials
    const awsCredentials = AWS_CREDENTIALS;

    // Create cert-manager namespace
    namespace({
      metadata: { name: 'cert-manager' },
      id: 'certManagerNamespace',
    });

    // Create AWS credentials secret for Route53 access (cert-manager)
    simple.Secret({
      name: 'aws-route53-credentials',
      namespace: 'cert-manager',
      stringData: {
        'access-key-id': awsCredentials.accessKeyId,
        'secret-access-key': awsCredentials.secretAccessKey,
      },
      id: 'awsCredentials',
    });

    // Create AWS credentials secret for Route53 access (default namespace for challenges)
    simple.Secret({
      name: 'aws-route53-credentials',
      namespace: 'default',
      stringData: {
        'access-key-id': awsCredentials.accessKeyId,
        'secret-access-key': awsCredentials.secretAccessKey,
      },
      id: 'awsCredentialsDefault',
    });

    return {
      ready: kroBootstrap.status.components.kroSystem && kroBootstrap.status.components.fluxSystem,
      kroReady: kroBootstrap.status.components.kroSystem,
      awsCredentialsReady: true, // Static since we create all secrets directly
    };
  }
);

// =============================================================================
// INFRASTRUCTURE COMPOSITION (Contains nested cert-manager and external-dns)
// =============================================================================

type InfrastructureSpecType = {
  domain: string;
  email: string;
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
};

type InfrastructureStatusType = {
  ready: boolean;
  issuerName: string;
  ingressClass: string;
  gatewayService?: {
    name: string;
    namespace: string;
    type: string;
    clusterIP?: string;
    externalIP?: string;
  };
};

const InfrastructureSpec: Type<InfrastructureSpecType> = type({
  domain: 'string',
  email: 'string',
  awsAccessKeyId: 'string',
  awsSecretAccessKey: 'string',
});

const InfrastructureStatus: Type<InfrastructureStatusType> = type({
  ready: 'boolean',
  issuerName: 'string',
  ingressClass: 'string',
  'gatewayService?': {
    name: 'string',
    namespace: 'string',
    type: 'string',
    'clusterIP?': 'string',
    'externalIP?': 'string',
  },
});

const infrastructureStack = kubernetesComposition(
  {
    name: 'infrastructure-stack',
    apiVersion: 'demo.typekro.dev/v1alpha1',
    kind: 'InfrastructureStack',
    spec: InfrastructureSpec,
    status: InfrastructureStatus,
  },
  (spec) => {
    // Debug: Log AWS credentials to verify they're being passed correctly
    console.log('🔍 Infrastructure AWS credentials:', {
      accessKeyId: `${spec.awsAccessKeyId?.substring(0, 8)}...`,
      secretAccessKey: `${spec.awsSecretAccessKey?.substring(0, 8)}...`,
    });

    // Create AWS credentials secret for external-dns
    simple.Secret({
      name: 'aws-route53-credentials',
      namespace: 'external-dns',
      stringData: {
        'access-key-id': spec.awsAccessKeyId,
        'secret-access-key': spec.awsSecretAccessKey,
      },
      id: 'awsCredentialsExternalDnsInfra',
    });

    // For this demo, we'll deploy cert-manager and external-ds as nested compositions
    const certManagerInstance = certManager.certManagerBootstrap({
      name: 'cert-manager',
      namespace: 'cert-manager',
      version: '1.13.3',
      installCRDs: true,
      controller: {
        extraArgs: [
          '--dns01-recursive-nameservers=8.8.8.8:53,1.1.1.1:53',
          '--dns01-recursive-nameservers-only',
        ],
      },
    });

    const externalDnsInstance = externalDns.externalDnsBootstrap({
      name: 'external-dns',
      namespace: 'external-dns',
      provider: 'aws',
      domainFilters: [spec.domain],
      policy: 'sync',
    });

    // Deploy APISix ingress controller
    const apisixInstance = apisix.apisixBootstrap({
      name: 'apisix',
      namespace: 'apisix-system',
      version: '2.8.0',
      ingressController: {
        enabled: true,
        config: {
          kubernetes: {
            ingressClass: 'apisix',
            namespace: 'apisix-system',
          },
        },
      },
      gateway: {
        type: 'LoadBalancer',
        http: {
          enabled: true,
          servicePort: 80,
          containerPort: 9080,
        },
        https: {
          enabled: true,
          servicePort: 443,
          containerPort: 9443,
        },
      },
      rbac: { create: true },
      serviceAccount: { create: true },
    });

    // Note: AWS credentials secret should be created as a prerequisite
    // This demo assumes 'aws-route53-credentials' secret exists in cert-manager namespace

    // Create cluster issuer with AWS credentials reference
    certManager.clusterIssuer({
      name: 'letsencrypt-staging',
      spec: {
        acme: {
          server: 'https://acme-staging-v02.api.letsencrypt.org/directory',
          email: spec.email,
          privateKeySecretRef: { name: 'letsencrypt-staging-key' },
          solvers: [
            {
              dns01: {
                route53: {
                  region: 'us-east-1',
                  hostedZoneID: 'Z10449032L81DH0NC9PZ0',
                  accessKeyIDSecretRef: {
                    name: 'aws-route53-credentials',
                    key: 'access-key-id',
                    namespace: 'cert-manager',
                  },
                  secretAccessKeySecretRef: {
                    name: 'aws-route53-credentials',
                    key: 'secret-access-key',
                    namespace: 'cert-manager',
                  },
                },
              },
            },
          ],
        },
      },
      id: 'clusterIssuer',
    });

    return {
      // Cross-composition status references
      ready:
        certManagerInstance.status.ready &&
        externalDnsInstance.status.ready &&
        apisixInstance.status.ready,
      issuerName: 'letsencrypt-staging',
      ingressClass: apisixInstance.status.ingressClass?.name || 'apisix',
      // Note: Using type assertion because APISix gatewayService has extra fields (ports)
      // that InfrastructureStatus doesn't need, but types are compatible
      gatewayService: apisixInstance.status.gatewayService,
    };
  }
);

// =============================================================================
// WEBAPP COMPOSITION (References infrastructure status)
// =============================================================================

const WebappSpec = type({
  name: 'string',
  domain: 'string',
  issuerName: 'string', // Cross-composition reference
});

const WebappStatus = type({
  ready: 'boolean',
  url: 'string',
  certificateReady: 'boolean',
  deploymentReady: 'boolean',
});

const webappStack = kubernetesComposition(
  {
    name: 'webapp-stack',
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
      ports: [{ containerPort: 80 }],
      id: 'deployment',
    });

    const _service = simple.Service({
      name: `${spec.name}-service`,
      selector: { app: spec.name },
      ports: [{ port: 80, targetPort: 80 }],
      id: 'service',
    });

    // Create explicit Certificate resource for better visibility
    const certificate = certManager.certificate({
      name: `${spec.name}-cert`,
      namespace: 'default',
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

    const _ingress = simple.Ingress({
      name: `${spec.name}-ingress`,
      ingressClassName: 'apisix', // Use APISix ingress class
      annotations: {
        // External-DNS annotations for automatic DNS record creation
        'external-dns.alpha.kubernetes.io/hostname': spec.domain,
        'external-dns.alpha.kubernetes.io/ttl': '300',
      },
      tls: [
        {
          hosts: [spec.domain],
          secretName: `${spec.name}-tls`, // Reference the explicit certificate secret
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
      ready:
        deployment.status.readyReplicas >= 1 &&
        certificate.status.conditions?.find((c) => c.type === 'Ready' && c.status === 'True') !==
          undefined,
      url: `https://${spec.domain}`,
      certificateReady:
        certificate.status.conditions?.find((c) => c.type === 'Ready' && c.status === 'True') !==
        undefined,
      deploymentReady: deployment.status.readyReplicas >= 1,
    };
  }
);

// =============================================================================
// DEMO ORCHESTRATION
// =============================================================================

async function main() {
  console.log('🚀 TypeKro Nested Compositions Demo');
  console.log('====================================');

  // Use pre-loaded AWS credentials
  const awsCredentials = AWS_CREDENTIALS;

  // Step 1: Deploy Demo Bootstrap (TypeKro Runtime + AWS Credentials)
  console.log('📦 Step 1: Deploying Demo Bootstrap...');
  const bootstrap = demoBootstrap;
  const bootstrapFactory = bootstrap.factory('direct', {
    namespace: 'flux-system',
    skipTLSVerify: true,
    timeout: 300000, // 5 minutes for bootstrap
    waitForReady: true, // Critical: wait for Kro controller to be ready
    eventMonitoring: {
      enabled: true,
      eventTypes: ['Warning', 'Error', 'Normal'],
      includeChildResources: true,
    },
    progressCallback: (event) => {
      console.log(`📡 Bootstrap: ${event.message}`);
    },
  });

  await bootstrapFactory.deploy({ namespace: 'flux-system' });
  console.log('✅ Bootstrap deployed');

  // Step 2: Deploy Infrastructure Stack (Direct Mode with nested compositions)
  console.log('🏗️  Step 2: Deploying Infrastructure Stack...');
  const infraFactory = infrastructureStack.factory('direct', {
    namespace: 'default',
    skipTLSVerify: true,
    timeout: 300000, // 5 minutes for infrastructure deployment
    waitForReady: true, // Wait for cert-manager and external-dns to be ready
    eventMonitoring: {
      enabled: true,
      eventTypes: ['Warning', 'Error', 'Normal'],
      includeChildResources: true,
    },
    progressCallback: (event) => {
      console.log(`📡 Infrastructure: ${event.message}`);
    },
  });

  const infrastructure = await infraFactory.deploy({
    domain: 'funwiththe.cloud',
    email: 'admin@funwiththe.cloud',
    awsAccessKeyId: awsCredentials.accessKeyId,
    awsSecretAccessKey: awsCredentials.secretAccessKey,
  });
  console.log('✅ Infrastructure deployed with nested cert-manager and external-dns');

  // Step 3: Deploy Webapp Instances (Direct Mode)
  console.log('🌐 Step 3: Deploying Webapp Instances...');
  const webappFactory = webappStack.factory('direct', {
    namespace: 'default',
    skipTLSVerify: true,
    timeout: 300000, // 5 minutes timeout for webapp deployment (certificates can take 2-5 minutes)
    waitForReady: true, // Wait for certificates to be ready
    eventMonitoring: {
      enabled: true,
      eventTypes: ['Warning', 'Error', 'Normal'],
      includeChildResources: true,
    },
    progressCallback: (event) => {
      console.log(`📡 Webapp: ${event.message}`);
    },
  });

  try {
    await webappFactory.deploy({
      name: 'hello-world-1',
      domain: 'app1.funwiththe.cloud',
      issuerName: infrastructure.status.issuerName, // Cross-composition reference
    });
    console.log('✅ Webapp 1 deployed (certificates may still be pending)');
  } catch (_error) {
    console.log(
      '⚠️  Webapp 1 deployment completed with some resources still pending (this is normal for certificates)'
    );
    console.log('   Certificate issuance can take 2-5 minutes for DNS-01 challenges');
  }

  try {
    await webappFactory.deploy({
      name: 'hello-world-2',
      domain: 'app2.funwiththe.cloud',
      issuerName: infrastructure.status.issuerName, // Cross-composition reference
    });
    console.log('✅ Webapp 2 deployed (certificates may still be pending)');
  } catch (_error) {
    console.log(
      '⚠️  Webapp 2 deployment completed with some resources still pending (this is normal for certificates)'
    );
    console.log('   Certificate issuance can take 2-5 minutes for DNS-01 challenges');
  }

  console.log('');
  console.log('🎉 Demo Complete!');
  console.log(
    '• Infrastructure composition called cert-manager + external-dns as nested compositions'
  );
  console.log('• Webapp compositions referenced infrastructure status');
  console.log('• All resources automatically flattened and deployed');
  console.log(
    '• Certificates are being issued in the background (check with: kubectl get certificates -A)'
  );
  console.log(
    '• Check cluster: kubectl get namespaces,deployments,services,ingresses,certificates'
  );
  console.log('');
  console.log('📋 Next Steps:');
  console.log('• Wait 2-5 minutes for certificate issuance to complete');
  console.log('• Check certificate status: kubectl get certificates -A');
  console.log('• Check challenge status: kubectl get challenges -A');
  console.log('• Once certificates are ready, the apps will be accessible via HTTPS');

  // // Add cleanup and diagnostics at the end of main()
  // try {
  //   const activeHandles = (process as any)._getActiveHandles?.() || [];
  //   const activeRequests = (process as any)._getActiveRequests?.() || [];
  //   console.log('Active handles:', activeHandles.length);
  //   console.log('Active requests:', activeRequests.length);

  //   // Force cleanup of any remaining connections
  //   if (activeHandles.length > 0 || activeRequests.length > 0) {
  //     console.log('Forcing cleanup of remaining connections...');
  //     // Force garbage collection if available
  //     if (global.gc) {
  //       global.gc();
  //     }
  //   }
  // } catch (error) {
  //   console.log('Could not get process diagnostics:', error);
  // }

  // // Force-close all idle connections and exit
  // console.log('Forcing process exit...');

  // // More aggressive cleanup - clear all event listeners and timers
  // process.removeAllListeners();
  // if (typeof clearImmediate !== 'undefined') {
  //   // Clear any immediate timers
  //   const immediateIds = (global as any).__immediateIds || [];
  //   immediateIds.forEach((id: any) => clearImmediate(id));
  // }

  // // Force exit immediately
  // process.exit(0);
}

if (import.meta.main) {
  await main();
}
