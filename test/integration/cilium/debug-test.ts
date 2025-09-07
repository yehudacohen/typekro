/**
 * Debug test to isolate kubernetesComposition issues
 */

import { type } from 'arktype';
import { kubernetesComposition } from '../../../src/index.js';
import { ciliumHelmRepository } from '../../../src/factories/cilium/resources/helm.js';

// Simple test that matches the working TypeKro runtime bootstrap pattern
const TestSpec = type({
  name: 'string',
});

const TestStatus = type({
  ready: 'boolean',
  url: 'string',
  components: {
    repo: 'boolean',
  },
});

console.log('🧪 Testing minimal kubernetesComposition...');

try {
  const testComposition = kubernetesComposition(
    {
      name: 'test-composition',
      apiVersion: 'test.example.com/v1alpha1',
      kind: 'TestComposition',
      spec: TestSpec,
      status: TestStatus,
    },
    (spec) => {
      const testRepo = ciliumHelmRepository({
        name: spec.name,
        namespace: 'default',
        id: 'testRepo',
      });

      // Exact same pattern as working TypeKro runtime bootstrap
      return {
        ready: testRepo.status.url !== '',
        url: testRepo.status.url,
        components: {
          repo: testRepo.status.url !== '',
        },
      };
    }
  );

  console.log('✅ Composition created successfully');
  console.log('Composition name:', testComposition.name);
} catch (error) {
  console.error('❌ Composition creation failed:', error);
}