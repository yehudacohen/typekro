/**
 * Characterization tests for PathResolver (path-resolver.ts)
 *
 * These tests capture the CURRENT behavior of the path resolution system
 * as a safety net for future refactoring (Phase 2). They test through the
 * public API — no mocking required; filesystem tests use temp directories.
 *
 * Organized by area:
 *   1. Error classes — construction and static factories
 *   2. parseGitPath — pure parsing, no I/O
 *   3. resolveLocalContent — filesystem operations with temp files
 *   4. resolveContent — routing logic
 *   5. discoverYamlFiles — directory traversal with temp dirs
 *
 * @see src/core/yaml/path-resolver.ts
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  GitContentError,
  PathResolver,
  SsrfProtectionError,
  YamlPathResolutionError,
  YamlProcessingError,
} from '../../src/core/yaml/path-resolver.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'typekro-pathresolver-test-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/** Write a file to the temp directory */
function writeFile(relativePath: string, content: string): string {
  const fullPath = path.join(tempDir, relativePath);
  const dir = path.dirname(fullPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf-8');
  return fullPath;
}

// ===========================================================================
// 1. Error classes
// ===========================================================================

describe('YamlPathResolutionError', () => {
  it('sets name, code, resourceName, path, and suggestions', () => {
    const err = new YamlPathResolutionError('test msg', 'myResource', '/path', ['hint1']);
    expect(err.name).toBe('YamlPathResolutionError');
    expect(err.code).toBe('YAML_PATH_RESOLUTION_ERROR');
    expect(err.resourceName).toBe('myResource');
    expect(err.path).toBe('/path');
    expect(err.suggestions).toEqual(['hint1']);
    expect(err.message).toBe('test msg');
  });

  it('extends Error', () => {
    const err = new YamlPathResolutionError('test', 'r', '/p');
    expect(err).toBeInstanceOf(Error);
  });

  describe('.invalidGitUrl()', () => {
    it('returns error with correct message format and suggestions', () => {
      const err = YamlPathResolutionError.invalidGitUrl('myRes', 'git:bad');
      expect(err).toBeInstanceOf(YamlPathResolutionError);
      expect(err.message).toContain('myRes');
      expect(err.message).toContain('git:bad');
      expect(err.suggestions).toBeDefined();
      expect(err.suggestions!.length).toBeGreaterThan(0);
    });
  });

  describe('.fileNotFound()', () => {
    it('returns error with correct message and suggestions', () => {
      const err = YamlPathResolutionError.fileNotFound('myRes', '/no/such/file');
      expect(err).toBeInstanceOf(YamlPathResolutionError);
      expect(err.message).toContain('myRes');
      expect(err.message).toContain('/no/such/file');
      expect(err.suggestions!.length).toBeGreaterThan(0);
    });
  });

  describe('.directoryNotFound()', () => {
    it('returns error with correct message and suggestions', () => {
      const err = YamlPathResolutionError.directoryNotFound('myRes', '/no/such/dir');
      expect(err).toBeInstanceOf(YamlPathResolutionError);
      expect(err.message).toContain('myRes');
      expect(err.message).toContain('/no/such/dir');
      expect(err.suggestions!.length).toBeGreaterThan(0);
    });
  });
});

describe('GitContentError', () => {
  it('sets GIT_CONTENT_ERROR code', () => {
    const err = new GitContentError('msg', 'res', 'git:path');
    expect(err.code).toBe('GIT_CONTENT_ERROR');
    expect(err.name).toBe('GitContentError');
  });

  describe('.repositoryNotFound()', () => {
    it('returns error with correct fields', () => {
      const err = GitContentError.repositoryNotFound('myRes', 'git:github.com/o/r/f');
      expect(err).toBeInstanceOf(GitContentError);
      expect(err.message).toContain('myRes');
      expect(err.suggestions!.length).toBeGreaterThan(0);
    });
  });

  describe('.authenticationFailed()', () => {
    it('returns error with authentication message', () => {
      const err = GitContentError.authenticationFailed('myRes', 'git:github.com/o/r/f');
      expect(err.message).toContain('authentication');
    });
  });

  describe('.pathNotFound()', () => {
    it('returns error including pathInRepo', () => {
      const err = GitContentError.pathNotFound('myRes', 'git:repo', 'some/path');
      expect(err.message).toContain('some/path');
    });
  });
});

describe('YamlProcessingError', () => {
  it('sets YAML_PROCESSING_ERROR code', () => {
    const err = new YamlProcessingError('msg', 'res', '/file');
    expect(err.code).toBe('YAML_PROCESSING_ERROR');
    expect(err.name).toBe('YamlProcessingError');
  });

  describe('.invalidYaml()', () => {
    it('includes line number when provided', () => {
      const err = YamlProcessingError.invalidYaml('myRes', '/file.yaml', 42);
      expect(err.message).toContain('line 42');
      expect(err.line).toBe(42);
    });

    it('omits line info when not provided', () => {
      const err = YamlProcessingError.invalidYaml('myRes', '/file.yaml');
      expect(err.message).not.toContain('line');
      expect(err.line).toBeUndefined();
    });

    it('includes resource name and file path', () => {
      const err = YamlProcessingError.invalidYaml('myRes', '/file.yaml');
      expect(err.message).toContain('myRes');
      expect(err.message).toContain('/file.yaml');
    });
  });
});

describe('SsrfProtectionError', () => {
  it('sets SSRF_PROTECTION_ERROR code', () => {
    const err = new SsrfProtectionError('msg', 'res', 'http://evil', 'reason');
    expect(err.code).toBe('SSRF_PROTECTION_ERROR');
    expect(err.name).toBe('SsrfProtectionError');
    expect(err.blockedUrl).toBe('http://evil');
    expect(err.reason).toBe('reason');
  });
});

// ===========================================================================
// 2. parseGitPath
// ===========================================================================

describe('PathResolver.parseGitPath()', () => {
  const resolver = new PathResolver();

  it('parses valid git URL with @ref', () => {
    const result = resolver.parseGitPath('git:github.com/owner/repo/path/file.yaml@v1.0');
    expect(result).toEqual({
      host: 'github.com',
      owner: 'owner',
      repo: 'repo',
      path: 'path/file.yaml',
      ref: 'v1.0',
    });
  });

  it('defaults ref to "main" when @ref is omitted', () => {
    const result = resolver.parseGitPath('git:github.com/owner/repo/file.yaml');
    expect(result.ref).toBe('main');
  });

  it('parses deeply nested path', () => {
    const result = resolver.parseGitPath('git:github.com/o/r/a/b/c/d.yaml@v2');
    expect(result.path).toBe('a/b/c/d.yaml');
    expect(result.ref).toBe('v2');
  });

  it('throws YamlPathResolutionError for missing path component', () => {
    expect(() => resolver.parseGitPath('git:github.com/owner/repo')).toThrow(
      YamlPathResolutionError
    );
  });

  it('throws YamlPathResolutionError for completely invalid format', () => {
    expect(() => resolver.parseGitPath('not-a-git-url')).toThrow(YamlPathResolutionError);
  });

  it('throws YamlPathResolutionError for empty string', () => {
    expect(() => resolver.parseGitPath('')).toThrow(YamlPathResolutionError);
  });

  it('includes resourceName in error message', () => {
    try {
      resolver.parseGitPath('bad-url', 'myResource');
      expect.unreachable('should throw');
    } catch (e) {
      expect((e as YamlPathResolutionError).message).toContain('myResource');
    }
  });
});

// ===========================================================================
// 3. resolveLocalContent
// ===========================================================================

describe('PathResolver.resolveLocalContent()', () => {
  const resolver = new PathResolver();

  it('reads existing YAML file with absolute path', async () => {
    const filePath = writeFile('test.yaml', 'apiVersion: v1\nkind: ConfigMap');
    const content = await resolver.resolveLocalContent(filePath, 'testRes');
    expect(content).toBe('apiVersion: v1\nkind: ConfigMap');
  });

  it('throws YamlPathResolutionError when file does not exist', async () => {
    const badPath = path.join(tempDir, 'nonexistent.yaml');
    await expect(resolver.resolveLocalContent(badPath, 'res')).rejects.toThrow(
      YamlPathResolutionError
    );
  });

  it('throws when path points to a directory', async () => {
    fs.mkdirSync(path.join(tempDir, 'subdir'), { recursive: true });
    await expect(resolver.resolveLocalContent(path.join(tempDir, 'subdir'), 'res')).rejects.toThrow(
      YamlPathResolutionError
    );
  });

  it('defaults resourceName to "unknown"', async () => {
    const badPath = path.join(tempDir, 'nope.yaml');
    try {
      await resolver.resolveLocalContent(badPath);
      expect.unreachable('should throw');
    } catch (e) {
      expect((e as YamlPathResolutionError).message).toContain('unknown');
    }
  });

  it('reads files with various extensions', async () => {
    const ymlPath = writeFile('test.yml', 'kind: Service');
    const content = await resolver.resolveLocalContent(ymlPath);
    expect(content).toBe('kind: Service');
  });
});

// ===========================================================================
// 4. resolveContent routing
// ===========================================================================

describe('PathResolver.resolveContent()', () => {
  const resolver = new PathResolver();

  it('routes local file paths and returns source: "local"', async () => {
    const filePath = writeFile('routing-test.yaml', 'hello');
    const result = await resolver.resolveContent(filePath, 'testRes');
    expect(result.source).toBe('local');
    expect(result.content).toBe('hello');
    expect(result.originalPath).toBe(filePath);
    expect(result.resolvedPath).toBeDefined();
  });

  it('provides resolvedPath for local files', async () => {
    const filePath = writeFile('resolve-path.yaml', 'content');
    const result = await resolver.resolveContent(filePath);
    // absolute path should be the same as provided
    expect(result.resolvedPath).toBe(filePath);
  });
});

// ===========================================================================
// 5. discoverYamlFiles
// ===========================================================================

describe('PathResolver.discoverYamlFiles()', () => {
  const resolver = new PathResolver();

  it('discovers .yaml and .yml files in flat directory', async () => {
    writeFile('a.yaml', 'content-a');
    writeFile('b.yml', 'content-b');
    writeFile('c.txt', 'not-yaml');

    const files = await resolver.discoverYamlFiles(tempDir, undefined, 'testRes');
    const relativePaths = files.map((f) => f.relativePath).sort();

    expect(relativePaths).toContain('a.yaml');
    expect(relativePaths).toContain('b.yml');
    expect(relativePaths).not.toContain('c.txt');
  });

  it('discovers files in nested subdirectories (recursive)', async () => {
    writeFile('top.yaml', 'top');
    writeFile('sub/nested.yaml', 'nested');
    writeFile('sub/deep/deeper.yml', 'deeper');

    const files = await resolver.discoverYamlFiles(tempDir, { recursive: true }, 'testRes');
    const relativePaths = files.map((f) => f.relativePath).sort();

    expect(relativePaths).toContain('top.yaml');
    expect(relativePaths).toContain(path.join('sub', 'nested.yaml'));
    expect(relativePaths).toContain(path.join('sub', 'deep', 'deeper.yml'));
  });

  it('only discovers top-level files with recursive: false', async () => {
    writeFile('top.yaml', 'top');
    writeFile('sub/nested.yaml', 'nested');

    const files = await resolver.discoverYamlFiles(tempDir, { recursive: false }, 'testRes');
    const relativePaths = files.map((f) => f.relativePath);

    expect(relativePaths).toContain('top.yaml');
    expect(relativePaths).not.toContain(path.join('sub', 'nested.yaml'));
  });

  it('throws for non-existent directory', async () => {
    await expect(
      resolver.discoverYamlFiles('/tmp/no-such-dir-xyz-12345', undefined, 'res')
    ).rejects.toThrow(YamlPathResolutionError);
  });

  it('throws when path is a file not a directory', async () => {
    const filePath = writeFile('afile.yaml', 'content');
    await expect(resolver.discoverYamlFiles(filePath, undefined, 'res')).rejects.toThrow(
      YamlPathResolutionError
    );
  });

  it('returns content for each discovered file', async () => {
    writeFile('data.yaml', 'key: value');
    const files = await resolver.discoverYamlFiles(tempDir, undefined, 'testRes');
    const dataFile = files.find((f) => f.relativePath === 'data.yaml');
    expect(dataFile).toBeDefined();
    expect(dataFile!.content).toBe('key: value');
  });

  it('include filter with simple glob does NOT match due to regex conversion bug', async () => {
    // QUIRK: `deploy*` is not correctly converted to a working regex.
    // The `*` is not escaped to `\*` first, so the replacement `\*` → `[^/]*`
    // never fires. The resulting regex `^deploy*$` means "deplo" + zero or more "y",
    // which does NOT match "deploy.yaml". Both files are excluded.
    writeFile('deploy.yaml', 'deploy');
    writeFile('service.yaml', 'service');
    writeFile('values.txt', 'not-yaml');

    const files = await resolver.discoverYamlFiles(tempDir, { include: ['deploy*'] }, 'testRes');
    const relativePaths = files.map((f) => f.relativePath);

    // Neither file matches the broken pattern
    expect(relativePaths).not.toContain('deploy.yaml');
    expect(relativePaths).not.toContain('service.yaml');
    expect(relativePaths).toEqual([]);
  });

  it('include filter with *.ext pattern works correctly', async () => {
    // The `*.ext` fast path (startsWith('*.') && !includes('/')) works correctly
    writeFile('deploy.yaml', 'deploy');
    writeFile('service.yaml', 'service');
    writeFile('values.txt', 'not-yaml');

    const files = await resolver.discoverYamlFiles(tempDir, { include: ['*.yaml'] }, 'testRes');
    const relativePaths = files.map((f) => f.relativePath).sort();

    expect(relativePaths).toContain('deploy.yaml');
    expect(relativePaths).toContain('service.yaml');
    expect(relativePaths).not.toContain('values.txt');
  });

  it('exclude filter with simple glob does NOT exclude due to same regex bug', async () => {
    // QUIRK: Same bug as include — `skip*` becomes regex `^skip*$` which means
    // "ski" + zero or more "p", so it does NOT match "skip.yaml".
    // Both files are included because the exclude pattern fails to match.
    writeFile('keep.yaml', 'keep');
    writeFile('skip.yaml', 'skip');

    const files = await resolver.discoverYamlFiles(tempDir, { exclude: ['skip*'] }, 'testRes');
    const relativePaths = files.map((f) => f.relativePath).sort();

    // Both files pass the default include (**/*.yaml) and the broken exclude
    expect(relativePaths).toContain('keep.yaml');
    expect(relativePaths).toContain('skip.yaml');
  });

  it('exclude filter with *.ext pattern works correctly', async () => {
    // The `*.ext` fast path works for exclude too
    writeFile('keep.yaml', 'keep');
    writeFile('skip.yml', 'skip');

    const files = await resolver.discoverYamlFiles(tempDir, { exclude: ['*.yml'] }, 'testRes');
    const relativePaths = files.map((f) => f.relativePath);

    expect(relativePaths).toContain('keep.yaml');
    expect(relativePaths).not.toContain('skip.yml');
  });
});

// ===========================================================================
// 6. pathResolver singleton
// ===========================================================================

describe('pathResolver singleton', async () => {
  const { pathResolver } = await import('../../src/core/yaml/path-resolver.js');

  it('is an instance of PathResolver', () => {
    expect(pathResolver).toBeInstanceOf(PathResolver);
  });

  it('has parseGitPath method', () => {
    expect(typeof pathResolver.parseGitPath).toBe('function');
  });
});
