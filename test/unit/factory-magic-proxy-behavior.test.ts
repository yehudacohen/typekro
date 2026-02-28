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
import { KUBERNETES_REF_BRAND } from '../../src/core/constants/brands.js';
import { helmRelease } from '../../src/factories/helm/helm-release.js';
import { simple } from '../../src/index.js';

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
      expect(typeof lastAttemptedRevision).toBe('function');
      expect(KUBERNETES_REF_BRAND in (lastAttemptedRevision as any)).toBe(true);
      expect((lastAttemptedRevision as any).resourceId).toBe('helmreleaseTestRelease');
      expect((lastAttemptedRevision as any).fieldPath).toBe('status.lastAttemptedRevision');
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

        expect(typeof field).toBe('function');
        expect(KUBERNETES_REF_BRAND in (field as any)).toBe(true);
        expect((field as any).resourceId).toBe('helmreleaseTestRelease');
        expect((field as any).fieldPath).toBe(`status.${fieldName}`);
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
      (globalThis as any).__TYPEKRO_STATUS_BUILDER_CONTEXT__ = true;

      try {
        // In status builder context, status field access should return KubernetesRef objects
        const lastAttemptedRevision = release.status.lastAttemptedRevision;
        expect(typeof lastAttemptedRevision).toBe('function');
        expect(KUBERNETES_REF_BRAND in (lastAttemptedRevision as any)).toBe(true);
        expect((lastAttemptedRevision as any).fieldPath).toBe('status.lastAttemptedRevision');

        // Note: JavaScript expressions like `phase === 'Ready'` will still be evaluated immediately
        // because JavaScript doesn't allow operator overloading. The conversion happens during
        // status builder analysis, not during expression execution.
      } finally {
        delete (globalThis as any).__TYPEKRO_STATUS_BUILDER_CONTEXT__;
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

      expect(typeof readyReplicas).toBe('function');
      expect(KUBERNETES_REF_BRAND in (readyReplicas as any)).toBe(true);
      expect((readyReplicas as any).fieldPath).toBe('status.readyReplicas');

      expect(typeof availableReplicas).toBe('function');
      expect(KUBERNETES_REF_BRAND in (availableReplicas as any)).toBe(true);
      expect((availableReplicas as any).fieldPath).toBe('status.availableReplicas');
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

      expect(typeof loadBalancer).toBe('function');
      expect(KUBERNETES_REF_BRAND in (loadBalancer as any)).toBe(true);
      expect((loadBalancer as any).fieldPath).toBe('status.loadBalancer');

      expect(typeof conditions).toBe('function');
      expect(KUBERNETES_REF_BRAND in (conditions as any)).toBe(true);
      expect((conditions as any).fieldPath).toBe('status.conditions');
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

      expect(typeof phase).toBe('function');
      expect(KUBERNETES_REF_BRAND in (phase as any)).toBe(true);
      expect((phase as any).fieldPath).toBe('status.phase');

      expect(typeof capacity).toBe('function');
      expect(KUBERNETES_REF_BRAND in (capacity as any)).toBe(true);
      expect((capacity as any).fieldPath).toBe('status.capacity');
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
          const firstStatusField = (resource.status as any)[statusKeys[0]];

          // Should be a KubernetesRef function, not a static value
          expect(typeof firstStatusField).toBe('function');
          expect(KUBERNETES_REF_BRAND in (firstStatusField as any)).toBe(true);
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
      expect(typeof readyReplicas).toBe('function');
      expect(KUBERNETES_REF_BRAND in (readyReplicas as any)).toBe(true);
      expect((readyReplicas as any).fieldPath).toBe('status.readyReplicas');

      expect(typeof serviceLoadBalancer).toBe('function');
      expect(KUBERNETES_REF_BRAND in (serviceLoadBalancer as any)).toBe(true);
      expect((serviceLoadBalancer as any).fieldPath).toBe('status.loadBalancer');

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
      expect(typeof release.status.lastAttemptedRevision).toBe('function');
      expect(KUBERNETES_REF_BRAND in (release.status.lastAttemptedRevision as any)).toBe(true);
    });

    it('should ensure Enhanced resources maintain magic proxy behavior', () => {
      // Test that Enhanced<> wrapper doesn't break magic proxy
      const deployment = simple.Deployment({
        name: 'enhanced-test',
        image: 'nginx:latest',
      });

      // The Enhanced wrapper should not interfere with magic proxy behavior
      const readyReplicas = deployment.status.readyReplicas;

      expect(typeof readyReplicas).toBe('function');
      expect(KUBERNETES_REF_BRAND in (readyReplicas as any)).toBe(true);
      expect((readyReplicas as any).resourceId).toContain('deployment');
      expect((readyReplicas as any).fieldPath).toBe('status.readyReplicas');
    });
  });
});
