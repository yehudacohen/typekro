/**
 * Example: Direct Mode Alchemy Integration with Individual Resource Registration
 * 
 * This example demonstrates the complete Direct mode Alchemy integration pattern
 * where each individual Kubernetes resource gets its own Alchemy resource type
 * registration and tracking. This is different from Kro mode which registers
 * RGDs and instances.
 * 
 * ## Key Concepts Demonstrated:
 * 
 * 1. **Individual Resource Registration**: Each Kubernetes resource (Deployment, Service, etc.)
 *    gets registered as a separate Alchemy resource type (kubernetes::Deployment, kubernetes::Service)
 * 
 * 2. **Resource Type Inference**: Automatic inference of Alchemy resource types from Kubernetes kinds
 * 
 * 3. **DirectResourceFactory with Alchemy**: Using DirectResourceFactory with Alchemy scope
 *    for individual resource deployment and tracking
 * 
 * 4. **Error Handling**: Robust error handling for individual resource failures with detailed context
 * 
 * 5. **State Inspection**: How to inspect individual resources in Alchemy state
 * 
 * 6. **Debugging**: How to debug individual resource deployments and troubleshoot issues
 */

import { type } from 'arktype';
import alchemy from 'alchemy';
import { FileSystemStateStore } from 'alchemy/state';

import {
    toResourceGraph,
    simpleDeployment,
    simpleService,
    simpleConfigMap,
    Cel,
} from '../src/index.js';
import type { AlchemyResourceState } from '../src/alchemy/types.js';

// Define schemas for our web application
const WebAppSpecSchema = type({
    name: 'string',
    image: 'string',
    replicas: 'number%1',
    environment: '"development" | "staging" | "production"',
    enableMetrics: 'boolean',
});

const WebAppStatusSchema = type({
    url: 'string',
    readyReplicas: 'number%1',
    totalReplicas: 'number%1',
    phase: '"pending" | "running" | "failed"',
    metricsEnabled: 'boolean',
});

