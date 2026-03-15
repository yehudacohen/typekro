/**
 * Path resolution system for YAML resources
 * Handles local files, directories, and Git repositories
 */

import * as dns from 'node:dns/promises';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import {
  DEFAULT_HTTP_READ_TIMEOUT,
  DEFAULT_MAX_DIRECTORY_DEPTH,
  DEFAULT_MAX_YAML_CONTENT_SIZE,
} from '../config/defaults.js';
import { ensureError, TypeKroError } from '../errors.js';
import { getComponentLogger } from '../logging/index.js';

const logger = getComponentLogger('yaml-path-resolver');

/** Shape of a single item in a GitHub Contents API response */
interface GitHubContentItem {
  type: string;
  name: string;
  path: string;
  content?: string;
  encoding?: string;
}

/** Validates that a value matches the expected GitHub content item shape */
function isGitHubContentItem(value: unknown): value is GitHubContentItem {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.type === 'string' && typeof obj.name === 'string' && typeof obj.path === 'string'
  );
}

/**
 * Information parsed from a git: URL
 */
export interface GitPathInfo {
  host: string;
  owner: string;
  repo: string;
  path: string;
  ref: string;
}

/**
 * Result of content resolution
 */
export interface ResolvedContent {
  content: string;
  source: 'local' | 'git' | 'http';
  originalPath: string;
  resolvedPath?: string;
}

/**
 * Result of directory discovery
 */
export interface DiscoveredFile {
  path: string;
  relativePath: string;
  content: string;
}

/**
 * YAML-specific error types
 */
export class YamlPathResolutionError extends TypeKroError {
  constructor(
    message: string,
    public readonly resourceName: string,
    public readonly path: string,
    public readonly suggestions?: string[]
  ) {
    super(message, 'YAML_PATH_RESOLUTION_ERROR', {
      resourceName,
      path,
      suggestions,
    });
    this.name = 'YamlPathResolutionError';
  }

  static invalidGitUrl(resourceName: string, userInput: string): YamlPathResolutionError {
    return new YamlPathResolutionError(
      `Invalid git URL format for resource '${resourceName}'. Expected: git:github.com/owner/repo/path@ref\nGot: ${userInput}`,
      resourceName,
      userInput,
      [
        'Use format: git:github.com/owner/repo/path@ref',
        'Example: git:github.com/fluxcd/helm-controller/config/default@main',
        'Use GitPaths.fluxHelm() for common controllers',
      ]
    );
  }

  static fileNotFound(resourceName: string, filePath: string): YamlPathResolutionError {
    return new YamlPathResolutionError(
      `File not found for resource '${resourceName}': ${filePath}`,
      resourceName,
      filePath,
      [
        'Check that the file path is correct and the file exists',
        'Ensure the file has proper read permissions',
        'For relative paths, check they are relative to the current working directory',
        'Use absolute paths if needed to avoid path resolution issues',
      ]
    );
  }

  static directoryNotFound(resourceName: string, dirPath: string): YamlPathResolutionError {
    return new YamlPathResolutionError(
      `Directory not found for resource '${resourceName}': ${dirPath}`,
      resourceName,
      dirPath,
      [
        'Check that the directory path is correct and the directory exists',
        'Ensure the directory has proper read permissions',
        'For relative paths, check they are relative to the current working directory',
        'Use absolute paths if needed to avoid path resolution issues',
      ]
    );
  }
}

export class GitContentError extends TypeKroError {
  constructor(
    message: string,
    public readonly resourceName: string,
    public readonly gitPath: string,
    public readonly suggestions?: string[]
  ) {
    super(message, 'GIT_CONTENT_ERROR', {
      resourceName,
      gitPath,
      suggestions,
    });
    this.name = 'GitContentError';
  }

  static repositoryNotFound(resourceName: string, gitPath: string): GitContentError {
    return new GitContentError(
      `Git repository not found for resource '${resourceName}': ${gitPath}`,
      resourceName,
      gitPath,
      [
        'Check that the repository exists and is accessible',
        'Verify the repository URL and path are correct',
        'For private repositories, ensure authentication is configured',
        'Try using a specific branch or tag: @main, @v1.0.0',
      ]
    );
  }

  static authenticationFailed(resourceName: string, gitPath: string): GitContentError {
    return new GitContentError(
      `Git authentication failed for resource '${resourceName}': ${gitPath}`,
      resourceName,
      gitPath,
      [
        'Ensure Git credentials are properly configured',
        'For GitHub, check that your personal access token has the required permissions',
        'For private repositories, verify you have read access',
        'Consider using SSH keys for authentication',
      ]
    );
  }

  static pathNotFound(resourceName: string, gitPath: string, pathInRepo: string): GitContentError {
    return new GitContentError(
      `Path not found in Git repository for resource '${resourceName}': ${pathInRepo} in ${gitPath}`,
      resourceName,
      gitPath,
      [
        'Check that the path exists in the specified branch/tag',
        'Verify the path is correct (case-sensitive)',
        'Try browsing the repository to confirm the path structure',
        'Ensure you are using the correct branch or tag reference',
      ]
    );
  }
}

