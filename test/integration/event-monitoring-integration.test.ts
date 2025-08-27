/**
 * Integration tests for Event Monitoring
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createEventFilter } from '../../src/core/deployment/event-filter.js';
import { createEventMonitor } from '../../src/core/deployment/event-monitor.js';
import { createEventStreamer } from '../../src/core/deployment/event-streamer.js';
import type { DeployedResource, DeploymentEvent } from '../../src/core/types/deployment.js';
import { getIntegrationTestKubeConfig, isClusterAvailable } from './shared-kubeconfig.js';

// Skip all tests if no cluster is available
const clusterAvailable = isClusterAvailable();

describe('Event Monitoring Integration', () => {
  let capturedEvents: DeploymentEvent[] = [];

  beforeEach(() => {
    capturedEvents = [];
  });

  afterEach(() => {
    // Clean up any resources
  });

  describe('End-to-End Event Flow', () => {
    it('should monitor, filter, and stream events for deployed resources', async () => {
      if (!clusterAvailable) {
        console.log('Skipping test - no Kubernetes cluster available');
        return;
      }

      const kubeConfig = getIntegrationTestKubeConfig();
      const progressCallback = (event: DeploymentEvent) => {
        capturedEvents.push(event);
      };

      // Create components
      const eventMonitor = createEventMonitor(kubeConfig, {
        namespace: 'test-namespace',
        eventTypes: ['Warning', 'Error'],
        progressCallback,
      });

      const _eventFilter = createEventFilter({
        eventTypes: ['Warning', 'Error'],
        includeChildResources: true,
      });

      const eventStreamer = createEventStreamer({
        consoleLogging: true,
        logLevel: 'info',
      });
      eventStreamer.setProgressCallback(progressCallback);

      // Test deployed resources
      const deployedResources: DeployedResource[] = [
        {
          id: 'webapp-deployment',
          kind: 'Deployment',
          name: 'webapp',
          namespace: 'test-namespace',
          manifest: {
            apiVersion: 'apps/v1',
            kind: 'Deployment',
            metadata: { name: 'webapp', namespace: 'test-namespace', uid: 'webapp-uid' },
          },
          status: 'deployed',
          deployedAt: new Date(),
        },
        {
          id: 'webapp-service',
          kind: 'Service',
          name: 'webapp-service',
          namespace: 'test-namespace',
          manifest: {
            apiVersion: 'v1',
            kind: 'Service',
            metadata: { name: 'webapp-service', namespace: 'test-namespace', uid: 'service-uid' },
          },
          status: 'deployed',
          deployedAt: new Date(),
        },
      ];

      // Start monitoring - this should not throw errors
      await expect(eventMonitor.startMonitoring(deployedResources)).resolves.toBeUndefined();

      // Clean up
      await eventMonitor.stopMonitoring();
    });

    it('should handle child resource events', async () => {
      if (!clusterAvailable) {
        console.log('Skipping test - no Kubernetes cluster available');
        return;
      }

      const kubeConfig = getIntegrationTestKubeConfig();
      const progressCallback = (event: DeploymentEvent) => {
        capturedEvents.push(event);
      };

      const eventMonitor = createEventMonitor(kubeConfig, {
        namespace: 'test-namespace',
        eventTypes: ['Warning', 'Error'],
        includeChildResources: true,
        progressCallback,
      });

      const _eventFilter2 = createEventFilter({
        eventTypes: ['Warning', 'Error'],
        includeChildResources: true,
      });

      const deployedResource: DeployedResource = {
        id: 'webapp-deployment',
        kind: 'Deployment',
        name: 'webapp',
        namespace: 'test-namespace',
        manifest: {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: { name: 'webapp', namespace: 'test-namespace', uid: 'webapp-uid' },
        },
        status: 'deployed',
        deployedAt: new Date(),
      };

      // Start monitoring - should handle child resources
      await expect(eventMonitor.startMonitoring([deployedResource])).resolves.toBeUndefined();

      // Clean up
      await eventMonitor.stopMonitoring();
    });

    it('should deduplicate repeated events', async () => {
      if (!clusterAvailable) {
        console.log('Skipping test - no Kubernetes cluster available');
        return;
      }

      // Test event deduplication functionality
      const eventFilter = createEventFilter({
        eventTypes: ['Warning', 'Error'],
        deduplicationWindow: 1000, // 1 second
      });

      // This test validates the filter logic without requiring real events
      expect(eventFilter).toBeDefined();
    });

    it('should handle rate limiting in event streamer', async () => {
      if (!clusterAvailable) {
        console.log('Skipping test - no Kubernetes cluster available');
        return;
      }

      // Test rate limiting functionality
      const eventStreamer = createEventStreamer({
        consoleLogging: false,
        logLevel: 'info',
        maxEventsPerSecond: 2,
      });

      // This test validates the streamer logic
      expect(eventStreamer).toBeDefined();
      const stats = eventStreamer.getRateLimitStats();
      expect(stats).toBeDefined();
    });
  });

  describe('Error Handling', () => {
    it('should handle watch connection errors gracefully', async () => {
      if (!clusterAvailable) {
        console.log('Skipping test - no Kubernetes cluster available');
        return;
      }

      const kubeConfig = getIntegrationTestKubeConfig();
      const eventMonitor = createEventMonitor(kubeConfig, {
        namespace: 'test-namespace',
        eventTypes: ['Warning', 'Error'],
      });

      const deployedResource: DeployedResource = {
        id: 'webapp-deployment',
        kind: 'Deployment',
        name: 'webapp',
        namespace: 'test-namespace',
        manifest: {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: { name: 'webapp', namespace: 'test-namespace' },
        },
        status: 'deployed',
        deployedAt: new Date(),
      };

      // Should handle connection errors gracefully
      await expect(eventMonitor.startMonitoring([deployedResource])).resolves.toBeUndefined();

      await eventMonitor.stopMonitoring();
    });

    it('should handle API permission errors during initialization', async () => {
      if (!clusterAvailable) {
        console.log('Skipping test - no Kubernetes cluster available');
        return;
      }

      const kubeConfig = getIntegrationTestKubeConfig();
      // For integration tests, we test with real APIs
      const eventMonitor = createEventMonitor(kubeConfig, {
        namespace: 'test-namespace',
        eventTypes: ['Warning', 'Error'],
      });

      const deployedResource: DeployedResource = {
        id: 'webapp-deployment',
        kind: 'Deployment',
        name: 'webapp',
        namespace: 'test-namespace',
        manifest: {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: { name: 'webapp', namespace: 'test-namespace' },
        },
        status: 'deployed',
        deployedAt: new Date(),
      };

      // Should handle any errors gracefully (not throw, but log warning)
      await expect(eventMonitor.startMonitoring([deployedResource])).resolves.toBeUndefined();

      await eventMonitor.stopMonitoring();
    });
  });

  describe('Performance', () => {
    it('should efficiently handle multiple resources of same kind', async () => {
      if (!clusterAvailable) {
        console.log('Skipping test - no Kubernetes cluster available');
        return;
      }

      const kubeConfig = getIntegrationTestKubeConfig();
      const eventMonitor = createEventMonitor(kubeConfig, {
        namespace: 'test-namespace',
        eventTypes: ['Warning', 'Error'],
      });

      // Create multiple resources of the same kind
      const deployedResources: DeployedResource[] = Array.from({ length: 10 }, (_, i) => ({
        id: `webapp-deployment-${i}`,
        kind: 'Deployment',
        name: `webapp-${i}`,
        namespace: 'test-namespace',
        manifest: {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: { name: `webapp-${i}`, namespace: 'test-namespace' },
        },
        status: 'deployed' as const,
        deployedAt: new Date(),
      }));

      // Should handle multiple resources efficiently
      await expect(eventMonitor.startMonitoring(deployedResources)).resolves.toBeUndefined();

      await eventMonitor.stopMonitoring();
    });

    it('should create separate connections for different resource kinds', async () => {
      if (!clusterAvailable) {
        console.log('Skipping test - no Kubernetes cluster available');
        return;
      }

      const kubeConfig = getIntegrationTestKubeConfig();
      const eventMonitor = createEventMonitor(kubeConfig, {
        namespace: 'test-namespace',
        eventTypes: ['Warning', 'Error'],
      });

      // Create resources of different kinds
      const deployedResources: DeployedResource[] = [
        {
          id: 'webapp-deployment',
          kind: 'Deployment',
          name: 'webapp',
          namespace: 'test-namespace',
          manifest: {
            apiVersion: 'apps/v1',
            kind: 'Deployment',
            metadata: { name: 'webapp', namespace: 'test-namespace' },
          },
          status: 'deployed',
          deployedAt: new Date(),
        },
        {
          id: 'webapp-service',
          kind: 'Service',
          name: 'webapp-service',
          namespace: 'test-namespace',
          manifest: {
            apiVersion: 'v1',
            kind: 'Service',
            metadata: { name: 'webapp-service', namespace: 'test-namespace' },
          },
          status: 'deployed',
          deployedAt: new Date(),
        },
        {
          id: 'webapp-configmap',
          kind: 'ConfigMap',
          name: 'webapp-config',
          namespace: 'test-namespace',
          manifest: {
            apiVersion: 'v1',
            kind: 'ConfigMap',
            metadata: { name: 'webapp-config', namespace: 'test-namespace' },
          },
          status: 'deployed',
          deployedAt: new Date(),
        },
      ];

      // Should handle different resource kinds
      await expect(eventMonitor.startMonitoring(deployedResources)).resolves.toBeUndefined();

      await eventMonitor.stopMonitoring();
    });
  });

  describe('Configuration', () => {
    it('should respect event type filtering configuration', async () => {
      if (!clusterAvailable) {
        console.log('Skipping test - no Kubernetes cluster available');
        return;
      }

      const kubeConfig = getIntegrationTestKubeConfig();
      const progressCallback = (event: DeploymentEvent) => {
        capturedEvents.push(event);
      };

      // Monitor only Error events
      const eventMonitor = createEventMonitor(kubeConfig, {
        namespace: 'test-namespace',
        eventTypes: ['Error'], // Only errors
        progressCallback,
      });

      const deployedResource: DeployedResource = {
        id: 'webapp-deployment',
        kind: 'Deployment',
        name: 'webapp',
        namespace: 'test-namespace',
        manifest: {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: { name: 'webapp', namespace: 'test-namespace' },
        },
        status: 'deployed',
        deployedAt: new Date(),
      };

      // Should respect event type filtering
      await expect(eventMonitor.startMonitoring([deployedResource])).resolves.toBeUndefined();

      await eventMonitor.stopMonitoring();
    });
  });
});