async function demonstrateDirectModeAlchemyIntegration() {
    console.log('🚀 Direct Mode Alchemy Integration Example');
    console.log('==========================================\n');

    // Step 1: Create Alchemy scope with file system state store
    console.log('1️⃣ Creating Alchemy Scope');
    console.log('==========================');

    const alchemyScope = await alchemy('direct-mode-webapp-demo', {
        stateStore: (scope) => new FileSystemStateStore(scope, { 
            rootDir: './temp/.alchemy/direct-mode-demo' 
        })
    });

    console.log(`✅ Alchemy scope created: ${alchemyScope.name}`);
    console.log(`   State store: FileSystemStateStore`);
    console.log(`   Root directory: ./temp/.alchemy/direct-mode-demo`);
    console.log('');

    // Step 2: Create TypeKro resource graph
    console.log('2️⃣ Creating TypeKro Resource Graph');
    console.log('===================================');

    const webappGraph = toResourceGraph(
        {
            name: 'webapp-stack',
            apiVersion: 'example.com/v1alpha1',
            kind: 'WebApp',
            spec: WebAppSpecSchema,
            status: WebAppStatusSchema,
        },
        // ResourceBuilder - defines individual Kubernetes resources
        (schema) => ({
            // Configuration for the application
            config: simpleConfigMap({
                name: `${schema.spec.name}-config`,
                id: 'appConfig',
                data: {
                    ENVIRONMENT: schema.spec.environment,
                    METRICS_ENABLED: schema.spec.enableMetrics ? 'true' : 'false',
                    APP_NAME: schema.spec.name,
                },
            }),

            // Main application deployment
            deployment: simpleDeployment({
                name: schema.spec.name,
                image: schema.spec.image,
                replicas: schema.spec.replicas,
                id: 'webapp-deployment',
                env: {
                    ENVIRONMENT: schema.spec.environment,
                    METRICS_ENABLED: schema.spec.enableMetrics ? 'true' : 'false',
                },
                ports: [{ name: 'http', containerPort: 3000, protocol: 'TCP' }],
            }),

            // Service to expose the application
            service: simpleService({
                name: `${schema.spec.name}-service`,
                selector: { app: schema.spec.name },
                ports: [{ port: 80, targetPort: 3000 }],
                type: 'LoadBalancer',
                id: 'webapp-service',
            }),
        }),
        // StatusBuilder - defines how status is computed from resources
        (_schema, resources) => ({
            url: resources.service?.status.loadBalancer?.ingress?.[0]?.hostname || 'http://pending',
            readyReplicas: resources.deployment?.status.readyReplicas || 0,
            totalReplicas: resources.deployment?.spec.replicas || 0,
            phase: Cel.expr<'pending' | 'running' | 'failed'>`
                ${resources.deployment?.status.readyReplicas} > 0 ? 'running' : 'pending'
            `,
            metricsEnabled: resources.config?.data?.METRICS_ENABLED === 'true',
        })
    );

    console.log(`✅ Resource graph created: ${webappGraph.name}`);
    console.log(`   Individual resources defined: ${webappGraph.resources.length}`);
    console.log('   Resources:');
    webappGraph.resources.forEach((resource, index) => {
        console.log(`     ${index + 1}. ${resource.kind} - ${resource.metadata?.name || 'unnamed'}`);
    });
    console.log('');

    // Step 3: Create DirectResourceFactory with Alchemy integration
    console.log('3️⃣ Creating DirectResourceFactory with Alchemy');
    console.log('===============================================');

    const directFactory = await webappGraph.factory('direct', {
        namespace: 'webapp-demo',
        alchemyScope: alchemyScope,
        waitForReady: true,
        timeout: 60000,
    });

    console.log(`✅ DirectResourceFactory created:`);
    console.log(`   Mode: ${directFactory.mode}`);
    console.log(`   Namespace: ${directFactory.namespace}`);
    console.log(`   Alchemy managed: ${directFactory.isAlchemyManaged}`);
    console.log(`   Alchemy scope: ${alchemyScope.name}`);
    console.log('');

    // Step 4: Deploy instance through Alchemy with individual resource registration
    console.log('4️⃣ Deploying Instance with Individual Resource Registration');
    console.log('===========================================================');

    await alchemyScope.run(async () => {
        console.log('🔄 Starting deployment within Alchemy scope...');
        console.log('');

        // Deploy the webapp instance
        const webappInstance = await directFactory.deploy({
            name: 'my-webapp',
            image: 'nginx:latest',
            replicas: 2,
            environment: 'production',
            enableMetrics: true,
        });

        console.log(`✅ Webapp instance deployed successfully:`);
        console.log(`   Name: ${webappInstance.metadata?.name}`);
        console.log(`   Namespace: ${webappInstance.metadata?.namespace}`);
        console.log(`   Kind: ${webappInstance.kind}`);
        console.log(`   API Version: ${webappInstance.apiVersion}`);
        console.log('');

        // Step 5: Inspect individual resources in Alchemy state
        console.log('5️⃣ Inspecting Individual Resources in Alchemy State');
        console.log('===================================================');

        const alchemyState = await alchemyScope.state.all();
        const kubernetesResources = Object.entries(alchemyState).filter(
            ([_id, state]: [string, AlchemyResourceState]) => 
                state.kind?.startsWith('kubernetes::')
        );

        console.log(`📊 Individual Kubernetes resources registered in Alchemy:`);
        console.log(`   Total resources: ${kubernetesResources.length}`);
        console.log('');

        kubernetesResources.forEach(([resourceId, resourceState]: [string, AlchemyResourceState], index) => {
            console.log(`   ${index + 1}. Resource ID: ${resourceId}`);
            console.log(`      Alchemy Type: ${resourceState.kind}`);
            console.log(`      Kubernetes Kind: ${resourceState.resource?.kind || 'Unknown'}`);
            console.log(`      Resource Name: ${resourceState.resource?.metadata?.name || 'unnamed'}`);
            console.log(`      Namespace: ${resourceState.namespace}`);
            console.log(`      Status: ${resourceState.ready ? '✅ Ready' : '⏳ Pending'}`);
            console.log(`      Deployed At: ${new Date(resourceState.deployedAt as string).toISOString()}`);
            console.log('');
        });

        // Step 6: Demonstrate resource type patterns
        console.log('6️⃣ Resource Type Patterns');
        console.log('=========================');

        const resourceTypes = [...new Set(kubernetesResources.map(([_id, state]: [string, AlchemyResourceState]) => state.kind))];
        console.log('🏷️  Alchemy resource types registered:');
        resourceTypes.forEach((type, index) => {
            console.log(`   ${index + 1}. ${type}`);
        });
        console.log('');

        console.log('📋 Resource type naming pattern:');
        console.log('   kubernetes::ConfigMap   ← ConfigMap resources');
        console.log('   kubernetes::Deployment  ← Deployment resources');
        console.log('   kubernetes::Service     ← Service resources');
        console.log('');

        console.log('🔄 Individual resource registration benefits:');
        console.log('   ✅ Each Kubernetes resource is tracked individually');
        console.log('   ✅ Fine-grained resource lifecycle management');
        console.log('   ✅ Individual resource status and health monitoring');
        console.log('   ✅ Granular error handling and debugging');
        console.log('   ✅ Resource-specific operations and updates');
        console.log('');

        // Step 7: Demonstrate error handling and debugging
        console.log('7️⃣ Error Handling and Debugging');
        console.log('================================');

        console.log('🔍 Debugging individual resources:');
        console.log('');

        // Show how to find specific resources
        const deploymentResources = kubernetesResources.filter(
            ([_id, state]: [string, AlchemyResourceState]) => state.kind === 'kubernetes::Deployment'
        );
        const serviceResources = kubernetesResources.filter(
            ([_id, state]: [string, AlchemyResourceState]) => state.kind === 'kubernetes::Service'
        );
        const configMapResources = kubernetesResources.filter(
            ([_id, state]: [string, AlchemyResourceState]) => state.kind === 'kubernetes::ConfigMap'
        );

        console.log(`   Deployments: ${deploymentResources.length} found`);
        deploymentResources.forEach(([id, state]: [string, AlchemyResourceState]) => {
            console.log(`     - ${id}: ${state.resource?.metadata?.name} (${state.ready ? 'Ready' : 'Pending'})`);
        });

        console.log(`   Services: ${serviceResources.length} found`);
        serviceResources.forEach(([id, state]: [string, AlchemyResourceState]) => {
            console.log(`     - ${id}: ${state.resource?.metadata?.name} (${state.ready ? 'Ready' : 'Pending'})`);
        });

        console.log(`   ConfigMaps: ${configMapResources.length} found`);
        configMapResources.forEach(([id, state]: [string, AlchemyResourceState]) => {
            console.log(`     - ${id}: ${state.resource?.metadata?.name} (${state.ready ? 'Ready' : 'Pending'})`);
        });
        console.log('');

        // Step 8: Compare with Kro mode
        console.log('8️⃣ Comparison with Kro Mode');
        console.log('===========================');

        console.log('📊 Direct Mode (this example):');
        console.log('   • Each individual Kubernetes resource → Separate Alchemy resource type');
        console.log('   • ConfigMap → kubernetes::ConfigMap');
        console.log('   • Deployment → kubernetes::Deployment');
        console.log('   • Service → kubernetes::Service');
        console.log(`   • Total Alchemy resources: ${kubernetesResources.length} (one per K8s resource)`);
        console.log('');

        console.log('📊 Kro Mode (for comparison):');
        console.log('   • ResourceGraphDefinition → kro::ResourceGraphDefinition');
        console.log('   • WebApp instance → kro::WebApp');
        console.log('   • Total Alchemy resources: 2 (RGD + instance)');
        console.log('');

        console.log('🎯 When to use each mode:');
        console.log('');
        console.log('   Direct Mode:');
        console.log('   ✅ Fine-grained resource control and monitoring');
        console.log('   ✅ Individual resource lifecycle management');
        console.log('   ✅ Detailed debugging and troubleshooting');
        console.log('   ✅ Resource-specific operations and updates');
        console.log('   ❌ More Alchemy resources to manage');
        console.log('');

        console.log('   Kro Mode:');
        console.log('   ✅ Simplified resource management (fewer Alchemy resources)');
        console.log('   ✅ Declarative instance-based approach');
        console.log('   ✅ Built-in dependency resolution via Kro controller');
        console.log('   ❌ Less granular control over individual resources');
        console.log('');

        // Step 9: Demonstrate troubleshooting
        console.log('9️⃣ Troubleshooting Guide');
        console.log('========================');

        console.log('🔧 Common troubleshooting scenarios:');
        console.log('');

        console.log('   Problem: Individual resource deployment fails');
        console.log('   Solution:');
        console.log('   1. Check Alchemy state for the specific resource type');
        console.log('   2. Inspect resource-specific error messages');
        console.log('   3. Verify namespace and cluster connectivity');
        console.log('   4. Check resource configuration and dependencies');
        console.log('');

        console.log('   Problem: Some resources succeed, others fail');
        console.log('   Solution:');
        console.log('   1. Deployment status will be "partial"');
        console.log('   2. Check deployment result errors array');
        console.log('   3. Each error includes resource context (kind, name, type)');
        console.log('   4. Failed resources can be retried individually');
        console.log('');

        console.log('   Problem: Resource type registration conflicts');
        console.log('   Solution:');
        console.log('   1. ensureResourceTypeRegistered handles conflicts automatically');
        console.log('   2. Multiple instances share the same resource type registration');
        console.log('   3. Each instance gets a unique resource ID');
        console.log('');

        console.log('🎉 Direct Mode Alchemy Integration demonstration complete!');
        console.log('');
        console.log('Key takeaways:');
        console.log('✅ Individual Kubernetes resources are registered as separate Alchemy resource types');
        console.log('✅ Resource types follow kubernetes::{Kind} naming pattern');
        console.log('✅ Each resource instance gets unique tracking and lifecycle management');
        console.log('✅ Comprehensive error handling with resource-specific context');
        console.log('✅ Fine-grained debugging and troubleshooting capabilities');
        console.log('✅ Seamless integration between TypeKro and Alchemy systems');
    });
}