export class YamlProcessingError extends TypeKroError {
  constructor(
    message: string,
    public readonly resourceName: string,
    public readonly filePath: string,
    public readonly line?: number,
    public readonly suggestions?: string[]
  ) {
    super(message, 'YAML_PROCESSING_ERROR', {
      resourceName,
      filePath,
      line,
      suggestions,
    });
    this.name = 'YamlProcessingError';
  }

  static invalidYaml(resourceName: string, filePath: string, line?: number): YamlProcessingError {
    const lineInfo = line ? ` at line ${line}` : '';
    return new YamlProcessingError(
      `Invalid YAML syntax in resource '${resourceName}' file '${filePath}'${lineInfo}`,
      resourceName,
      filePath,
      line,
      [
        'Check YAML syntax for proper indentation and structure',
        'Ensure all strings are properly quoted',
        'Validate YAML using a linter or online validator',
        'Check for tabs vs spaces consistency',
      ]
    );
  }
}

/**
 * Error thrown when a URL is blocked by SSRF protection.
 */
export class SsrfProtectionError extends TypeKroError {
  constructor(
    message: string,
    public readonly resourceName: string,
    public readonly blockedUrl: string,
    public readonly reason: string
  ) {
    super(message, 'SSRF_PROTECTION_ERROR', {
      resourceName,
      blockedUrl,
      reason,
    });
    this.name = 'SsrfProtectionError';
  }
}

/** Allowed URL schemes for user-provided URLs */
const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

/**
 * Cloud metadata endpoint IP addresses that must always be blocked.
 */
const BLOCKED_HOSTS = new Set(['169.254.169.254', 'metadata.google.internal']);

/**
 * Parse an IPv4 address string into a 32-bit integer.
 * Returns `null` for non-IPv4 strings.
 */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    result = (result << 8) | octet;
  }
  // Convert to unsigned 32-bit
  return result >>> 0;
}

/**
 * Check whether an IPv4 address (as a 32-bit integer) falls inside a CIDR.
 */
function isInCidr(ip: number, network: number, prefixLen: number): boolean {
  const mask = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;
  return (ip & mask) === (network & mask);
}

/** Parse a known-valid IPv4 address to an integer, throwing on failure. */
function ipv4ToIntChecked(ip: string): number {
  const result = ipv4ToInt(ip);
  if (result === null) {
    throw new TypeKroError(`Invalid hardcoded IPv4 address: ${ip}`, 'INVALID_IPV4_ADDRESS');
  }
  return result;
}

/** Private/reserved IPv4 CIDR ranges that are blocked. */
const BLOCKED_IPV4_CIDRS: Array<{ network: number; prefix: number }> = [
  { network: ipv4ToIntChecked('10.0.0.0'), prefix: 8 }, // RFC 1918
  { network: ipv4ToIntChecked('172.16.0.0'), prefix: 12 }, // RFC 1918
  { network: ipv4ToIntChecked('192.168.0.0'), prefix: 16 }, // RFC 1918
  { network: ipv4ToIntChecked('127.0.0.0'), prefix: 8 }, // Loopback
  { network: ipv4ToIntChecked('169.254.0.0'), prefix: 16 }, // Link-local
  { network: ipv4ToIntChecked('0.0.0.0'), prefix: 8 }, // "This" network
];

/** Blocked IPv6 addresses / prefixes. */
const BLOCKED_IPV6_EXACT = new Set(['::1', '::']);
const BLOCKED_IPV6_PREFIXES = ['fe80:', 'fc00:', 'fd00:'];

/**
 * Determine whether an IP address string targets a private / reserved range.
 */
function isPrivateIp(ip: string): boolean {
  // IPv4
  if (net.isIPv4(ip)) {
    const int = ipv4ToInt(ip);
    if (int === null) return false;
    return BLOCKED_IPV4_CIDRS.some((cidr) => isInCidr(int, cidr.network, cidr.prefix));
  }

  // IPv6
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (BLOCKED_IPV6_EXACT.has(lower)) return true;
    if (BLOCKED_IPV6_PREFIXES.some((prefix) => lower.startsWith(prefix))) return true;
    // IPv4-mapped IPv6 (::ffff:a.b.c.d)
    const v4Mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(lower);
    if (v4Mapped?.[1]) {
      return isPrivateIp(v4Mapped[1]);
    }
    return false;
  }

  return false;
}

/**
 * Validate that a user-provided URL is safe to fetch (SSRF protection).
 *
 * Checks:
 * - Only `http:` and `https:` schemes are allowed.
 * - Hostname must not resolve to a private/reserved IP range.
 * - Hostname must not be a known cloud metadata endpoint.
 * - Bare IPv4/IPv6 addresses are checked directly.
 *
 * @throws {SsrfProtectionError} if the URL is blocked.
 */
