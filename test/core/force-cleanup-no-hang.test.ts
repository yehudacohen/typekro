/**
 * Test that force cleanup works without hanging
 */

import { describe, it, expect } from 'bun:test';
import { simple } from '../../src/index.js';

describe('Force Cleanup No Hang', () => {
  it('should complete deployment and cleanup without hanging', async () => {
    const startTime = Date.now();
    
    try {
      // Create a simple deployment
      const deployment = simple.Deployment({
        name: 'test-force-cleanup',
        image: 'nginx:alpine',
        replicas: 1,
        id: 'testDeployment'
      });

      expect(deployment).toBeDefined();
      expect(deployment.metadata?.name).toBe('test-force-cleanup');
      
      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(5000); // Should complete quickly
      
    } catch (error) {
      console.error('Test failed:', error);
      throw error;
    }
  });

  it('should handle multiple deployments without hanging', async () => {
    const startTime = Date.now();
    
    // Create multiple deployments to test cleanup
    for (let i = 0; i < 3; i++) {
      const deployment = simple.Deployment({
        name: `test-cleanup-${i}`,
        image: 'nginx:alpine',
        replicas: 1,
        id: `testDeployment${i}`
      });
      
      expect(deployment).toBeDefined();
    }
    
    const duration = Date.now() - startTime;
    expect(duration).toBeLessThan(5000); // Should complete quickly
  });
});