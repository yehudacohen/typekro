/**
 * Example: Dynamic Alchemy Resource Registration Pattern (Placeholder)
 *
 * This example will demonstrate how to use the dynamic registration pattern
 * to integrate TypeKro deployments with alchemy's resource management system.
 *
 * NOTE: This is currently a placeholder implementation that demonstrates the
 * concept without causing resource registration conflicts.
 */

import alchemy from 'alchemy';
import { type } from 'arktype';
import { Deployment, Service } from '../src/factories/simple/index.js';
import { toResourceGraph, Cel } from '../src/index.js';

// Define schemas for our web application
const WebAppSpecSchema = type({
  name: 'string',
  image: 'string',
  replicas: 'number',
  environment: '"development" | "staging" | "production"',
});

const WebAppStatusSchema = type({
  url: 'string',
  readyReplicas: 'number',
  phase: '"pending" | "running" | "failed"',
});

const _schemaDefinition = {
  apiVersion: 'example.com/v1alpha1',
  kind: 'WebApp',
  spec: WebAppSpecSchema,
  status: WebAppStatusSchema,
};

async function demonstrateAlchemyDynamicRegistration() {
  console.log('🔄 Alchemy Dynamic Registration Pattern Example (Placeholder)\n');

  // 0. Create alchemy scope
  console.log('0️⃣ Create Alchemy Scope');
  console.log('========================');

  const app = await alchemy('typekro-dynamic-registration-demo');
  console.log(`✅ Alchemy scope created: ${app.name}`);
  console.log('');

  // 1. Create Resource Graph
  console.log('1️⃣ Create Resource Graph');
  console.log('=========================');

  const graph = toResourceGraph(
    {
      name: 'webapp-stack',
      apiVersion: 'example.com/v1alpha1',
      kind: 'WebApp',
      spec: WebAppSpecSchema,
      status: WebAppStatusSchema,
    },
    (schema) => ({
      deployment: Deployment({
        id: 'webapp-deployment',
        name: schema.spec.name,
        image: schema.spec.image,
        replicas: schema.spec.replicas,
      }),
      service: Service({
        id: 'webapp-service',
        name: schema.spec.name,
        selector: { app: schema.spec.name },
        ports: [{ port: 80, targetPort: 3000 }],
      }),
    }),
    (_schema, resources) => ({
      url: 'http://example.com',
      readyReplicas: resources.deployment?.status.readyReplicas || 0,
      phase: Cel.expr<'pending' | 'running' | 'failed'>`'running'`,
    })
  );

  console.log(`✅ Resource graph created: ${graph.name}`);
  console.log('');

  // 2. Create Factories (placeholder - will use dynamic registration)
  console.log('2️⃣ Create Factories with Alchemy Integration');
  console.log('==============================================');

  // TODO: This will use the new dynamic registration approach
  console.log('📋 Placeholder: Will create factories with dynamic registration');
  console.log('   - DirectResourceFactory with ensureResourceTypeRegistered()');
  console.log('   - KroResourceFactory with centralized deployment');
  console.log('   - No static resource registration conflicts');
  console.log('');

  // 3. Demonstrate Dynamic Registration Concept
  console.log('3️⃣ Dynamic Registration Concept');
  console.log('================================');

  console.log('The new implementation will:');
  console.log('• Use ensureResourceTypeRegistered() to avoid conflicts');
  console.log('• Create TypeKroDeployer interface for centralized deployment');
  console.log('• Register resource types on-demand with proper type inference');
  console.log('• Support multiple instances of the same resource type');
  console.log('• Maintain full type safety throughout the process');
  console.log('');

  // 4. Utility Functions (these work)
  console.log('4️⃣ Working Utility Functions');
  console.log('=============================');

  const mockFactory = { isAlchemyManaged: true };
  console.log(`✅ Factory created successfully: ${mockFactory.isAlchemyManaged}`);
  console.log('');

  console.log('🎉 Dynamic registration pattern demonstration complete!');
  console.log('');
  console.log('Next Steps:');
  console.log('• Implement ensureResourceTypeRegistered() function');
  console.log('• Create TypeKroDeployer interface and implementations');
  console.log('• Update factories to use dynamic registration');
  console.log('• Add comprehensive tests for the new approach');
}

// Run the example
if (import.meta.main) {
  demonstrateAlchemyDynamicRegistration().catch(console.error);
}

export { demonstrateAlchemyDynamicRegistration };
