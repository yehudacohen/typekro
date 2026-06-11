/**
 * Unit tests for the `container()` image utility — a memoized async builder that resolves to a
 * shaped result. `buildContainer` is injected (a fake builder) so these run without a Docker daemon
 * and without globally mocking the build module.
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import {
  type ContainerImage,
  clearContainerCache,
  container,
  splitImageUri,
} from '../../../src/core/containers/image.js';
import type {
  ContainerBuildOptions,
  ContainerBuildResult,
} from '../../../src/core/containers/registries/types.js';

const makeFakeBuild =
  (calls: string[]) =>
  async (opts: ContainerBuildOptions): Promise<ContainerBuildResult> => {
    calls.push(opts.imageName);
    return {
      imageUri: `123.dkr.ecr.us-east-2.amazonaws.com/${opts.imageName}:${opts.tag}`,
      tag: String(opts.tag),
      duration: 1,
      pushed: true,
    };
  };

beforeEach(() => clearContainerCache());

describe('splitImageUri', () => {
  it('splits a tag-form URI (registry-port aware)', () => {
    expect(splitImageUri('123.dkr.ecr.us-east-2.amazonaws.com/app:sha-abc')).toEqual({
      repository: '123.dkr.ecr.us-east-2.amazonaws.com/app',
      tag: 'sha-abc',
    });
  });
  it('splits a digest-form URI', () => {
    expect(splitImageUri('reg/app@sha256:deadbeef')).toEqual({
      repository: 'reg/app',
      tag: 'sha256:deadbeef',
    });
  });
  it('defaults to :latest when no tag', () => {
    expect(splitImageUri('reg/app')).toEqual({ repository: 'reg/app', tag: 'latest' });
  });
});

describe('container()', () => {
  it('resolves to a shaped result (imageUri + split repository/tag), defaulting tag to content-hash', async () => {
    const calls: string[] = [];
    const img: ContainerImage = await container(
      { context: './app', imageName: 'app', registry: { type: 'ecr' } },
      makeFakeBuild(calls)
    );
    expect(img.imageUri).toBe('123.dkr.ecr.us-east-2.amazonaws.com/app:content-hash');
    expect(img.repository).toBe('123.dkr.ecr.us-east-2.amazonaws.com/app');
    expect(img.tag).toBe('content-hash');
    expect(calls).toEqual(['app']);
  });

  it('honors an explicit tag over the content-hash default', async () => {
    const img = await container(
      { context: './app', imageName: 'app', tag: 'v1', registry: { type: 'ecr' } },
      makeFakeBuild([])
    );
    expect(img.tag).toBe('v1');
    expect(img.imageUri).toBe('123.dkr.ecr.us-east-2.amazonaws.com/app:v1');
  });

  it('memoizes by identity — awaiting the same container many times builds ONCE', async () => {
    const calls: string[] = [];
    const build = makeFakeBuild(calls);
    const opts = { context: './app', imageName: 'shared', registry: { type: 'ecr' as const } };
    const [a, b, c] = await Promise.all([
      container(opts, build),
      container(opts, build),
      container(opts, build),
    ]);
    expect(calls).toEqual(['shared']); // built once despite three awaits
    expect(a.imageUri).toBe(b.imageUri);
    expect(b.imageUri).toBe(c.imageUri);
  });

  it('distinct ids build separately even with a shared imageName', async () => {
    const calls: string[] = [];
    const build = makeFakeBuild(calls);
    await container(
      { context: './a', imageName: 'svc', id: 'a', registry: { type: 'ecr' } },
      build
    );
    await container(
      { context: './b', imageName: 'svc', id: 'b', registry: { type: 'ecr' } },
      build
    );
    expect(calls).toEqual(['svc', 'svc']); // two builds (distinct identities)
  });
});
