/**
 * Path resolution system for YAML resources
 * Handles local files, directories, and Git repositories
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { TypeKroError } from '../errors.js';

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
 * Unified path resolver for local files and Git repositories
 */
export class PathResolver {
  /**
   * Resolve content from a path (local file or git: URL)
   */
  async resolveContent(filePath: string, resourceName: string = 'unknown'): Promise<ResolvedContent> {
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
   * Resolve content from a local file
   */
  async resolveLocalContent(localPath: string, resourceName: string = 'unknown'): Promise<string> {
    try {
      // Resolve relative paths
      const resolvedPath = path.isAbsolute(localPath) 
        ? localPath 
        : path.resolve(process.cwd(), localPath);

      // Check if file exists
      if (!fs.existsSync(resolvedPath)) {
        throw YamlPathResolutionError.fileNotFound(resourceName, localPath);
      }

      // Check if it's a file (not a directory)
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

      // Read file content
      return fs.readFileSync(resolvedPath, 'utf-8');
    } catch (error) {
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
        `Failed to read file for resource '${resourceName}': ${localPath}. ${error}`,
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
    
    if (!match) {
      throw YamlPathResolutionError.invalidGitUrl(resourceName, gitPath);
    }

    return {
      host: match[1]!,
      owner: match[2]!,
      repo: match[3]!,
      path: match[4]!,
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
      const apiUrl = `https://api.github.com/repos/${gitInfo.owner}/${gitInfo.repo}/contents/${gitInfo.path}?ref=${gitInfo.ref}`;
      
      const response = await fetch(apiUrl, {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'TypeKro/1.0',
          // TODO: Add authentication support for private repositories
          // 'Authorization': `token ${process.env.GITHUB_TOKEN}`,
        },
      });

      if (!response.ok) {
        if (response.status === 404) {
          // Check if it's the repository or the path that's not found
          const repoCheckUrl = `https://api.github.com/repos/${gitInfo.owner}/${gitInfo.repo}`;
          const repoResponse = await fetch(repoCheckUrl, {
            headers: {
              'Accept': 'application/vnd.github.v3+json',
              'User-Agent': 'TypeKro/1.0',
            },
          });

          if (!repoResponse.ok) {
            throw GitContentError.repositoryNotFound(resourceName, `git:${gitInfo.host}/${gitInfo.owner}/${gitInfo.repo}`);
          } else {
            throw GitContentError.pathNotFound(resourceName, `git:${gitInfo.host}/${gitInfo.owner}/${gitInfo.repo}`, gitInfo.path);
          }
        }

        if (response.status === 401 || response.status === 403) {
          throw GitContentError.authenticationFailed(resourceName, `git:${gitInfo.host}/${gitInfo.owner}/${gitInfo.repo}/${gitInfo.path}@${gitInfo.ref}`);
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

      const data = await response.json();
      
      // GitHub API returns base64-encoded content for files
      if (data.type === 'file' && data.content) {
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
    } catch (error) {
      if (error instanceof GitContentError) {
        throw error;
      }

      // Handle network and other errors
      throw new GitContentError(
        `Network error fetching Git content for resource '${resourceName}': ${error}`,
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
    const {
      recursive = true,
      include = ['**/*.yaml', '**/*.yml'],
      exclude = [],
    } = options;

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
    } catch (error) {
      if (error instanceof YamlPathResolutionError) {
        throw error;
      }

      throw new YamlPathResolutionError(
        `Failed to discover files in directory for resource '${resourceName}': ${dirPath}. ${error}`,
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
   * Recursively walk a directory and collect YAML files
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
    resourceName: string
  ): Promise<void> {
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      const relativePath = path.relative(basePath, fullPath);

      if (entry.isDirectory()) {
        if (options.recursive) {
          await this.walkDirectory(fullPath, basePath, files, options, resourceName);
        }
      } else if (entry.isFile()) {
        // Check if file matches include/exclude patterns
        if (this.matchesPatterns(relativePath, options.include) && 
            !this.matchesPatterns(relativePath, options.exclude)) {
          try {
            const content = fs.readFileSync(fullPath, 'utf-8');
            files.push({
              path: fullPath,
              relativePath,
              content,
            });
          } catch (error) {
            // Log warning but continue processing other files
            console.warn(`Warning: Could not read file ${fullPath}: ${error}`);
          }
        }
      }
    }
  }

  /**
   * Discover YAML files in a Git repository directory
   */
  private async discoverGitYamlFiles(
    gitPath: string,
    options: {
      recursive: boolean;
      include: string[];
      exclude: string[];
    },
    resourceName: string
  ): Promise<DiscoveredFile[]> {
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
      const apiUrl = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/contents/${parsed.path}?ref=${parsed.ref}`;
      
      const response = await fetch(apiUrl, {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'TypeKro/1.0',
        },
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

      const data = await response.json();
      
      if (!Array.isArray(data)) {
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
          if (this.matchesPatterns(relativePath, options.include) && 
              !this.matchesPatterns(relativePath, options.exclude)) {
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
            } catch (error) {
              // Log warning but continue processing other files
              console.warn(`Warning: Could not fetch file ${item.path}: ${error}`);
            }
          }
        } else if (item.type === 'dir' && options.recursive) {
          // Recursively process subdirectories
          const subDirFiles = await this.discoverGitYamlFiles(
            `git:${parsed.host}/${parsed.owner}/${parsed.repo}/${item.path}@${parsed.ref}`,
            options,
            resourceName
          );
          
          // Adjust relative paths for subdirectory files
          const adjustedFiles = subDirFiles.map(file => ({
            ...file,
            relativePath: path.join(item.name, file.relativePath),
          }));
          
          files.push(...adjustedFiles);
        }
      }

      return files;
    } catch (error) {
      if (error instanceof GitContentError) {
        throw error;
      }

      throw new GitContentError(
        `Network error discovering Git directory for resource '${resourceName}': ${error}`,
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
   * Check if a file path matches any of the given glob patterns
   * Simple implementation - could be enhanced with a proper glob library
   */
  private matchesPatterns(filePath: string, patterns: string[]): boolean {
    if (patterns.length === 0) {
      return false;
    }

    return patterns.some(pattern => {
      // Convert simple glob patterns to regex
      // This is a basic implementation - could use a proper glob library like minimatch
      
      try {
        // Simple cases first
        if (pattern === '*') {
          return true;
        }
        
        if (!pattern.includes('*') && !pattern.includes('?')) {
          // Exact match
          return filePath === pattern;
        }
        
        // Handle ** first (before escaping)
        let regexPattern = pattern.replace(/\*\*/g, '__DOUBLESTAR__');
        
        // Escape special regex characters except * and ?
        regexPattern = regexPattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        
        // Convert glob patterns to regex
        regexPattern = regexPattern
          .replace(/__DOUBLESTAR__/g, '.*')  // ** matches any number of directories (including /)
          .replace(/\\\*/g, '[^/]*')         // * matches any characters except /
          .replace(/\\\?/g, '.');            // ? matches any single character

        const regex = new RegExp(`^${regexPattern}$`);
        return regex.test(filePath);
      } catch (_error) {
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
   * Resolve content from an HTTP/HTTPS URL
   */
  private async resolveHttpContent(url: string, resourceName: string = 'unknown'): Promise<string> {
    try {
      const response = await fetch(url);
      
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
    } catch (error) {
      if (error instanceof YamlPathResolutionError) {
        throw error;
      }
      
      throw new YamlPathResolutionError(
        `Failed to resolve HTTP content for resource '${resourceName}': ${error instanceof Error ? error.message : String(error)}`,
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