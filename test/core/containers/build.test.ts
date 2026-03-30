/**
 * Unit tests for container build utility.
 *
 * Tests input validation, registry resolution, content hashing,
 * and error handling. Docker CLI calls are tested via integration tests.
 */

import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { ContainerBuildError } from '../../../src/core/containers/errors.js';
import { validateBuildArgs } from '../../../src/core/containers/exec.js';
import { resolveRegistry } from '../../../src/core/containers/registries/index.js';
import { OrbstackRegistryHandler } from '../../../src/core/containers/registries/orbstack.js';
import { EcrRegistryHandler } from '../../../src/core/containers/registries/ecr.js';

describe('Container Build', () => {
  describe('resolveRegistry', () => {
    it('should return OrbstackRegistryHandler for orbstack type', () => {
      const handler = resolveRegistry({ type: 'orbstack' });
      expect(handler).toBeInstanceOf(OrbstackRegistryHandler);
    });

    it('should return EcrRegistryHandler for ecr type', () => {
      const handler = resolveRegistry({ type: 'ecr' });
      expect(handler).toBeInstanceOf(EcrRegistryHandler);
    });

    it('should throw for gcr (not yet implemented)', () => {
      expect(() => resolveRegistry({ type: 'gcr', projectId: 'test' })).toThrow(
        ContainerBuildError
      );
    });

    it('should throw for acr (not yet implemented)', () => {
      expect(() => resolveRegistry({ type: 'acr', registryName: 'test' })).toThrow(
        ContainerBuildError
      );
    });
  });

  describe('OrbstackRegistryHandler', () => {
    const handler = new OrbstackRegistryHandler();

    it('should resolve image URI without registry prefix', async () => {
      const uri = await handler.resolveImageUri('my-app', 'v1.0');
      expect(uri).toBe('my-app:v1.0');
    });

    it('should resolve with latest tag', async () => {
      const uri = await handler.resolveImageUri('my-app', 'latest');
      expect(uri).toBe('my-app:latest');
    });

    it('should not throw on authenticate (no-op)', async () => {
      await handler.authenticate();
    });

    it('should not throw on push (no-op)', async () => {
      await handler.push('my-app:latest', 'my-app');
    });
  });

  describe('EcrRegistryHandler', () => {
    it('should resolve image URI with explicit account and region', async () => {
      const handler = new EcrRegistryHandler({
        type: 'ecr',
        accountId: '123456789012',
        region: 'us-west-2',
      });
      const uri = await handler.resolveImageUri('my-app', 'v1.0');
      expect(uri).toBe('123456789012.dkr.ecr.us-west-2.amazonaws.com/my-app:v1.0');
    });

    it('should use default region when not specified', async () => {
      const originalRegion = process.env.AWS_REGION;
      process.env.AWS_REGION = 'eu-west-1';
      try {
        const handler = new EcrRegistryHandler({
          type: 'ecr',
          accountId: '123456789012',
        });
        const uri = await handler.resolveImageUri('my-app', 'latest');
        expect(uri).toContain('eu-west-1');
      } finally {
        if (originalRegion) {
          process.env.AWS_REGION = originalRegion;
        } else {
          delete process.env.AWS_REGION;
        }
      }
    });

    it('should pass credentials config through to SDK provider chain', () => {
      // Verify the handler accepts credential options without error
      const handler = new EcrRegistryHandler({
        type: 'ecr',
        accountId: '123456789012',
        region: 'us-west-2',
        credentials: {
          profile: 'my-profile',
          roleArn: 'arn:aws:iam::123456789012:role/deploy',
          roleSessionName: 'test-session',
        },
      });
      expect(handler).toBeInstanceOf(EcrRegistryHandler);
    });
  });

  describe('ContainerBuildError', () => {
    it('should create dockerNotAvailable error with suggestions', () => {
      const err = ContainerBuildError.dockerNotAvailable('daemon not running');
      expect(err.code).toBe('DOCKER_NOT_AVAILABLE');
      expect(err.message).toContain('daemon not running');
      expect(err.suggestions.length).toBeGreaterThan(0);
    });

    it('should create buildFailed error with exit code', () => {
      const err = ContainerBuildError.buildFailed(1, 'COPY failed');
      expect(err.code).toBe('BUILD_FAILED');
      expect(err.message).toContain('exit code 1');
      expect(err.message).toContain('COPY failed');
    });

    it('should create ecrAuthFailed error with suggestions', () => {
      const err = ContainerBuildError.ecrAuthFailed(new Error('expired token'));
      expect(err.code).toBe('ECR_AUTH_FAILED');
      expect(err.suggestions).toContain('Verify AWS credentials: aws sts get-caller-identity');
    });

    it('should create pushFailed error', () => {
      const err = ContainerBuildError.pushFailed('my-app:latest', new Error('denied'));
      expect(err.code).toBe('PUSH_FAILED');
      expect(err.message).toContain('my-app:latest');
    });

    it('should create registryNotSupported error', () => {
      const err = ContainerBuildError.registryNotSupported('gcr');
      expect(err.code).toBe('REGISTRY_NOT_SUPPORTED');
      expect(err.message).toContain('gcr');
    });
  });

  describe('buildContainer input validation', () => {
    it('should throw for non-existent context directory', async () => {
      const { buildContainer } = await import('../../../src/core/containers/build.js');
      await expect(
        buildContainer({
          context: '/nonexistent/path',
          imageName: 'test',
          registry: { type: 'orbstack' },
        })
      ).rejects.toThrow('Build context directory not found');
    });

    it('should throw for missing Dockerfile', async () => {
      const { buildContainer } = await import('../../../src/core/containers/build.js');
      // Use a real directory that exists but has no Dockerfile
      await expect(
        buildContainer({
          context: join(import.meta.dir, '..'),
          imageName: 'test',
          dockerfile: 'Dockerfile.nonexistent',
          registry: { type: 'orbstack' },
        })
      ).rejects.toThrow('Dockerfile not found');
    });
  });

  describe('validateBuildArgs', () => {
    it('should accept valid build arg keys', () => {
      expect(() => validateBuildArgs({ NODE_ENV: 'production', _private: 'yes', arg2: 'val' })).not.toThrow();
    });

    it('should reject keys starting with digits', () => {
      expect(() => validateBuildArgs({ '2fast': 'val' })).toThrow('Invalid build arg key');
    });

    it('should reject keys that look like Docker flags', () => {
      expect(() => validateBuildArgs({ '--platform': 'linux/amd64' })).toThrow('Invalid build arg key');
    });

    it('should reject keys with hyphens', () => {
      expect(() => validateBuildArgs({ 'my-arg': 'val' })).toThrow('Invalid build arg key');
    });

    it('should reject empty keys', () => {
      expect(() => validateBuildArgs({ '': 'val' })).toThrow('Invalid build arg key');
    });

    it('should reject values with newlines', () => {
      expect(() => validateBuildArgs({ NODE_ENV: 'prod\nduction' })).toThrow('contains newlines');
    });
  });

  describe('computeContentHash', () => {
    it('should produce deterministic hashes for the same content', async () => {
      const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { computeContentHash } = await import('../../../src/core/containers/build.js');

      const dir = mkdtempSync(join(tmpdir(), 'typekro-hash-'));
      try {
        const dockerfile = join(dir, 'Dockerfile');
        writeFileSync(dockerfile, 'FROM alpine:3.19\nRUN echo hello');
        writeFileSync(join(dir, 'app.ts'), 'console.log("hello")');
        mkdirSync(join(dir, 'src'));
        writeFileSync(join(dir, 'src', 'index.ts'), 'export const x = 1;');

        const hash1 = await computeContentHash(dir, dockerfile);
        const hash2 = await computeContentHash(dir, dockerfile);
        expect(hash1).toBe(hash2);
        expect(hash1).toMatch(/^sha-[a-f0-9]{12}$/);
      } finally {
        const { rmSync } = await import('node:fs');
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('should change hash when file content changes', async () => {
      const { mkdtempSync, writeFileSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { computeContentHash } = await import('../../../src/core/containers/build.js');

      const dir = mkdtempSync(join(tmpdir(), 'typekro-hash-'));
      try {
        const dockerfile = join(dir, 'Dockerfile');
        writeFileSync(dockerfile, 'FROM alpine:3.19');
        writeFileSync(join(dir, 'app.ts'), 'console.log("v1")');

        const hash1 = await computeContentHash(dir, dockerfile);

        writeFileSync(join(dir, 'app.ts'), 'console.log("v2")');
        const hash2 = await computeContentHash(dir, dockerfile);

        expect(hash1).not.toBe(hash2);
      } finally {
        const { rmSync } = await import('node:fs');
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('should produce same hash regardless of file creation order', async () => {
      const { mkdtempSync, writeFileSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { computeContentHash } = await import('../../../src/core/containers/build.js');

      const dir1 = mkdtempSync(join(tmpdir(), 'typekro-hash-'));
      const dir2 = mkdtempSync(join(tmpdir(), 'typekro-hash-'));
      try {
        // Create files in different order
        writeFileSync(join(dir1, 'Dockerfile'), 'FROM alpine');
        writeFileSync(join(dir1, 'b.ts'), 'b');
        writeFileSync(join(dir1, 'a.ts'), 'a');

        writeFileSync(join(dir2, 'Dockerfile'), 'FROM alpine');
        writeFileSync(join(dir2, 'a.ts'), 'a');
        writeFileSync(join(dir2, 'b.ts'), 'b');

        const h1 = await computeContentHash(dir1, join(dir1, 'Dockerfile'));
        const h2 = await computeContentHash(dir2, join(dir2, 'Dockerfile'));
        expect(h1).toBe(h2);
      } finally {
        const { rmSync } = await import('node:fs');
        rmSync(dir1, { recursive: true, force: true });
        rmSync(dir2, { recursive: true, force: true });
      }
    });

    it('should respect .dockerignore when present', async () => {
      const { mkdtempSync, writeFileSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { computeContentHash } = await import('../../../src/core/containers/build.js');

      const dir = mkdtempSync(join(tmpdir(), 'typekro-hash-'));
      try {
        const dockerfile = join(dir, 'Dockerfile');
        writeFileSync(dockerfile, 'FROM alpine');
        writeFileSync(join(dir, 'app.ts'), 'console.log("hello")');
        writeFileSync(join(dir, 'README.md'), 'initial readme');

        // Without .dockerignore — README is hashed
        const hash1 = await computeContentHash(dir, dockerfile);

        // Add .dockerignore that excludes README.md
        writeFileSync(join(dir, '.dockerignore'), 'README.md\n');
        const hash2 = await computeContentHash(dir, dockerfile);

        // Change README — hash should NOT change because it's ignored
        writeFileSync(join(dir, 'README.md'), 'changed readme');
        const hash3 = await computeContentHash(dir, dockerfile);

        expect(hash2).toBe(hash3); // README changes don't affect hash
        expect(hash1).not.toBe(hash2); // Adding .dockerignore changes the set of hashed files
      } finally {
        const { rmSync } = await import('node:fs');
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('imageName validation', () => {
    it('should reject image names with uppercase', async () => {
      const { buildContainer } = await import('../../../src/core/containers/build.js');
      const { mkdtempSync, writeFileSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const dir = mkdtempSync(join(tmpdir(), 'typekro-name-'));
      writeFileSync(join(dir, 'Dockerfile'), 'FROM alpine');
      try {
        await expect(
          buildContainer({ context: dir, imageName: 'MyApp', registry: { type: 'orbstack' } })
        ).rejects.toThrow('Invalid image name');
      } finally {
        const { rmSync } = await import('node:fs');
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('should reject image names with trailing separators', async () => {
      const { buildContainer } = await import('../../../src/core/containers/build.js');
      const { mkdtempSync, writeFileSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const dir = mkdtempSync(join(tmpdir(), 'typekro-name-'));
      writeFileSync(join(dir, 'Dockerfile'), 'FROM alpine');
      try {
        await expect(
          buildContainer({ context: dir, imageName: 'my-app/', registry: { type: 'orbstack' } })
        ).rejects.toThrow('Invalid image name');
        await expect(
          buildContainer({ context: dir, imageName: 'my-app.', registry: { type: 'orbstack' } })
        ).rejects.toThrow('Invalid image name');
      } finally {
        const { rmSync } = await import('node:fs');
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('should reject image names with spaces', async () => {
      const { buildContainer } = await import('../../../src/core/containers/build.js');
      const { mkdtempSync, writeFileSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const dir = mkdtempSync(join(tmpdir(), 'typekro-name-'));
      writeFileSync(join(dir, 'Dockerfile'), 'FROM alpine');
      try {
        await expect(
          buildContainer({ context: dir, imageName: 'my app', registry: { type: 'orbstack' } })
        ).rejects.toThrow('Invalid image name');
      } finally {
        const { rmSync } = await import('node:fs');
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
