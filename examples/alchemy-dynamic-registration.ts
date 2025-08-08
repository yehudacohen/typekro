/**
 * Example: Dynamic Alchemy Resource Registration
 * 
 * This example demonstrates the new dynamic resource type registration
 * system that prevents "Resource already exists" errors while maintaining
 * full type safety and proper alchemy integration.
 */

import {
  ensureResourceTypeRegistered,
  inferAlchemyTypeFromTypeKroResource,
  type TypeKroDeployer,
} from '../src/alchemy/deployment.js';
import { simpleDeployment, simpleService } from '../src/core/composition/index.js';
import type { Enhanced } from '../src/core/types/kubernetes.js';
import type { DeploymentOptions } from '../src/core/types/deployment.js';

// Example: Create some TypeKro resources
const webAppDeployment = simpleDeployment({
  name: 'webapp',
  image: 'nginx:latest',
  replicas: 3,
  ports: [{ name: 'http', containerPort: 80, protocol: 'TCP' }],
});

const webAppService = simpleService({
  name: 'webapp-service',
  selector: { app: 'webapp' },
  ports: [{ port: 80, targetPort: 80 }],
  type: 'LoadBalancer',
});

// Example: Demonstrate type inference
console.log('=== Type Inference ===');
console.log('Deployment type:', inferAlchemyTypeFromTypeKroResource(webAppDeployment));
console.log('Service type:', inferAlchemyTypeFromTypeKroResource(webAppService));

// Example: Demonstrate dynamic registration
console.log('\n=== Dynamic Registration ===');
console.log('Registered types before: (cleared for demo)');

// Register the same type multiple times - should not cause conflicts
const deploymentProvider1 = ensureResourceTypeRegistered(webAppDeployment);
const deploymentProvider2 = ensureResourceTypeRegistered(webAppDeployment);
const serviceProvider = ensureResourceTypeRegistered(webAppService);

console.log('Same provider returned:', deploymentProvider1 === deploymentProvider2);
console.log('Different providers for different types:', deploymentProvider1 !== serviceProvider);
console.log('Registered types after: (types registered dynamically)');

// Example: Create a deployer (mock for this example)
class ExampleDeployer implements TypeKroDeployer {
  async deploy<T extends Enhanced<any, any>>(resource: T, options: DeploymentOptions): Promise<T> {
    console.log(`Deploying ${resource.kind} to namespace ${options.namespace}`);
    return resource;
  }
  
  async delete<T extends Enhanced<any, any>>(resource: T, options: DeploymentOptions): Promise<void> {
    console.log(`Deleting ${resource.kind} from namespace ${options.namespace}`);
  }
}

// Example: Demonstrate resource creation (would need alchemy scope in real usage)
console.log('\n=== Resource Creation (Conceptual) ===');
const _deployer = new ExampleDeployer();

console.log('This would create alchemy resources with deterministic IDs:');
console.log('- Deployment ID: deployment-webapp-default');
console.log('- Service ID: service-webapp-service-default');

// In a real alchemy application, you would do:
// const app = await alchemy('my-app');
// const deploymentResource = await createAlchemyResource(webAppDeployment, deployer, 'default');
// const serviceResource = await createAlchemyResource(webAppService, deployer, 'default');

console.log('\n=== Benefits of Dynamic Registration ===');
console.log('✅ No "Resource already exists" errors');
console.log('✅ Deterministic resource IDs for GitOps compatibility');
console.log('✅ Type-safe alchemy integration');
console.log('✅ Centralized deployment logic');
console.log('✅ Proper dependency management');
console.log('✅ Automatic cleanup when alchemy scope is destroyed');

export {
  webAppDeployment,
  webAppService,
  ExampleDeployer,
};