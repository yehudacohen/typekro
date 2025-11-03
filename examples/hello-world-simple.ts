#!/usr/bin/env bun
// @ts-nocheck

/**
 * Simple Hello World Example with TypeKro
 * 
 * This example demonstrates TypeKro basics without external dependencies:
 * 1. TypeKro runtime bootstrap (direct mode)
 * 2. Simple webapp deployment (Kro mode)
 * 3. Event monitoring integration
 * 
 * Prerequisites:
 * - kubectl connected to a cluster
 * 
 * Usage:
 *   bun run examples/hello-world-simple.ts
 */

import { type } from 'arktype';
import { kubernetesComposition, simple } from '../src/index.js';
import { typeKroRuntimeBootstrap } from '../src/core/composition/typekro-runtime/index.js';

// Schema for our simple webapp
const SimpleWebappSpec = type({
  name: 'string',
  replicas: 'number',
  'image?': 'string',
});

const SimpleWebappStatus = type({
  ready: 'boolean',
  replicas: 'number',
  serviceReady: 'boolean',
});

// Simple Webapp Composition
const simpleWebapp = kubernetesComposition(
  {
    name: 'simple-webapp',
    apiVersion: 'examples.typekro.dev/v1alpha1',
    kind: 'SimpleWebapp',
    spec: SimpleWebappSpec,
    status: SimpleWebappStatus,
  },
  (spec) => {
    console.log(`🚀 Deploying simple webapp: ${spec.name}`);

    // Create the webapp deployment
    const deployment = simple.Deployment({
      name: spec.name,
      namespace: 'default',
      image: spec.image || 'nginx:alpine',
      replicas: spec.replicas,
      ports: [{ containerPort: 80 }],
      id: 'webapp'
    });

    // Create service to expose the deployment
    const service = simple.Service({
      name: `${spec.name}-service`,
      namespace: 'default',
      selector: { app: spec.name },
      ports: [{ port: 80, targetPort: 80 }],
      type: 'LoadBalancer',
      id: 'service'
    });

    // Return status expressions using actual resource status
    return {
      ready: deployment.status.readyReplicas >= spec.replicas,
      replicas: deployment.status.readyReplicas || 0,
      serviceReady: (service.status.loadBalancer?.ingress?.length || 0) > 0,
    };
  }
);

async function deploySimpleStack() {
  console.log('🌟 Starting Simple Hello World TypeKro Demo');
  console.log('==========================================');
  console.log('');

  try {
    // Step 1: Bootstrap TypeKro Runtime (Direct Mode)
    console.log('🚀 Step 1: Bootstrapping TypeKro Runtime...');
    const runtimeFactory = typeKroRuntimeBootstrap.factory('direct', {
      namespace: 'default',
      skipTLSVerify: true,
      timeout: 300000,
      waitForReady: true,
      eventMonitoring: {
        enabled: true,
        eventTypes: ['Warning', 'Error', 'Normal'],
        includeChildResources: true
      },
      progressCallback: (event: any) => {
        console.log(`📡 Runtime: ${event.message}`);
      }
    });

    await runtimeFactory.deploy({ 
      namespace: 'flux-system',
      fluxVersion: 'v2.4.0',
      kroVersion: '0.3.0'
    });
    console.log('✅ TypeKro Runtime deployed successfully!');
    console.log('');

    // Step 2: Deploy Simple Webapp (Kro Mode)
    console.log('🌟 Step 2: Deploying Simple Webapp...');
    const webappFactory = await simpleWebapp.factory('kro', {
      namespace: 'default',
      skipTLSVerify: true,
      timeout: 300000,
      waitForReady: true,
      eventMonitoring: {
        enabled: true,
        eventTypes: ['Warning', 'Error', 'Normal'],
        includeChildResources: true
      },
      progressCallback: (event: any) => {
        console.log(`📡 Webapp: ${event.message}`);
      }
    });

    const webappInstance = await webappFactory.deploy({
      name: 'hello-world',
      replicas: 2,
      image: 'nginx:alpine'
    });

    console.log('✅ Simple Webapp deployed successfully!');
    console.log('');

    // Step 3: Get service information
    console.log('🔍 Step 3: Getting service information...');
    console.log(`📋 Webapp Status:`, webappInstance.status);
    
    // Get the LoadBalancer IP
    const { getKubeConfig } = await import('../src/core/kubernetes/client-provider.js');
    const kc = getKubeConfig({ skipTLSVerify: true });
    const { CoreV1Api } = await import('@kubernetes/client-node');
    const k8sApi = kc.makeApiClient(CoreV1Api);
    
    try {
      const service = await k8sApi.readNamespacedService('hello-world-service', 'default');
      const loadBalancer = service.body.status?.loadBalancer;
      const ingress = loadBalancer?.ingress?.[0];
      
      if (ingress) {
        const endpoint = ingress.ip || ingress.hostname;
        console.log(`🌐 Service endpoint: http://${endpoint}`);
        
        // Test with curl
        console.log('🧪 Testing with curl...');
        try {
          const { execSync } = await import('node:child_process');
          const curlResult = execSync(`curl -s -o /dev/null -w "%{http_code}" http://${endpoint}`, { 
            encoding: 'utf8',
            timeout: 10000 
          });
          
          if (curlResult.trim() === '200') {
            console.log('✅ Webapp is accessible!');
          } else {
            console.log(`⚠️  Webapp returned HTTP ${curlResult.trim()}`);
          }
        } catch (_error) {
          console.log('⚠️  Could not test with curl');
        }
      } else {
        console.log('⏳ LoadBalancer endpoint not yet available');
        console.log('   Run: kubectl get service hello-world-service -w');
      }
    } catch (_error) {
      console.log('⚠️  Could not get service information');
    }

    console.log('');
    console.log('🎊 Simple TypeKro Demo Finished Successfully!');
    console.log('=========================================');
    console.log('📋 What was deployed:');
    console.log('  ✅ TypeKro Runtime (Flux + Kro)');
    console.log('  ✅ Hello World Webapp');
    console.log('  ✅ LoadBalancer Service');
    console.log('');
    console.log('🔍 To inspect:');
    console.log('  kubectl get resourcegraphdefinition');
    console.log('  kubectl get pods,services');
    console.log('');
    console.log('🧹 To clean up:');
    console.log('  kubectl delete resourcegraphdefinition --all');
    console.log('  kubectl delete namespace flux-system kro');

  } catch (error) {
    console.error('❌ Deployment failed:', error);
    process.exit(1);
  }
}

// Run the demo if this script is executed directly
if (import.meta.main) {
  deploySimpleStack().catch((error) => {
    console.error('❌ Demo failed:', error);
    process.exit(1);
  });
}

export { deploySimpleStack, simpleWebapp };