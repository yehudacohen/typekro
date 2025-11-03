#!/usr/bin/env bun

/**
 * Graceful Exit Demo
 *
 * This example demonstrates that TypeKro now exits gracefully without hanging
 * when the process is terminated, even when there are active Kubernetes watch connections.
 *
 * The key improvements:
 * 1. Aggressive forceCleanup method that uses socket.unref() and socket.destroy()
 * 2. No global error suppression needed
 * 3. Clean, targeted solution that prevents hanging
 *
 * Run this example and then press Ctrl+C - it should exit immediately without hanging.
 */

import { simple, toResourceGraph } from '../src/index.js';
import { type } from 'arktype';
import { KubernetesClientProvider } from '../src/core/kubernetes/client-provider.js';

async function main() {
  console.log('🚀 Starting Graceful Exit Demo');
  console.log('📝 This demo shows that TypeKro exits cleanly without hanging');
  console.log('⏹️  Press Ctrl+C to test graceful exit behavior\n');

  try {
    // Initialize Kubernetes client
    const clientProvider = KubernetesClientProvider.createInstance();

    // Try to initialize - this might fail in environments without kubeconfig
    try {
      clientProvider.initialize();
      console.log('✅ Connected to Kubernetes cluster');
    } catch (_error) {
      console.log('⚠️  No Kubernetes cluster available, using mock configuration');
      console.log('   (This is fine for demonstrating the exit behavior)\n');
    }

    // Define schemas using arktype
    const DemoSpec = type({
      name: 'string',
      image: 'string',
      replicas: 'number',
    });

    const DemoStatus = type({
      ready: 'boolean',
    });

    // Create a simple deployment composition
    const demoComposition = toResourceGraph(
      {
        name: 'demo-app',
        apiVersion: 'examples.typekro.dev/v1alpha1',
        kind: 'DemoApp',
        spec: DemoSpec,
        status: DemoStatus,
      },
      (schema) => ({
        deployment: simple.Deployment({
          name: schema.spec.name,
          image: schema.spec.image,
          replicas: schema.spec.replicas,
          id: 'demo-deployment',
        }),
      }),
      (_schema, _resources) => ({
        ready: true,
      })
    );

    console.log('📦 Created deployment composition');
    console.log('🔄 Starting deployment process...\n');

    // Create a direct factory and deploy
    const factory = demoComposition.factory('direct', {
      namespace: 'default',
      waitForReady: true,
      eventMonitoring: { enabled: true }, // This creates watch connections that need cleanup
    });

    // Start the deployment (this will create watch connections)
    const deploymentPromise = factory.deploy({
      name: 'demo-app',
      image: 'nginx:latest',
      replicas: 1,
    });

    console.log('🎯 Deployment started with event monitoring');
    console.log('📡 Watch connections are now active');
    console.log('⏹️  Press Ctrl+C now to test graceful exit\n');

    // Wait a bit to let connections establish
    await new Promise((resolve) => setTimeout(resolve, 2000));

    console.log('✨ Demo running successfully');
    console.log('🔍 Active connections are being monitored');
    console.log('⏹️  Press Ctrl+C to see graceful exit in action\n');

    // Keep the process alive to demonstrate the exit behavior
    const keepAlive = setInterval(() => {
      console.log('💓 Demo still running... (Press Ctrl+C to exit gracefully)');
    }, 5000);

    // Handle the deployment promise (might fail due to no cluster, that's OK)
    try {
      await deploymentPromise;
      console.log('🎉 Deployment completed successfully');
    } catch (_error) {
      console.log('⚠️  Deployment failed (expected without real cluster)');
      console.log('   The important thing is that exit will be graceful\n');
    }

    // Clean up the interval
    clearInterval(keepAlive);
  } catch (error) {
    console.error('❌ Demo error:', error);
    console.log('\n⏹️  Press Ctrl+C to test graceful exit despite the error');

    // Keep process alive even on error to test exit behavior
    setInterval(() => {
      console.log('💓 Demo still running after error... (Press Ctrl+C to exit gracefully)');
    }, 5000);
  }
}

// Note: No manual cleanup handlers needed!
// The KubernetesClientProvider automatically registers cleanup handlers
// when initialized, so the process will exit gracefully without any
// additional code required.

console.log('📝 Note: Cleanup handlers are registered automatically');
console.log('⏹️  Press Ctrl+C to test automatic graceful exit\n');

main().catch((error) => {
  console.error('❌ Main function error:', error);
  process.exit(1);
});