// Helper function to demonstrate error scenarios
async function demonstrateErrorHandling() {
    console.log('\n🚨 Error Handling Demonstration');
    console.log('===============================');

    const alchemyScope = await alchemy('error-demo', {
        stateStore: (scope) => new FileSystemStateStore(scope, { 
            rootDir: './temp/.alchemy/error-demo' 
        })
    });

    // Create a resource graph with intentionally problematic configuration
    const problematicGraph = toResourceGraph(
        {
            name: 'problematic-app',
            apiVersion: 'example.com/v1alpha1',
            kind: 'ProblematicApp',
            spec: type({ name: 'string', image: 'string' }),
            status: type({ status: 'string' }),
        },
        (schema) => ({
            // This deployment has an invalid image reference
            deployment: simpleDeployment({
                name: schema.spec.name,
                image: 'invalid-registry/nonexistent:latest',
                replicas: 1,
                id: 'problematic-deployment',
            }),
            // This service is valid
            service: simpleService({
                name: `${schema.spec.name}-service`,
                selector: { app: schema.spec.name },
                ports: [{ port: 80, targetPort: 3000 }],
                id: 'valid-service',
            }),
        }),
        (_schema, _resources) => ({
            status: 'unknown',
        })
    );

    const factory = await problematicGraph.factory('direct', {
        namespace: 'error-demo',
        alchemyScope: alchemyScope,
        waitForReady: false, // Don't wait for readiness to see partial deployment
        timeout: 10000, // Short timeout to demonstrate timeout handling
    });

    await alchemyScope.run(async () => {
        try {
            console.log('🔄 Attempting deployment with problematic configuration...');
            
            const result = await factory.deploy({
                name: 'problematic-app',
                image: 'invalid-registry/nonexistent:latest',
            });

            console.log(`📊 Deployment result: ${result.metadata?.name}`);
            
            // Check Alchemy state to see partial deployment
            const state = await alchemyScope.state.all();
            const resources = Object.entries(state).filter(
                ([_id, s]: [string, AlchemyResourceState]) => s.kind?.startsWith('kubernetes::')
            );
            
            console.log(`   Resources in Alchemy state: ${resources.length}`);
            resources.forEach(([id, resourceState]: [string, AlchemyResourceState]) => {
                console.log(`   - ${id}: ${resourceState.kind} (${resourceState.ready ? 'Ready' : 'Failed/Pending'})`);
            });
            
        } catch (error) {
            console.log(`❌ Deployment failed as expected: ${error instanceof Error ? error.message : String(error)}`);
            console.log('   This demonstrates the error handling for individual resource failures');
        }
    });
}

// Run the examples
if (import.meta.main) {
    demonstrateDirectModeAlchemyIntegration()
        .then(() => demonstrateErrorHandling())
        .catch(console.error);
}

export { 
    demonstrateDirectModeAlchemyIntegration,
    demonstrateErrorHandling,
};