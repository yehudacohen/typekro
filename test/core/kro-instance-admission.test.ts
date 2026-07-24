import { describe, expect, it } from 'bun:test';
import {
  assertKroInstanceSpecPreserved,
  missingKroInstanceSpecPaths,
} from '../../src/core/deployment/kro-instance-admission.js';

const desiredInstance = {
  apiVersion: 'example.com/v1alpha1',
  kind: 'Example',
  metadata: { name: 'example', namespace: 'apps' },
  spec: {
    name: 'example',
    runLauncher: {
      type: 'K8sRunLauncher',
      k8sRunLauncher: {
        envVars: [{ name: 'IMAGE', value: 'registry.example/app@sha256:abc' }],
      },
    },
  },
};

describe('KRO instance admission diagnostics', () => {
  it('finds nested desired fields omitted by API admission', () => {
    expect(
      missingKroInstanceSpecPaths(desiredInstance.spec, {
        name: 'example',
        runLauncher: { type: 'K8sRunLauncher' },
      })
    ).toEqual(['$.spec.runLauncher.k8sRunLauncher']);
  });

  it('ignores defaulted live fields', () => {
    expect(
      missingKroInstanceSpecPaths(desiredInstance.spec, {
        ...desiredInstance.spec,
        generatedDefault: true,
      })
    ).toEqual([]);
  });

  it('finds fields pruned inside array items', () => {
    expect(
      missingKroInstanceSpecPaths(desiredInstance.spec, {
        ...desiredInstance.spec,
        runLauncher: {
          type: 'K8sRunLauncher',
          k8sRunLauncher: {
            envVars: [{ name: 'IMAGE' }],
          },
        },
      })
    ).toEqual(['$.spec.runLauncher.k8sRunLauncher.envVars[0].value']);
  });

  it('finds desired array items omitted by admission', () => {
    expect(
      missingKroInstanceSpecPaths(desiredInstance.spec, {
        ...desiredInstance.spec,
        runLauncher: {
          type: 'K8sRunLauncher',
          k8sRunLauncher: {
            envVars: [],
          },
        },
      })
    ).toEqual(['$.spec.runLauncher.k8sRunLauncher.envVars[0]']);
  });

  it('fails closed with path-only diagnostics when desired fields were pruned', () => {
    expect(() =>
      assertKroInstanceSpecPreserved(desiredInstance, {
        ...desiredInstance,
        spec: {
          name: 'example',
          runLauncher: { type: 'K8sRunLauncher' },
        },
      })
    ).toThrow('$.spec.runLauncher.k8sRunLauncher');
  });

  it('accepts an admitted instance that preserves all desired fields', () => {
    expect(() =>
      assertKroInstanceSpecPreserved(desiredInstance, {
        ...desiredInstance,
        spec: {
          ...desiredInstance.spec,
          serverDefault: 'retained',
        },
      })
    ).not.toThrow();
  });

  it('ignores undefined properties omitted by Kubernetes request serialization', () => {
    expect(() =>
      assertKroInstanceSpecPreserved(
        {
          ...desiredInstance,
          spec: {
            ...desiredInstance.spec,
            optional: undefined,
          },
        },
        desiredInstance
      )
    ).not.toThrow();
  });
});
