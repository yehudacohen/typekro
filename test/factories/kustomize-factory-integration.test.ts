import { describe, expect, it } from 'bun:test';
import { kustomization } from '../../src/factories/flux/kustomize/kustomization.js';
import { kustomizationReadinessEvaluator } from '../../src/factories/flux/kustomize/readiness-evaluators.js';

describe('Kustomize Factory Integration', () => {
  it('should create a Kustomization resource with readiness evaluator', () => {
    const kustomizeResource = kustomization({
      id: 'testKustomization',
      name: 'test-kustomization',
      namespace: 'default',
      source: {
        kind: 'GitRepository',
        name: 'test-repo',
      },
      path: './manifests',
      patches: [
        {
          target: {
            kind: 'Deployment',
            name: 'webapp',
          },
          patch: {
            spec: {
              replicas: 3,
            },
          },
        },
      ],
    });

    // Verify basic resource properties
    expect(kustomizeResource.apiVersion).toBe('kustomize.toolkit.fluxcd.io/v1');
    expect(kustomizeResource.kind).toBe('Kustomization');
    expect(kustomizeResource.metadata?.name).toBe('test-kustomization');
    expect(kustomizeResource.metadata?.namespace).toBe('default');

    // Verify spec properties
    expect(kustomizeResource.spec?.interval).toBe('5m');
    expect(kustomizeResource.spec?.sourceRef.kind).toBe('GitRepository');
    expect(kustomizeResource.spec?.sourceRef.name).toBe('test-repo');
    expect(kustomizeResource.spec?.path).toBe('./manifests');
    expect(kustomizeResource.spec?.patches).toHaveLength(1);
    expect(kustomizeResource.spec?.prune).toBe(true);
    expect(kustomizeResource.spec?.wait).toBe(true);
    expect(kustomizeResource.spec?.timeout).toBe('10m');

    // Verify readiness evaluator is attached
    expect(kustomizeResource.readinessEvaluator).toBeDefined();
    expect(typeof kustomizeResource.readinessEvaluator).toBe('function');
    expect(kustomizeResource.readinessEvaluator).toBe(kustomizationReadinessEvaluator);
  });

  it('should support all Kustomization configuration options', () => {
    const kustomizeResource = kustomization({
      id: 'fullKustomization',
      name: 'full-kustomization',
      namespace: 'kustomize-system',
      interval: '10m',
      source: {
        kind: 'OCIRepository',
        name: 'oci-repo',
        namespace: 'flux-system',
      },
      path: './overlays/production',
      patches: [
        {
          target: {
            group: 'apps',
            version: 'v1',
            kind: 'Deployment',
            name: 'webapp',
            namespace: 'default',
          },
          patch: {
            spec: {
              replicas: 5,
            },
          },
          options: {
            allowNameChange: true,
            allowKindChange: false,
          },
        },
      ],
      images: [
        {
          name: 'webapp',
          newName: 'registry.example.com/webapp',
          newTag: 'v2.0.0',
        },
      ],
      replicas: [
        {
          name: 'webapp',
          count: 3,
        },
      ],
      patchesStrategicMerge: ['deployment-patch.yaml'],
      patchesJson6902: [
        {
          target: {
            kind: 'Service',
            name: 'webapp-service',
          },
          path: 'service-patch.yaml',
        },
      ],
    });

    // Verify all configuration options are set
    expect(kustomizeResource.spec?.interval).toBe('10m');
    expect(kustomizeResource.spec?.sourceRef).toEqual({
      kind: 'OCIRepository',
      name: 'oci-repo',
      namespace: 'flux-system',
    });
    expect(kustomizeResource.spec?.path).toBe('./overlays/production');

    // Verify patches
    expect(kustomizeResource.spec?.patches).toHaveLength(1);
    const patch = kustomizeResource.spec?.patches?.[0];
    expect(patch?.target?.group).toBe('apps');
    expect(patch?.target?.version).toBe('v1');
    expect(patch?.target?.kind).toBe('Deployment');
    expect(patch?.options?.allowNameChange).toBe(true);
    expect(patch?.options?.allowKindChange).toBe(false);

    // Verify images
    expect(kustomizeResource.spec?.images).toHaveLength(1);
    expect(kustomizeResource.spec?.images![0]).toEqual({
      name: 'webapp',
      newName: 'registry.example.com/webapp',
      newTag: 'v2.0.0',
    });

    // Verify replicas
    expect(kustomizeResource.spec?.replicas).toHaveLength(1);
    expect(kustomizeResource.spec?.replicas![0]).toEqual({
      name: 'webapp',
      count: 3,
    });

    // Verify strategic merge patches
    expect(kustomizeResource.spec?.patchesStrategicMerge).toEqual(['deployment-patch.yaml']);

    // Verify JSON 6902 patches
    expect(kustomizeResource.spec?.patchesJson6902).toHaveLength(1);
    expect(kustomizeResource.spec?.patchesJson6902![0]).toEqual({
      target: {
        kind: 'Service',
        name: 'webapp-service',
      },
      path: 'service-patch.yaml',
    });
  });

  it('should use default values when optional fields are not provided', () => {
    const kustomizeResource = kustomization({
      id: 'minimalKustomization',
      name: 'minimal-kustomization',
      source: {
        kind: 'GitRepository',
        name: 'minimal-repo',
      },
    });

    // Verify defaults
    expect(kustomizeResource.spec?.interval).toBe('5m');
    expect(kustomizeResource.spec?.path).toBe('./');
    expect(kustomizeResource.spec?.prune).toBe(true);
    expect(kustomizeResource.spec?.wait).toBe(true);
    expect(kustomizeResource.spec?.timeout).toBe('10m');

    // Verify optional fields are undefined when not provided
    expect(kustomizeResource.spec?.patches).toBeUndefined();
    expect(kustomizeResource.spec?.images).toBeUndefined();
    expect(kustomizeResource.spec?.replicas).toBeUndefined();
    expect(kustomizeResource.spec?.patchesStrategicMerge).toBeUndefined();
    expect(kustomizeResource.spec?.patchesJson6902).toBeUndefined();
  });

  it('should handle readiness evaluation correctly', () => {
    const kustomizeResource = kustomization({
      id: 'readinessTestKustomization',
      name: 'readiness-test',
      source: {
        kind: 'GitRepository',
        name: 'test-repo',
      },
    });

    const readinessEvaluator = kustomizeResource.readinessEvaluator;
    expect(readinessEvaluator).toBeDefined();

    if (!readinessEvaluator) return;

    // Test with a ready Kustomization
    const readyKustomization = {
      apiVersion: 'kustomize.toolkit.fluxcd.io/v1',
      kind: 'Kustomization',
      metadata: { name: 'readiness-test' },
      status: {
        conditions: [
          {
            type: 'Ready',
            status: 'True',
            reason: 'ReconciliationSucceeded',
            message: 'Applied revision: main@sha1:abc123',
          },
        ],
        inventory: {
          entries: [{ id: 'apps_v1_Deployment_default_webapp', v: 'v1' }],
        },
      },
    };

    const readyResult = readinessEvaluator(readyKustomization);
    expect(readyResult.ready).toBe(true);
    expect(readyResult.message).toBe('Kustomization is ready with 1 applied resources');

    // Test with a not ready Kustomization
    const notReadyKustomization = {
      apiVersion: 'kustomize.toolkit.fluxcd.io/v1',
      kind: 'Kustomization',
      metadata: { name: 'readiness-test' },
      status: {
        conditions: [
          {
            type: 'Ready',
            status: 'False',
            reason: 'BuildFailed',
            message: 'Kustomization build failed',
          },
        ],
      },
    };

    const notReadyResult = readinessEvaluator(notReadyKustomization);
    expect(notReadyResult.ready).toBe(false);
    expect(notReadyResult.reason).toBe('BuildFailed');
    expect(notReadyResult.message).toBe('Kustomization build failed');
  });
});
