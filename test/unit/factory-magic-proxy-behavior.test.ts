/**
 * Unit tests for factory function magic proxy behavior
 *
 * These tests verify that factory functions produce resources with proper magic proxy behavior,
 * specifically that status fields return KubernetesRef objects instead of static values.
 *
 * This test suite would have caught the bug where helmRelease factory was providing
 * static status values like 'Pending' instead of allowing the magic proxy to create
 * KubernetesRef objects.
 */

import { describe, expect, it } from 'bun:test';
import { helmRelease } from '../../src/factories/helm/helm-release.js';
import { simple } from '../../src/index.js';
import {
  asKubernetesRef,
  clearStatusBuilderContext,
  expectKubernetesRef,
  setStatusBuilderContext,
} from '../utils/mock-factories.js';

describe('Factory Magic Proxy Behavior', () => {
  describe('helmRelease factory', () => {
    it('should create resources with KubernetesRef status fields, not static values', () => {
      const release = helmRelease({
        name: 'test-release',
        chart: {
          repository: 'oci://ghcr.io/kro-run/kro',
          name: 'kro',
          version: '0.3.0',
        },
      });

      // These assertions would have caught the bug where status fields were static values
      const lastAttemptedRevision = release.status.lastAttemptedRevision;

      // Should NOT be static values
      expect(lastAttemptedRevision).not.toBe('Pending');
      expect(lastAttemptedRevision).not.toBe('Ready');
      expect(lastAttemptedRevision).not.toBe('Installing');
      expect(lastAttemptedRevision).not.toBe(undefined);

      // Should BE a KubernetesRef function
      expectKubernetesRef(lastAttemptedRevision, {
        resourceId: 'helmreleaseTestRelease',
        fieldPath: 'status.lastAttemptedRevision',
      });
    });

    it('should create KubernetesRef objects for all status fields', () => {
      const release = helmRelease({
        name: 'test-release',
        chart: {
          repository: 'oci://ghcr.io/kro-run/kro',
          name: 'kro',
          version: '0.3.0',
        },
      });

      // Test all status fields (real HelmReleaseStatus fields)
      const lastAttemptedRevision = release.status.lastAttemptedRevision;
      const observedGeneration = release.status.observedGeneration;
      const helmChart = release.status.helmChart;

      // All should be KubernetesRef objects, not static values
      [lastAttemptedRevision, observedGeneration, helmChart].forEach((field, index) => {
        const fieldNames = ['lastAttemptedRevision', 'observedGeneration', 'helmChart'];
        const fieldName = fieldNames[index];

        expectKubernetesRef(field, {
          resourceId: 'helmreleaseTestRelease',
          fieldPath: `status.${fieldName}`,
        });
      });
    });

    it('should allow JavaScript expressions using status fields in status builder context', () => {
      const release = helmRelease({
        name: 'test-release',
        chart: {
          repository: 'oci://ghcr.io/kro-run/kro',
          name: 'kro',
          version: '0.3.0',
        },
      });

      // Set the status builder context to simulate being inside a status builder
      setStatusBuilderContext(true);

      try {
        // In status builder context, status field access should return KubernetesRef objects
        const lastAttemptedRevision = release.status.lastAttemptedRevision;
        expectKubernetesRef(lastAttemptedRevision, {
          fieldPath: 'status.lastAttemptedRevision',
        });

        // Note: JavaScript expressions like `phase === 'Ready'` will still be evaluated immediately
        // because JavaScript doesn't allow operator overloading. The conversion happens during
        // status builder analysis, not during expression execution.
      } finally {
        clearStatusBuilderContext();
      }
    });
  });

  describe('Kubernetes factory functions', () => {
    it('should create Deployment resources with KubernetesRef status fields', () => {
      const deployment = simple.Deployment({
        name: 'test-app',
        image: 'nginx:latest',
        replicas: 3,
      });

      // Status fields should be KubernetesRef objects
      const readyReplicas = deployment.status.readyReplicas;
      const availableReplicas = deployment.status.availableReplicas;

      expectKubernetesRef(readyReplicas, { fieldPath: 'status.readyReplicas' });
      expectKubernetesRef(availableReplicas, { fieldPath: 'status.availableReplicas' });
    });

    it('should create Service resources with KubernetesRef status fields', () => {
      const service = simple.Service({
        name: 'test-service',
        ports: [{ port: 80, targetPort: 8080 }],
        selector: { app: 'test-app' },
      });

      // Status fields should be KubernetesRef objects
      const loadBalancer = service.status.loadBalancer;
      const conditions = service.status.conditions;

      expectKubernetesRef(loadBalancer, { fieldPath: 'status.loadBalancer' });
      expectKubernetesRef(conditions, { fieldPath: 'status.conditions' });
    });

    it('should create PVC resources with KubernetesRef status fields', () => {
      const pvc = simple.Pvc({
        name: 'test-storage',
        size: '10Gi',
        accessModes: ['ReadWriteOnce'],
      });

      // Status fields should be KubernetesRef objects
      const phase = pvc.status.phase;
      const capacity = pvc.status.capacity;

      expectKubernetesRef(phase, { fieldPath: 'status.phase' });
      expectKubernetesRef(capacity, { fieldPath: 'status.capacity' });
    });
  });

  describe('Factory function consistency', () => {
    it('should never provide static status values that break magic proxy behavior', () => {
      // Test multiple factory functions to ensure consistency
      const resources = [
        simple.Deployment({ name: 'test', image: 'nginx' }),
        simple.Service({ name: 'test', ports: [{ port: 80 }], selector: { app: 'test' } }),
        simple.Pvc({ name: 'test', size: '1Gi', accessModes: ['ReadWriteOnce'] }),
        helmRelease({
          name: 'test',
          chart: { repository: 'oci://example.com', name: 'chart', version: '1.0.0' },
        }),
      ];

      resources.forEach((resource, index) => {
        const resourceTypes = ['Deployment', 'Service', 'PVC', 'HelmRelease'];
        const _resourceType = resourceTypes[index];

        // Check that status object exists but doesn't have static values
        expect(resource.status).toBeDefined();

        // Access a common status field and verify it's a KubernetesRef
        const statusKeys = Object.keys(resource.status || {});
        if (statusKeys.length > 0 && statusKeys[0]) {
          const firstStatusField = (resource.status as Record<string, unknown>)[statusKeys[0]];

          // Should be a KubernetesRef function, not a static value
          expectKubernetesRef(firstStatusField);
        }
      });
    });

    it('should provide KubernetesRef status fields for use in expressions', () => {
      const deployment = simple.Deployment({
        name: 'test-app',
        image: 'nginx:latest',
        replicas: 3,
      });

      const service = simple.Service({
        name: 'test-service',
        ports: [{ port: 80, targetPort: 8080 }],
        selector: { app: 'test-app' },
      });

      // Individual status fields should be KubernetesRef objects
      const readyReplicas = deployment.status.readyReplicas;
      const serviceLoadBalancer = service.status.loadBalancer;
      const specReplicas = deployment.spec.replicas;

      // All should be KubernetesRef functions
      expectKubernetesRef(readyReplicas, { fieldPath: 'status.readyReplicas' });
      expectKubernetesRef(serviceLoadBalancer, { fieldPath: 'status.loadBalancer' });

      // Spec fields with actual values return those values outside of status builder context
      // This is correct behavior - spec fields only become KubernetesRef in status builders
      expect(specReplicas).toBe(3); // The actual value from the deployment spec
    });
  });

  describe('Regression prevention', () => {
    it('should catch if factory functions start providing static status values again', () => {
      // This test specifically prevents the bug we just fixed
      const release = helmRelease({
        name: 'regression-test',
        chart: {
          repository: 'oci://ghcr.io/kro-run/kro',
          name: 'kro',
          version: '0.3.0',
        },
      });

      // These specific assertions would have failed with the bug
      expect(release.status.lastAttemptedRevision).not.toBe('Pending');
      expect(release.status.lastAttemptedRevision).not.toBe('Ready');
      expect(release.status.lastAttemptedRevision).not.toBe('Installing');
      expect(release.status.lastAttemptedRevision).not.toBe('Failed');

      // Should be a proper KubernetesRef
      expectKubernetesRef(release.status.lastAttemptedRevision);
    });

    it('should ensure Enhanced resources maintain magic proxy behavior', () => {
      // Test that Enhanced<> wrapper doesn't break magic proxy
      const deployment = simple.Deployment({
        name: 'enhanced-test',
        image: 'nginx:latest',
      });

      // The Enhanced wrapper should not interfere with magic proxy behavior
      const readyReplicas = deployment.status.readyReplicas;

      expectKubernetesRef(readyReplicas, { fieldPath: 'status.readyReplicas' });
      expect(asKubernetesRef(readyReplicas).resourceId).toContain('deployment');
    });
  });
});
