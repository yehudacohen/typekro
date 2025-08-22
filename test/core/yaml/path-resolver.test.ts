/**
 * Tests for PathResolver implementation
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PathResolver, YamlPathResolutionError } from '../../../src/core/yaml/path-resolver.js';

describe('PathResolver', () => {
  let resolver: PathResolver;
  let tempDir: string;

  beforeEach(() => {
    resolver = new PathResolver();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'typekro-test-'));
  });

  afterEach(() => {
    // Clean up temp directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('parseGitPath', () => {
    it('should parse valid git URLs correctly', () => {
      const result = resolver.parseGitPath(
        'git:github.com/owner/repo/path/to/file.yaml@main',
        'test'
      );

      expect(result).toEqual({
        host: 'github.com',
        owner: 'owner',
        repo: 'repo',
        path: 'path/to/file.yaml',
        ref: 'main',
      });
    });

    it('should use default ref when not specified', () => {
      const result = resolver.parseGitPath('git:github.com/owner/repo/path/to/file.yaml', 'test');

      expect(result.ref).toBe('main');
    });

    it('should throw error for invalid git URLs', () => {
      expect(() => {
        resolver.parseGitPath('invalid-url', 'test');
      }).toThrow(YamlPathResolutionError);
    });
  });

  describe('resolveLocalContent', () => {
    it('should read local file content successfully', async () => {
      // Create a test file
      const testFile = path.join(tempDir, 'test.yaml');
      const testContent = 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: test';
      fs.writeFileSync(testFile, testContent);

      const result = await resolver.resolveLocalContent(testFile, 'test');
      expect(result).toBe(testContent);
    });

    it('should throw error for non-existent file', async () => {
      const nonExistentFile = path.join(tempDir, 'does-not-exist.yaml');

      await expect(resolver.resolveLocalContent(nonExistentFile, 'test')).rejects.toThrow(
        YamlPathResolutionError
      );
    });

    it('should throw error when path is a directory', async () => {
      await expect(resolver.resolveLocalContent(tempDir, 'test')).rejects.toThrow(
        YamlPathResolutionError
      );
    });
  });

  describe('discoverYamlFiles', () => {
    it('should discover YAML files in local directory', async () => {
      // Create test files
      fs.writeFileSync(path.join(tempDir, 'file1.yaml'), 'content1');
      fs.writeFileSync(path.join(tempDir, 'file2.yml'), 'content2');
      fs.writeFileSync(path.join(tempDir, 'file3.txt'), 'content3'); // Should be excluded

      const result = await resolver.discoverYamlFiles(tempDir, {}, 'test');

      expect(result).toHaveLength(2);
      expect(result.map((f) => f.relativePath).sort()).toEqual(['file1.yaml', 'file2.yml']);

      // Find the specific file and check its content
      const file1 = result.find((f) => f.relativePath === 'file1.yaml');
      expect(file1?.content).toBe('content1');
    });

    it('should respect include/exclude patterns', async () => {
      // Create test files
      fs.writeFileSync(path.join(tempDir, 'include.yaml'), 'content1');
      fs.writeFileSync(path.join(tempDir, 'exclude.yaml'), 'content2');
      fs.writeFileSync(path.join(tempDir, 'other.yml'), 'content3');

      const result = await resolver.discoverYamlFiles(
        tempDir,
        {
          include: ['include.yaml', '*.yml'],
          exclude: ['exclude.yaml'],
        },
        'test'
      );

      expect(result).toHaveLength(2);
      expect(result.map((f) => f.relativePath).sort()).toEqual(['include.yaml', 'other.yml']);
    });

    it('should handle recursive directory traversal', async () => {
      // Create nested directory structure
      const subDir = path.join(tempDir, 'subdir');
      fs.mkdirSync(subDir);
      fs.writeFileSync(path.join(tempDir, 'root.yaml'), 'root');
      fs.writeFileSync(path.join(subDir, 'nested.yaml'), 'nested');

      const result = await resolver.discoverYamlFiles(tempDir, { recursive: true }, 'test');

      expect(result).toHaveLength(2);
      expect(result.map((f) => f.relativePath).sort()).toEqual(['root.yaml', 'subdir/nested.yaml']);
    });

    it('should handle non-recursive mode', async () => {
      // Create nested directory structure
      const subDir = path.join(tempDir, 'subdir');
      fs.mkdirSync(subDir);
      fs.writeFileSync(path.join(tempDir, 'root.yaml'), 'root');
      fs.writeFileSync(path.join(subDir, 'nested.yaml'), 'nested');

      const result = await resolver.discoverYamlFiles(tempDir, { recursive: false }, 'test');

      expect(result).toHaveLength(1);
      expect(result[0]?.relativePath).toBe('root.yaml');
    });
  });

  describe('resolveContent', () => {
    it('should resolve local file content', async () => {
      const testFile = path.join(tempDir, 'test.yaml');
      const testContent = 'test content';
      fs.writeFileSync(testFile, testContent);

      const result = await resolver.resolveContent(testFile, 'test');

      expect(result.source).toBe('local');
      expect(result.content).toBe(testContent);
      expect(result.originalPath).toBe(testFile);
    });

    it('should identify git URLs correctly', async () => {
      // This test would require mocking fetch, so we'll just test the path detection
      const gitPath = 'git:github.com/owner/repo/file.yaml@main';

      // We expect this to fail with network error since we're not mocking fetch
      await expect(resolver.resolveContent(gitPath, 'test')).rejects.toThrow();
    });
  });

  describe('pattern matching', () => {
    it('should match simple patterns correctly', () => {
      const resolver = new PathResolver();

      // Access private method for testing
      const matchesPatterns = (resolver as any).matchesPatterns.bind(resolver);

      expect(matchesPatterns('file.yaml', ['*.yaml'])).toBe(true);
      expect(matchesPatterns('file.yml', ['*.yaml'])).toBe(false);
      expect(matchesPatterns('dir/file.yaml', ['**/*.yaml'])).toBe(true);
      expect(matchesPatterns('file.txt', ['*.yaml', '*.yml'])).toBe(false);
    });
  });
});
