#!/usr/bin/env bun
/**
 * Interactive Kro Controller Debugging Script
 * 
 * This script helps debug why RGDs aren't being processed by the Kro controller
 * by deploying a simple RGD and monitoring the cluster state in real-time.
 */

import { type } from 'arktype';
import * as k8s from '@kubernetes/client-node';
import { toResourceGraph, simpleDeployment, simpleService } from '../src/index.js';

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
  
  // Set up Kubernetes client with TLS verification disabled for kind
  const kubeConfig = new k8s.KubeConfig();
  kubeConfig.loadFromDefault();
  
  // Disable TLS verification for kind clusters
  const cluster = kubeConfig.getCurrentCluster();
  if (cluster) {
    // Note: skipTLSVerify is read-only, would need to modify cluster config
    console.log('Using cluster:', cluster.name);
  }
  
  const k8sApi = kubeConfig.makeApiClient(k8s.KubernetesObjectApi);
  const customObjectsApi = kubeConfig.makeApiClient(k8s.CustomObjectsApi);
  
  console.log('📋 Current cluster context:', kubeConfig.getCurrentContext());
  
  // Create a simple resource graph
  console.log('\n📝 Creating TypeKro resource graph...');
  const webappGraph = toResourceGraph(
    {
      name: 'debug-webapp',
      apiVersion: 'v1alpha1',
      kind: 'DebugWebApp',
      spec: WebAppSpecSchema,
      status: WebAppStatusSchema,
    },
    (schema) => ({
      webappDeployment: simpleDeployment({
        id: 'webappDeployment',
        name: schema.spec.name,
        image: schema.spec.image,
        replicas: schema.spec.replicas,
        ports: [{ name: 'http', containerPort: 3000, protocol: 'TCP' }],
      }),
      webappService: simpleService({
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

  // Generate RGD YAML
  console.log('\n📄 Generated RGD YAML:');
  const rgdYaml = webappGraph.toYaml();
  console.log(rgdYaml);
  
  // Parse the YAML to get the RGD object
  const rgdManifests = k8s.loadAllYaml(rgdYaml);
  const rgdManifest = rgdManifests[0] as k8s.KubernetesObject & {
    spec?: {
      schema?: {
        kind?: string;
        status?: Record<string, unknown>;
      };
      resources?: unknown[];
    };
  };
  
  if (!rgdManifest) {
    console.error('❌ Failed to parse RGD YAML');
    return;
  }
  
  console.log('\n🔍 RGD Manifest structure:');
  console.log('- apiVersion:', rgdManifest.apiVersion);
  console.log('- kind:', rgdManifest.kind);
  console.log('- metadata.name:', rgdManifest.metadata?.name);
  console.log('- metadata.namespace:', rgdManifest.metadata?.namespace);
  console.log('- spec.schema.kind:', rgdManifest.spec?.schema?.kind);
  console.log('- spec.resources.length:', rgdManifest.spec?.resources?.length);
  
  // Debug the status expressions
  console.log('\n🔍 Status expressions:');
  const statusExpressions = rgdManifest.spec?.schema?.status;
  if (statusExpressions) {
    for (const [field, expression] of Object.entries(statusExpressions)) {
      console.log(`- ${field}: ${expression}`);
    }
  }
  
  try {
    // Clean up any existing RGD first
    console.log('\n🧹 Cleaning up any existing RGD...');
    try {
      await k8sApi.delete(rgdManifest);
      console.log('✅ Existing RGD deleted');
      await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for deletion
    } catch (_error) {
      console.log('ℹ️ No existing RGD to delete (this is fine)');
    }
    
    // Apply the RGD to the cluster
    console.log('\n🚀 Applying RGD to cluster...');
    const appliedRgd = await k8sApi.create(rgdManifest);
    console.log('✅ RGD applied successfully');
    console.log('- Resource version:', appliedRgd.body.metadata?.resourceVersion);
    console.log('- UID:', appliedRgd.body.metadata?.uid);
    
    // Wait a moment for processing
    console.log('\n⏳ Waiting 5 seconds for Kro controller to process...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Check RGD status
    console.log('\n🔍 Checking RGD status...');
    try {
      const rgdStatus = await customObjectsApi.getNamespacedCustomObject(
        'kro.run',
        'v1alpha1',
        rgdManifest.metadata?.namespace || 'default',
        'resourcegraphdefinitions',
        rgdManifest.metadata?.name || 'debug-webapp'
      );
      
      console.log('📊 RGD Status:');
      const status = (rgdStatus.body as { status?: { state?: string; phase?: string; conditions?: Array<{ type: string; status: string; message?: string }>; observedGeneration?: number } }).status;
      if (status) {
        console.log('- Phase:', status.phase);
        console.log('- Conditions:', JSON.stringify(status.conditions, null, 2));
        console.log('- Observed generation:', status.observedGeneration);
      } else {
        console.log('- No status found (controller may not have processed yet)');
      }
    } catch (error) {
      console.log('⚠️ Could not get RGD status:', (error as Error).message);
    }
    
    // Check if CRD was created
    console.log('\n🔍 Checking if CRD was created...');
    try {
      const apiExtensionsApi = kubeConfig.makeApiClient(k8s.ApiextensionsV1Api);
      const crds = await apiExtensionsApi.listCustomResourceDefinition();
      
      const debugWebAppCrd = crds.body.items.find(crd => 
        crd.spec.names.kind === 'DebugWebApp' || 
        crd.metadata?.name?.includes('debugwebapp')
      );
      
      if (debugWebAppCrd) {
        console.log('✅ CRD found:');
        console.log('- Name:', debugWebAppCrd.metadata?.name);
        console.log('- Kind:', debugWebAppCrd.spec.names.kind);
        console.log('- Group:', debugWebAppCrd.spec.group);
        console.log('- Version:', debugWebAppCrd.spec.versions[0]?.name);
      } else {
        console.log('❌ No DebugWebApp CRD found');
        console.log('Available CRDs:');
        crds.body.items.forEach(crd => {
          console.log(`  - ${crd.metadata?.name} (${crd.spec.names.kind})`);
        });
      }
    } catch (error) {
      console.log('⚠️ Could not list CRDs:', (error as Error).message);
    }
    
    // Check Kro controller logs
    console.log('\n📋 Checking Kro controller logs...');
    try {
      const coreApi = kubeConfig.makeApiClient(k8s.CoreV1Api);
      const pods = await coreApi.listNamespacedPod('kro-system');
      const kroPod = pods.body.items.find(pod => pod.metadata?.name?.startsWith('kro-'));
      
      if (kroPod) {
        console.log('🔍 Kro controller pod:', kroPod.metadata?.name);
        try {
          const logs = await coreApi.readNamespacedPodLog(
            kroPod.metadata?.name!,
            'kro-system',
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            50 // Last 50 lines
          );
          
          console.log('📋 Recent Kro controller logs:');
          console.log(logs.body);
        } catch (logError) {
          console.log('⚠️ Could not get logs:', (logError as Error).message);
        }
      } else {
        console.log('❌ No Kro controller pod found');
      }
    } catch (error) {
      console.log('⚠️ Could not check controller logs:', (error as Error).message);
    }
    
    console.log('\n🎯 Next steps for debugging:');
    console.log('1. Check if the RGD has a status.phase field');
    console.log('2. Look at Kro controller logs for any errors');
    console.log('3. Verify the RGD YAML format matches Kro expectations');
    console.log('4. Check if the Kro controller version is compatible');
    
    console.log('\n🔧 Manual debugging commands:');
    console.log(`kubectl get resourcegraphdefinitions -n ${rgdManifest.metadata?.namespace || 'default'}`);
    console.log(`kubectl describe resourcegraphdefinition ${rgdManifest.metadata?.name} -n ${rgdManifest.metadata?.namespace || 'default'}`);
    console.log('kubectl logs -n kro-system deployment/kro');
    console.log('kubectl get crds | grep debugwebapp');
    
  } catch (error) {
    console.error('❌ Failed to apply RGD:', error);
    if (error instanceof Error) {
      console.error('Error details:', error.message);
    }
  }
}

// Run the script
main().catch(console.error);