function validateUrlSafety(url: string, resourceName: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SsrfProtectionError(
      `Invalid URL for resource '${resourceName}': ${url}`,
      resourceName,
      url,
      'URL could not be parsed'
    );
  }

  // 1. Scheme check
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new SsrfProtectionError(
      `Blocked URL scheme '${parsed.protocol}' for resource '${resourceName}'. Only http: and https: are allowed.`,
      resourceName,
      url,
      `Disallowed scheme: ${parsed.protocol}`
    );
  }

  // 2. Hostname extraction (strip brackets from IPv6 literals)
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');

  if (!hostname) {
    throw new SsrfProtectionError(
      `URL has no hostname for resource '${resourceName}': ${url}`,
      resourceName,
      url,
      'Missing hostname'
    );
  }

  // 3. Block known metadata endpoints
  if (BLOCKED_HOSTS.has(hostname.toLowerCase())) {
    throw new SsrfProtectionError(
      `Blocked cloud metadata endpoint for resource '${resourceName}': ${hostname}`,
      resourceName,
      url,
      `Cloud metadata endpoint: ${hostname}`
    );
  }

  // 4. If hostname is an IP literal, validate directly
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new SsrfProtectionError(
        `Blocked private/reserved IP address for resource '${resourceName}': ${hostname}`,
        resourceName,
        url,
        `Private/reserved IP: ${hostname}`
      );
    }
  }

  // 5. Block suspicious hostnames that could bypass DNS (e.g. "0x7f000001", octal IPs)
  //    Also block numeric-only hostnames that may be interpreted as IPs
  if (/^(0x[\da-f]+|0\d+|\d+)$/i.test(hostname)) {
    throw new SsrfProtectionError(
      `Blocked suspicious numeric hostname for resource '${resourceName}': ${hostname}. Use a standard domain name or dotted-decimal IP.`,
      resourceName,
      url,
      `Suspicious numeric hostname: ${hostname}`
    );
  }
}

/**
 * Resolve a hostname via DNS and validate that all resolved IPs are public.
 *
 * This mitigates DNS rebinding attacks where a domain initially resolves to a
 * public IP during validation but is later changed to resolve to a private IP.
 * By resolving the DNS ourselves and validating the result, the resolved IP
 * can be used for the actual fetch.
 *
 * @returns The first valid public IP address the hostname resolves to.
 * @throws {SsrfProtectionError} if the hostname resolves to a private/reserved IP.
 */
async function resolveAndValidateHostname(
  hostname: string,
  resourceName: string,
  url: string
): Promise<string> {
  // Skip DNS resolution for IP literals — they were already validated by validateUrlSafety
  if (net.isIP(hostname)) {
    return hostname;
  }

  try {
    // Resolve hostname to IP addresses
    const addresses = await dns.resolve4(hostname).catch(() => [] as string[]);
    const addresses6 = await dns.resolve6(hostname).catch(() => [] as string[]);
    const allAddresses = [...addresses, ...addresses6];

    if (allAddresses.length === 0) {
      throw new SsrfProtectionError(
        `DNS resolution failed for hostname '${hostname}' in resource '${resourceName}': no addresses returned`,
        resourceName,
        url,
        `DNS resolution failed: ${hostname}`
      );
    }

    // Validate ALL resolved IPs are public
    for (const ip of allAddresses) {
      if (isPrivateIp(ip)) {
        throw new SsrfProtectionError(
          `DNS rebinding protection: hostname '${hostname}' resolves to private IP '${ip}' for resource '${resourceName}'`,
          resourceName,
          url,
          `DNS resolves to private IP: ${hostname} -> ${ip}`
        );
      }
    }

    // Return the first valid address for the fetch
    const firstAddress = allAddresses[0];
    if (!firstAddress) {
      throw new SsrfProtectionError(
        `DNS resolution returned empty result for hostname '${hostname}'`,
        resourceName,
        url,
        `DNS resolution empty: ${hostname}`
      );
    }
    return firstAddress;
  } catch (error: unknown) {
    if (error instanceof SsrfProtectionError) {
      throw error;
    }
    throw new SsrfProtectionError(
      `DNS resolution failed for hostname '${hostname}' in resource '${resourceName}': ${ensureError(error).message}`,
      resourceName,
      url,
      `DNS resolution error: ${hostname}`
    );
  }
}

/**
 * Unified path resolver for local files and Git repositories
 */
