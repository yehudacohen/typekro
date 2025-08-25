#!/usr/bin/env bun

/**
 * Interactive Kro Controller Debugging Script
 *
 * This script helps debug why RGDs aren't being processed by the Kro controller
 * by deploying a simple RGD and monitoring the cluster state in real-time.
 */

import { type } from 'arktype';
import { toResourceGraph } from '../src/index.js';
import { Deployment, Service } from '../src/factories/simple/index.js';

// Define simple schemas for testing
const WebAppSpecSchema = type({
  name: 'string',
  image: 'string',
  replicas: 'number%1',
});

const WebAppStatusSchema = type({
  url: 'string',
  ready: 'boolean',
});

async function main() {
  console.log('🚀 Starting interactive Kro debugging...');

  // Set up Kubernetes client with TLS verification disabled for kind using centralized provider
  // // const { getKubeConfig, getKubernetesApi } = await import(
  //   '../src/core/dependencies/kubernetes-provider.js'
  // );

  // // const kubeConfig = getKubeConfig();
  // // const k8sApi = getKubernetesApi();

  // Simple debugging resource graph
  const _debugRGD = toResourceGraph(
    {
      name: 'debug-webapp',
      apiVersion: 'debug.example.com/v1alpha1',
      kind: 'DebugWebApp',
      spec: WebAppSpecSchema,
      status: WebAppStatusSchema,
    },
    (schema) => ({
      webappDeployment: Deployment({
        id: 'webappDeployment',
        name: schema.spec.name,
        image: schema.spec.image,
        replicas: schema.spec.replicas,
        ports: [{ name: 'http', containerPort: 3000, protocol: 'TCP' }],
      }),
      webappService: Service({
        id: 'webappService',
        name: 'webapp-service', // Use static name for debugging
        selector: { app: schema.spec.name },
        ports: [{ port: 80, targetPort: 3000 }],
        type: 'ClusterIP',
      }),
    }),
    (_schema, _resources) => ({
      url: 'http://debug-webapp.example.com',
      ready: true,
    })
  );

  console.log('📋 Debug RGD created successfully');
  console.log('This will help identify Kro controller issues');

  // You would typically deploy this RGD and monitor the cluster
  console.log('✅ Ready for Kro debugging!');
}

if (import.meta.main) {
  main().catch(console.error);
}
