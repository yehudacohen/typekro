#!/usr/bin/env bun

/**
 * Documentation Link Checker
 * 
 * Validates all internal links in documentation files:
 * - Relative links to other markdown files
 * - Anchor links within files
 * - Links to directories (index.md)
 */

import { glob } from 'glob';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname, relative, basename } from 'path';

interface LinkResult {
  file: string;
  line: number;
  link: string;
  status: 'valid' | 'broken' | 'external';
  resolvedPath?: string;
}

/**
 * Extract all headings from a markdown file for anchor validation
 */
function extractHeadings(filePath: string): string[] {
  const content = readFileSync(filePath, 'utf-8');
  const headingRegex = /^#{1,6}\s+(.+)$/gm;
  const headings: string[] = [];
  
  let match;
  while ((match = headingRegex.exec(content)) !== null) {
    // Convert heading to anchor format
    const anchor = match[1]
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-');
    headings.push(anchor);
  }
  
  return headings;
}

/**
 * Extract all links from a markdown file
 */
function extractLinks(filePath: string): { link: string; line: number; text: string }[] {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const links: { link: string; line: number; text: string }[] = [];
  
  const linkRegex = /\[([^\]]*)\]\(([^)]+)\)/g;
  
  // Track if we're inside a code block
  let inCodeBlock = false;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Toggle code block state
    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    
    // Skip links inside code blocks
    if (inCodeBlock) continue;
    
    let match;
    while ((match = linkRegex.exec(line)) !== null) {
      const linkTarget = match[2];
      
      // Skip regex patterns that look like links (contain regex special chars)
      if (/[\[\]\\*+?{}|^$]/.test(linkTarget) && !linkTarget.startsWith('http')) {
        continue;
      }
      
      links.push({
        text: match[1],
        link: linkTarget,
        line: i + 1
      });
    }
  }
  
  return links;
}

/**
 * Check if a link is valid
 */
function validateLink(
  link: string, 
  sourceFile: string,
  headingsCache: Map<string, string[]>
): LinkResult {
  const sourceDir = dirname(sourceFile);
  
  // External links
  if (link.startsWith('http://') || link.startsWith('https://')) {
    return {
      file: sourceFile,
      line: 0,
      link,
      status: 'external'
    };
  }
  
  // Parse link into path and anchor
  const [linkPath, anchor] = link.split('#');
  
  // Anchor-only links
  if (!linkPath && anchor) {
    const headings = headingsCache.get(sourceFile) || extractHeadings(sourceFile);
    headingsCache.set(sourceFile, headings);
    
    const isValid = headings.includes(anchor);
    return {
      file: sourceFile,
      line: 0,
      link,
      status: isValid ? 'valid' : 'broken',
      resolvedPath: isValid ? `${sourceFile}#${anchor}` : undefined
    };
  }
  
  // Resolve the path
  let resolvedPath: string;
  if (linkPath.startsWith('/')) {
    // Absolute path from docs root
    resolvedPath = resolve('docs', linkPath.slice(1));
  } else {
    // Relative path
    resolvedPath = resolve(sourceDir, linkPath);
  }
  
  // Try different file extensions and index files
  const pathsToTry = [
    resolvedPath,
    resolvedPath + '.md',
    resolve(resolvedPath, 'index.md'),
    resolvedPath.replace(/\/$/, '') + '.md',
    resolvedPath.replace(/\/$/, '/index.md')
  ];
  
  let foundPath: string | null = null;
  for (const path of pathsToTry) {
    if (existsSync(path)) {
      foundPath = path;
      break;
    }
  }
  
  if (!foundPath) {
    return {
      file: sourceFile,
      line: 0,
      link,
      status: 'broken',
      resolvedPath: relative(process.cwd(), resolvedPath)
    };
  }
  
  // If there's an anchor, validate it
  if (anchor) {
    const headings = headingsCache.get(foundPath) || extractHeadings(foundPath);
    headingsCache.set(foundPath, headings);
    
    if (!headings.includes(anchor)) {
      return {
        file: sourceFile,
        line: 0,
        link,
        status: 'broken',
        resolvedPath: `${relative(process.cwd(), foundPath)}#${anchor} (anchor not found)`
      };
    }
  }
  
  return {
    file: sourceFile,
    line: 0,
    link,
    status: 'valid',
    resolvedPath: relative(process.cwd(), foundPath)
  };
}

async function main(): Promise<void> {
  console.log('🔗 TypeKro Documentation Link Checker\n');
  console.log('═'.repeat(60) + '\n');
  
  const markdownFiles = await glob('docs/**/*.md');
  const results: LinkResult[] = [];
  const headingsCache = new Map<string, string[]>();
  
  console.log(`📄 Checking ${markdownFiles.length} markdown files...\n`);
  
  let totalLinks = 0;
  let validLinks = 0;
  let brokenLinks = 0;
  let externalLinks = 0;
  
  for (const file of markdownFiles) {
    const links = extractLinks(file);
    
    if (links.length === 0) continue;
    
    const fileResults: LinkResult[] = [];
    
    for (const { link, line, text } of links) {
      totalLinks++;
      
      const result = validateLink(link, file, headingsCache);
      result.line = line;
      fileResults.push(result);
      
      if (result.status === 'valid') validLinks++;
      else if (result.status === 'broken') brokenLinks++;
      else if (result.status === 'external') externalLinks++;
    }
    
    const brokenInFile = fileResults.filter(r => r.status === 'broken');
    
    if (brokenInFile.length > 0) {
      console.log(`📄 ${file}`);
      for (const result of brokenInFile) {
        console.log(`   ❌ Line ${result.line}: ${result.link}`);
        if (result.resolvedPath) {
          console.log(`      → ${result.resolvedPath}`);
        }
      }
      console.log();
    }
    
    results.push(...fileResults);
  }
  
  // Summary
  console.log('═'.repeat(60));
  console.log('\n📊 Summary\n');
  
  console.log(`  Total links: ${totalLinks}`);
  console.log(`  ✅ Valid: ${validLinks}`);
  console.log(`  🌐 External: ${externalLinks}`);
  console.log(`  ❌ Broken: ${brokenLinks}`);
  
  if (brokenLinks > 0) {
    console.log('\n❌ Broken links found:');
    const broken = results.filter(r => r.status === 'broken');
    for (const result of broken) {
      console.log(`   ${result.file}:${result.line} → ${result.link}`);
    }
    process.exit(1);
  } else {
    console.log('\n✅ All internal links are valid!');
    process.exit(0);
  }
}

if (import.meta.main) {
  main().catch(console.error);
}
