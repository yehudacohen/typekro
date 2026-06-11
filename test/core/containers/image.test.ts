/**
 * Unit tests for the `container()` first-class image utility + its deploy-time resolution.
 *
 * `container()` and ref detection are pure (no Docker). The resolution pass delegates to
 * `buildContainer`, which is mocked here so substitution + dedup are tested without a Docker daemon.
 */

import { describe, expect, it, mock } from 'bun:test';
import { container, isContainerImageRef } from '../../../src/core/containers/image.js';
import { hasContainerImageRefs } from '../../../src/core/containers/resolve.js';

describe('container() image utility', () => {
  it('returns an imageUri that is a ContainerImageRef carrying the build options', () => {
    const img = container({ context: './app', imageName: 'app', registry: { type: 'ecr' } });
    expect(isContainerImageRef(img.imageUri)).toBe(true);
    const ref = img.imageUri as unknown as {
      containerId: string;
      buildOptions: { imageName: string };
    };
    expect(ref.containerId).toBe('app');
    expect(ref.buildOptions.imageName).toBe('app');
  });

  it('uses an explicit id for identity when imageName is shared', () => {
    const a = container({
      context: './a',
      imageName: 'shared',
      id: 'a',
      registry: { type: 'ecr' },
    });
    const b = container({
      context: './b',
      imageName: 'shared',
      id: 'b',
      registry: { type: 'ecr' },
    });
    const idOf = (i: typeof a) => (i.imageUri as unknown as { containerId: string }).containerId;
    expect(idOf(a)).toBe('a');
    expect(idOf(b)).toBe('b');
  });

  it('isContainerImageRef rejects plain strings, objects, and KubernetesRef-like values', () => {
    expect(isContainerImageRef('nginx:latest')).toBe(false);
    expect(isContainerImageRef({ image: 'x' })).toBe(false);
    expect(isContainerImageRef(null)).toBe(false);
    expect(isContainerImageRef(undefined)).toBe(false);
  });

  it('hasContainerImageRefs finds a ref nested in a resource manifest', () => {
    const img = container({ context: './app', imageName: 'app', registry: { type: 'ecr' } });
    const deploymentLike = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      spec: { template: { spec: { containers: [{ name: 'c', image: img.imageUri }] } } },
    };
    expect(hasContainerImageRefs([deploymentLike])).toBe(true);
    expect(hasContainerImageRefs([{ kind: 'Service', spec: { ports: [{ port: 80 }] } }])).toBe(
      false
    );
  });
});

describe('resolveContainerImages', () => {
  it('builds each distinct container once and substitutes the literal URI in place', async () => {
    const calls: string[] = [];
    mock.module('../../../src/core/containers/build.js', () => ({
      buildContainer: async (opts: { imageName: string }) => {
        calls.push(opts.imageName);
        return {
          imageUri: `123.dkr.ecr.us-east-1.amazonaws.com/${opts.imageName}:sha-abc`,
          tag: 'sha-abc',
          duration: 1,
          pushed: true,
        };
      },
      computeContentHash: async () => 'sha-abc',
    }));
    // Import AFTER the mock so resolve.ts binds the mocked buildContainer.
    const { resolveContainerImages } = await import('../../../src/core/containers/resolve.js');

    const img = container({ context: './app', imageName: 'app', registry: { type: 'ecr' } });
    // Two resources reference the SAME container — must build only once.
    const dep = {
      kind: 'Deployment',
      spec: { template: { spec: { containers: [{ name: 'c', image: img.imageUri }] } } },
    };
    const dep2 = {
      kind: 'Deployment',
      spec: { template: { spec: { containers: [{ name: 'c2', image: img.imageUri }] } } },
    };

    const resolved = await resolveContainerImages([dep, dep2]);

    const uri = '123.dkr.ecr.us-east-1.amazonaws.com/app:sha-abc';
    expect(calls).toEqual(['app']); // built ONCE despite two references
    expect(resolved.get('app')).toBe(uri);
    expect(dep.spec.template.spec.containers[0]?.image).toBe(uri);
    expect(dep2.spec.template.spec.containers[0]?.image).toBe(uri);
    expect(isContainerImageRef(dep.spec.template.spec.containers[0]?.image)).toBe(false); // replaced by a literal
  });
});