export class PathResolver {
  /**
   * Resolve content from a path (local file or git: URL)
   */
  async resolveContent(
    filePath: string,
    resourceName: string = 'unknown'
  ): Promise<ResolvedContent> {
    if (filePath.startsWith('git:')) {
      const content = await this.resolveGitContent(filePath, resourceName);
      return {
        content,
        source: 'git',
        originalPath: filePath,
      };
    } else if (filePath.startsWith('https://') || filePath.startsWith('http://')) {
      const content = await this.resolveHttpContent(filePath, resourceName);
      return {
        content,
        source: 'http',
        originalPath: filePath,
      };
    } else {
      const content = await this.resolveLocalContent(filePath, resourceName);
      return {
        content,
        source: 'local',
        originalPath: filePath,
        resolvedPath: path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath),
      };
    }
  }

  /**
   * Resolve content from a local file.
   * For relative paths, prevents path traversal outside the working directory.
   */
  async resolveLocalContent(localPath: string, resourceName: string = 'unknown'): Promise<string> {
    try {
      // Resolve relative paths
      const baseDir = process.cwd();
      const resolvedPath = path.isAbsolute(localPath)
        ? localPath
        : path.resolve(baseDir, localPath);

      // Prevent path traversal for relative paths: resolved path must stay under baseDir
      if (!path.isAbsolute(localPath)) {
        const normalizedResolved = path.normalize(resolvedPath);
        const normalizedBase = path.normalize(baseDir);
        if (
          !normalizedResolved.startsWith(normalizedBase + path.sep) &&
          normalizedResolved !== normalizedBase
        ) {
          throw new YamlPathResolutionError(
            `Path traversal detected for resource '${resourceName}': '${localPath}' resolves outside the working directory`,
            resourceName,
            localPath,
            [
              'Use an absolute path if you need to access files outside the working directory',
              'Remove "../" segments that escape the project root',
            ]
          );
        }
      }

      // Check if file exists
      if (!fs.existsSync(resolvedPath)) {
        throw YamlPathResolutionError.fileNotFound(resourceName, localPath);
      }

      // Check if it's a file (not a directory) and enforce size limit
      const stats = fs.statSync(resolvedPath);
      if (!stats.isFile()) {
        throw new YamlPathResolutionError(
          `Path is not a file for resource '${resourceName}': ${localPath}`,
          resourceName,
          localPath,
          [
            'Ensure the path points to a file, not a directory',
            'Use yamlDirectory() factory for directory processing',
            'Check that the path is correct',
          ]
        );
      }

      if (stats.size > DEFAULT_MAX_YAML_CONTENT_SIZE) {
        throw new YamlPathResolutionError(
          `File size ${stats.size} bytes exceeds maximum allowed size of ${DEFAULT_MAX_YAML_CONTENT_SIZE} bytes (${(DEFAULT_MAX_YAML_CONTENT_SIZE / 1_048_576).toFixed(0)} MB) for resource '${resourceName}': ${localPath}`,
          resourceName,
          localPath,
          [
            'Split large YAML files into smaller files',
            'Use yamlDirectory() to load multiple smaller files',
            'Check if the file contains unnecessary data that can be removed',
          ]
        );
      }

      // Read file content
      return fs.readFileSync(resolvedPath, 'utf-8');
    } catch (error: unknown) {
      if (error instanceof YamlPathResolutionError) {
        throw error;
      }

      // Handle other file system errors
      if (error instanceof Error) {
        if (error.message.includes('ENOENT')) {
          throw YamlPathResolutionError.fileNotFound(resourceName, localPath);
        }
        if (error.message.includes('EACCES')) {
          throw new YamlPathResolutionError(
            `Permission denied reading file for resource '${resourceName}': ${localPath}`,
            resourceName,
            localPath,
            [
              'Check file permissions and ensure read access',
              'Run with appropriate user permissions',
              'Verify the file is not locked by another process',
            ]
          );
        }
      }

      throw new YamlPathResolutionError(
        `Failed to read file for resource '${resourceName}': ${localPath}. ${ensureError(error).message}`,
        resourceName,
        localPath,
        [
          'Check that the file exists and is readable',
          'Verify file permissions',
          'Ensure the path is correct',
        ]
      );
    }
  }

  /**
   * Resolve content from a Git repository
   */
  async resolveGitContent(gitPath: string, resourceName: string = 'unknown'): Promise<string> {
    const parsed = this.parseGitPath(gitPath, resourceName);
    return this.fetchFromGit(parsed, resourceName);
  }

  /**
   * Parse a git: URL into components
   * Format: git:github.com/owner/repo/path/to/file.yaml[@ref]
   */
  parseGitPath(gitPath: string, resourceName: string = 'unknown'): GitPathInfo {
    // Match git: URLs with optional @ref suffix
    const match = gitPath.match(/^git:([^/]+)\/([^/]+)\/([^/]+)\/(.+?)(?:@(.+))?$/);

    const host = match?.[1];
    const owner = match?.[2];
    const repo = match?.[3];
    const gitFilePath = match?.[4];

    if (!host || !owner || !repo || !gitFilePath) {
      throw YamlPathResolutionError.invalidGitUrl(resourceName, gitPath);
    }

    return {
      host,
      owner,
      repo,
      path: gitFilePath,
      ref: match[5] || 'main',
    };
  }

  /**
   * Fetch content from Git repository
   * Currently supports GitHub API for public repositories
   */
  private async fetchFromGit(gitInfo: GitPathInfo, resourceName: string): Promise<string> {
    // For now, we'll implement GitHub API support
    // In the future, this could be extended to support other Git hosts
    if (gitInfo.host !== 'github.com') {
      throw new GitContentError(
        `Unsupported Git host for resource '${resourceName}': ${gitInfo.host}. Currently only github.com is supported.`,
        resourceName,
        `git:${gitInfo.host}/${gitInfo.owner}/${gitInfo.repo}/${gitInfo.path}@${gitInfo.ref}`,
        [
          'Use github.com for Git repositories',
          'Consider using local files or copying the repository locally',
          'Future versions may support additional Git hosts',
        ]
      );
    }

    try {
      // Use GitHub API to fetch file content
      // Encode path components to prevent URL injection from user-supplied values
      const encodedPath = gitInfo.path
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
      const apiUrl = `https://api.github.com/repos/${encodeURIComponent(gitInfo.owner)}/${encodeURIComponent(gitInfo.repo)}/contents/${encodedPath}?ref=${encodeURIComponent(gitInfo.ref)}`;

      const response = await fetch(apiUrl, {
        headers: {
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'TypeKro/1.0',
          // TODO: Add authentication support for private repositories
          // 'Authorization': `token ${process.env.GITHUB_TOKEN}`,
        },
        signal: AbortSignal.timeout(DEFAULT_HTTP_READ_TIMEOUT),
      });

      if (!response.ok) {
        if (response.status === 404) {
          // Check if it's the repository or the path that's not found
          const repoCheckUrl = `https://api.github.com/repos/${encodeURIComponent(gitInfo.owner)}/${encodeURIComponent(gitInfo.repo)}`;
          const repoResponse = await fetch(repoCheckUrl, {
            headers: {
              Accept: 'application/vnd.github.v3+json',
              'User-Agent': 'TypeKro/1.0',
            },
            signal: AbortSignal.timeout(DEFAULT_HTTP_READ_TIMEOUT),
          });

          if (!repoResponse.ok) {
            throw GitContentError.repositoryNotFound(
              resourceName,
              `git:${gitInfo.host}/${gitInfo.owner}/${gitInfo.repo}`
            );
          } else {
            throw GitContentError.pathNotFound(
              resourceName,
              `git:${gitInfo.host}/${gitInfo.owner}/${gitInfo.repo}`,
              gitInfo.path
            );
          }
        }

        if (response.status === 401 || response.status === 403) {
          throw GitContentError.authenticationFailed(
            resourceName,
            `git:${gitInfo.host}/${gitInfo.owner}/${gitInfo.repo}/${gitInfo.path}@${gitInfo.ref}`
          );
        }

        throw new GitContentError(
          `Failed to fetch Git content for resource '${resourceName}': HTTP ${response.status} ${response.statusText}`,
          resourceName,
          `git:${gitInfo.host}/${gitInfo.owner}/${gitInfo.repo}/${gitInfo.path}@${gitInfo.ref}`,
          [
            'Check that the repository and path exist',
            'Verify the branch or tag reference is correct',
            'For private repositories, ensure authentication is configured',
            'Check GitHub API rate limits',
          ]
        );
      }

      const data: unknown = await response.json();

      if (!isGitHubContentItem(data)) {
        throw new GitContentError(
          `Invalid GitHub API response for resource '${resourceName}': expected an object with type, name, and path fields`,
          resourceName,
          `git:${gitInfo.host}/${gitInfo.owner}/${gitInfo.repo}/${gitInfo.path}@${gitInfo.ref}`,
          [
            'The GitHub API returned an unexpected response format',
            'Check GitHub API status and try again',
          ]
        );
      }

      if (data.type === 'file' && typeof data.content === 'string') {
        return Buffer.from(data.content, 'base64').toString('utf-8');
      }

      throw new GitContentError(
        `Unexpected content type from Git repository for resource '${resourceName}': expected file, got ${data.type}`,
        resourceName,
        `git:${gitInfo.host}/${gitInfo.owner}/${gitInfo.repo}/${gitInfo.path}@${gitInfo.ref}`,
        [
          'Ensure the path points to a file, not a directory',
          'Use yamlDirectory() factory for directory processing',
          'Check that the path is correct in the repository',
        ]
      );
    } catch (error: unknown) {
      if (error instanceof GitContentError) {
        throw error;
      }

      // Handle network and other errors
      throw new GitContentError(
        `Network error fetching Git content for resource '${resourceName}': ${ensureError(error).message}`,
        resourceName,
        `git:${gitInfo.host}/${gitInfo.owner}/${gitInfo.repo}/${gitInfo.path}@${gitInfo.ref}`,
        [
          'Check your internet connection',
          'Verify the repository URL is correct',
          'Check if GitHub is accessible',
          'Consider using local files if network access is limited',
        ]
      );
    }
  }

  /**
   * Discover YAML files in a directory (local or Git)
   */
  async discoverYamlFiles(
    dirPath: string,
    options: {
      recursive?: boolean;
      include?: string[];
      exclude?: string[];
    } = {},
    resourceName: string = 'unknown'
  ): Promise<DiscoveredFile[]> {
    const { recursive = true, include = ['**/*.yaml', '**/*.yml'], exclude = [] } = options;

    if (dirPath.startsWith('git:')) {
      return this.discoverGitYamlFiles(dirPath, { recursive, include, exclude }, resourceName);
    } else {
      return this.discoverLocalYamlFiles(dirPath, { recursive, include, exclude }, resourceName);
    }
  }

  /**
   * Discover YAML files in a local directory
   */
  private async discoverLocalYamlFiles(
    dirPath: string,
    options: {
      recursive: boolean;
      include: string[];
      exclude: string[];
    },
    resourceName: string
  ): Promise<DiscoveredFile[]> {
    try {
      // Resolve relative paths
      const resolvedPath = path.isAbsolute(dirPath)
        ? dirPath
        : path.resolve(process.cwd(), dirPath);

      // Check if directory exists
      if (!fs.existsSync(resolvedPath)) {
        throw YamlPathResolutionError.directoryNotFound(resourceName, dirPath);
      }

      // Check if it's a directory
      const stats = fs.statSync(resolvedPath);
      if (!stats.isDirectory()) {
        throw new YamlPathResolutionError(
          `Path is not a directory for resource '${resourceName}': ${dirPath}`,
          resourceName,
          dirPath,
          [
            'Ensure the path points to a directory, not a file',
            'Use yamlFile() factory for single file processing',
            'Check that the path is correct',
          ]
        );
      }

      const files: DiscoveredFile[] = [];
      await this.walkDirectory(resolvedPath, resolvedPath, files, options, resourceName);

      return files;
    } catch (error: unknown) {
      if (error instanceof YamlPathResolutionError) {
        throw error;
      }

      throw new YamlPathResolutionError(
        `Failed to discover files in directory for resource '${resourceName}': ${dirPath}. ${ensureError(error).message}`,
        resourceName,
        dirPath,
        [
          'Check that the directory exists and is readable',
          'Verify directory permissions',
          'Ensure the path is correct',
        ]
      );
    }
  }

  /**
   * Recursively walk a directory and collect YAML files.
   * Enforces a maximum recursion depth to prevent issues with deeply nested
   * directories or symlink loops.
   */
  private async walkDirectory(
    currentPath: string,
    basePath: string,
    files: DiscoveredFile[],
    options: {
      recursive: boolean;
      include: string[];
      exclude: string[];
    },
    resourceName: string,
    currentDepth: number = 0,
    maxDepth: number = DEFAULT_MAX_DIRECTORY_DEPTH
  ): Promise<void> {
    if (currentDepth > maxDepth) {
      logger.warn('Maximum directory recursion depth exceeded, skipping deeper traversal', {
        currentPath,
        maxDepth,
        resourceName,
      });
      return;
    }

    const entries = fs.readdirSync(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      const relativePath = path.relative(basePath, fullPath);

      // Skip symbolic links to prevent path traversal and symlink loop attacks.
      // Symlinks could point outside the base directory or create circular references.
      if (entry.isSymbolicLink()) {
        logger.warn('Skipping symbolic link during directory walk', {
          path: fullPath,
          resourceName,
          reason: 'Symbolic links are not followed to prevent path traversal',
        });
        continue;
      }

      if (entry.isDirectory()) {
        if (options.recursive) {
          await this.walkDirectory(
            fullPath,
            basePath,
            files,
            options,
            resourceName,
            currentDepth + 1,
            maxDepth
          );
        }
      } else if (entry.isFile()) {
        // Check if file matches include/exclude patterns
        if (
          this.matchesPatterns(relativePath, options.include) &&
          !this.matchesPatterns(relativePath, options.exclude)
        ) {
          try {
            const fileStats = fs.statSync(fullPath);
            if (fileStats.size > DEFAULT_MAX_YAML_CONTENT_SIZE) {
              logger.warn('Skipping file that exceeds maximum content size during YAML discovery', {
                fullPath,
                fileSize: fileStats.size,
                maxSize: DEFAULT_MAX_YAML_CONTENT_SIZE,
              });
              continue;
            }
            const content = fs.readFileSync(fullPath, 'utf-8');
            files.push({
              path: fullPath,
              relativePath,
              content,
            });
          } catch (error: unknown) {
            // Log warning but continue processing other files
            logger.warn('Could not read file during YAML discovery', {
              fullPath,
              error: String(error),
            });
          }
        }
      }
    }
  }

  /**
   * Discover YAML files in a Git repository directory.
   * Enforces a maximum recursion depth to prevent excessive API calls
   * on deeply nested repositories.
   */
  private async discoverGitYamlFiles(
    gitPath: string,
    options: {
      recursive: boolean;
      include: string[];
      exclude: string[];
    },
    resourceName: string,
    currentDepth: number = 0,
    maxDepth: number = DEFAULT_MAX_DIRECTORY_DEPTH
  ): Promise<DiscoveredFile[]> {
    if (currentDepth > maxDepth) {
      logger.warn('Maximum Git directory recursion depth exceeded, skipping deeper traversal', {
        gitPath,
        maxDepth,
        resourceName,
      });
      return [];
    }

    const parsed = this.parseGitPath(gitPath, resourceName);

    // For now, we'll implement a simple approach using GitHub API
    // This could be enhanced to support more complex directory traversal
    if (parsed.host !== 'github.com') {
      throw new GitContentError(
        `Unsupported Git host for directory discovery in resource '${resourceName}': ${parsed.host}. Currently only github.com is supported.`,
        resourceName,
        gitPath,
        [
          'Use github.com for Git repositories',
          'Consider using local files or cloning the repository locally',
          'Future versions may support additional Git hosts',
        ]
      );
    }

    try {
      // Use GitHub API to list directory contents
      // Encode path components to prevent URL injection from user-supplied values
      const encodedDirPath = parsed.path
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
      const apiUrl = `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/contents/${encodedDirPath}?ref=${encodeURIComponent(parsed.ref)}`;

      const response = await fetch(apiUrl, {
        headers: {
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'TypeKro/1.0',
        },
        signal: AbortSignal.timeout(DEFAULT_HTTP_READ_TIMEOUT),
      });

      if (!response.ok) {
        if (response.status === 404) {
          throw GitContentError.pathNotFound(resourceName, gitPath, parsed.path);
        }
        throw new GitContentError(
          `Failed to list Git directory for resource '${resourceName}': HTTP ${response.status}`,
          resourceName,
          gitPath,
          [
            'Check that the repository and directory path exist',
            'Verify the branch or tag reference is correct',
            'For private repositories, ensure authentication is configured',
          ]
        );
      }

      const data: unknown = await response.json();

      if (!Array.isArray(data) || !data.every(isGitHubContentItem)) {
        throw new GitContentError(
          `Expected directory listing from Git repository for resource '${resourceName}', but got a file`,
          resourceName,
          gitPath,
          [
            'Ensure the path points to a directory, not a file',
            'Use yamlFile() factory for single file processing',
            'Check that the path is correct in the repository',
          ]
        );
      }

      const files: DiscoveredFile[] = [];

      // Process files in the directory
      for (const item of data) {
        if (item.type === 'file') {
          const relativePath = item.name;

          // Check if file matches include/exclude patterns
          if (
            this.matchesPatterns(relativePath, options.include) &&
            !this.matchesPatterns(relativePath, options.exclude)
          ) {
            try {
              // Fetch file content
              const fileContent = await this.resolveGitContent(
                `git:${parsed.host}/${parsed.owner}/${parsed.repo}/${item.path}@${parsed.ref}`,
                resourceName
              );

              files.push({
                path: item.path,
                relativePath,
                content: fileContent,
              });
            } catch (error: unknown) {
              // Log warning but continue processing other files
              logger.warn('Could not fetch Git file during YAML discovery', {
                path: item.path,
                error: String(error),
              });
            }
          }
        } else if (item.type === 'dir' && options.recursive) {
          // Recursively process subdirectories
          const subDirFiles = await this.discoverGitYamlFiles(
            `git:${parsed.host}/${parsed.owner}/${parsed.repo}/${item.path}@${parsed.ref}`,
            options,
            resourceName,
            currentDepth + 1,
            maxDepth
          );

          // Adjust relative paths for subdirectory files
          const adjustedFiles = subDirFiles.map((file) => ({
            ...file,
            relativePath: path.join(item.name, file.relativePath),
          }));

          files.push(...adjustedFiles);
        }
      }

      return files;
    } catch (error: unknown) {
      if (error instanceof GitContentError) {
        throw error;
      }

      throw new GitContentError(
        `Network error discovering Git directory for resource '${resourceName}': ${ensureError(error).message}`,
        resourceName,
        gitPath,
        [
          'Check your internet connection',
          'Verify the repository URL is correct',
          'Check if GitHub is accessible',
          'Consider using local files if network access is limited',
        ]
      );
    }
  }

  /**
   * Check if a file path matches any of the given glob patterns.
   * Uses a safe glob-to-regex conversion with pattern length limits to prevent ReDoS.
   */
  private matchesPatterns(filePath: string, patterns: string[]): boolean {
    if (patterns.length === 0) {
      return false;
    }

    // Maximum pattern length to prevent ReDoS via extremely long patterns
    const MAX_PATTERN_LENGTH = 1024;

    return patterns.some((pattern) => {
      try {
        // Reject overly long patterns that could cause ReDoS
        if (pattern.length > MAX_PATTERN_LENGTH) {
          return false;
        }

        // Simple cases first (no regex needed)
        if (pattern === '*') {
          return true;
        }

        if (!pattern.includes('*') && !pattern.includes('?')) {
          // Exact match
          return filePath === pattern;
        }

        // Common extension pattern: *.ext or *.{ext1,ext2}
        if (pattern.startsWith('*.') && !pattern.includes('/')) {
          const extension = pattern.substring(1); // includes the dot
          return filePath.endsWith(extension);
        }

        // Handle ** first (before escaping)
        let regexPattern = pattern.replace(/\*\*/g, '__DOUBLESTAR__');

        // Escape special regex characters except * and ?
        regexPattern = regexPattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');

        // Convert glob patterns to regex using non-greedy quantifiers where possible
        regexPattern = regexPattern
          .replace(/__DOUBLESTAR__/g, '.*?') // ** matches any path (non-greedy to limit backtracking)
          .replace(/\\\*/g, '[^/]*') // * matches any characters except /
          .replace(/\\\?/g, '[^/]'); // ? matches any single non-separator character

        const regex = new RegExp(`^${regexPattern}$`);
        return regex.test(filePath);
      } catch (_error: unknown) {
        // If regex fails, fall back to simple extension matching
        if (pattern.startsWith('*.')) {
          const extension = pattern.substring(2);
          return filePath.endsWith(`.${extension}`);
        }
        return false;
      }
    });
  }

  /**
   * Resolve content from an HTTP/HTTPS URL.
   * Validates the URL against SSRF attacks before fetching.
   */
  private async resolveHttpContent(url: string, resourceName: string = 'unknown'): Promise<string> {
    // SSRF protection: validate URL before fetching
    validateUrlSafety(url, resourceName);

    // DNS rebinding mitigation: resolve hostname and validate resolved IPs
    // are not private/reserved, then use the resolved IP for the actual fetch
    // to close the TOCTOU gap (hostname could resolve to a different IP between
    // validation and fetch).
    const parsed = new URL(url);
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    const resolvedIp = await resolveAndValidateHostname(hostname, resourceName, url);

    // Build a fetch URL that uses the resolved IP instead of the hostname,
    // so the fetch cannot be redirected to a different IP via DNS rebinding.
    // Set the Host header so the remote server can still route the request.
    const fetchUrl = new URL(url);
    const isIpLiteral = net.isIP(hostname) !== 0;
    if (!isIpLiteral) {
      // Replace hostname with validated IP; use bracket notation for IPv6
      fetchUrl.hostname = net.isIPv6(resolvedIp) ? `[${resolvedIp}]` : resolvedIp;
    }

    try {
      const response = await fetch(fetchUrl.toString(), {
        headers: isIpLiteral ? {} : { Host: hostname },
        signal: AbortSignal.timeout(DEFAULT_HTTP_READ_TIMEOUT),
      });

      if (!response.ok) {
        throw new YamlPathResolutionError(
          `Failed to fetch HTTP resource for resource '${resourceName}': HTTP ${response.status} ${response.statusText}`,
          resourceName,
          url,
          [
            'Check that the URL is correct and accessible',
            'Verify the resource exists at the specified URL',
            'Check network connectivity and firewall settings',
            'For private resources, ensure proper authentication is configured',
          ]
        );
      }

      const content = await response.text();

      if (content.length > DEFAULT_MAX_YAML_CONTENT_SIZE) {
        throw new YamlPathResolutionError(
          `HTTP response size ${content.length} bytes exceeds maximum allowed size of ${DEFAULT_MAX_YAML_CONTENT_SIZE} bytes (${(DEFAULT_MAX_YAML_CONTENT_SIZE / 1_048_576).toFixed(0)} MB) for resource '${resourceName}': ${url}`,
          resourceName,
          url,
          [
            'The remote resource is too large to process safely',
            'Consider hosting a smaller version of the file',
            'Split large YAML files into smaller files',
          ]
        );
      }

      if (!content || content.trim().length === 0) {
        throw new YamlPathResolutionError(
          `Empty content received from HTTP resource for resource '${resourceName}': ${url}`,
          resourceName,
          url,
          [
            'Check that the URL points to a valid YAML file',
            'Verify the resource is not empty',
            'Try accessing the URL directly in a browser',
          ]
        );
      }

      return content;
    } catch (error: unknown) {
      if (error instanceof YamlPathResolutionError) {
        throw error;
      }

      throw new YamlPathResolutionError(
        `Failed to resolve HTTP content for resource '${resourceName}': ${ensureError(error).message}`,
        resourceName,
        url,
        [
          'Check network connectivity',
          'Verify the URL is correct and accessible',
          'Check for any firewall or proxy issues',
          'Try accessing the URL directly to verify it works',
        ]
      );
    }
  }
}

/**
 * Default path resolver instance
 */
export const pathResolver = new PathResolver();
