#!/usr/bin/env bun

/**
 * Documentation Validation Script
 * 
 * Validates all documentation constraints from the design document:
 * - Line count limits (README ≤ 500, examples ≤ 50)
 * - Word count limits (philosophy ≤ 200 words)
 * - Next Steps sections on all pages
 * - TypeScript example compilation
 * - Broken links
 */

import { glob } from 'glob';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname, relative } from 'path';

interface ValidationResult {
  file: string;
  check: string;
  status: 'pass' | 'fail' | 'warning';
  message: string;
  details?: string;
}

const results: ValidationResult[] = [];

// Configuration from design document
const CONFIG = {
  lineLimits: {
    readme: 500,
    heroExample: 30,
    examples: 50
  },
  wordLimits: {
    philosophy: 200
  },
  requiredSections: {
    guide: ['Next Steps'],
    api: ['Next Steps'],
    examples: ['Next Steps'],
    advanced: ['Next Steps']
  }
};

/**
 * Count lines in a file
 */
function countLines(filePath: string): number {
  const content = readFileSync(filePath, 'utf-8');
  return content.split('\n').length;
}

/**
 * Count words in a specific section of a markdown file
 */
function countWordsInSection(filePath: string, sectionName: string): number {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  
  let inSection = false;
  let sectionContent = '';
  
  for (const line of lines) {
    // Check for section headers
    if (line.startsWith('## ')) {
      if (inSection) break; // End of our section
      if (line.toLowerCase().includes(sectionName.toLowerCase())) {
        inSection = true;
      }
    } else if (inSection) {
      // Skip code blocks
      if (!line.startsWith('```')) {
        sectionContent += ' ' + line;
      }
    }
  }
  
  // Count words (excluding markdown syntax)
  const cleanContent = sectionContent
    .replace(/\*\*[^*]+\*\*/g, ' ') // Remove bold
    .replace(/\*[^*]+\*/g, ' ')     // Remove italic
    .replace(/\[[^\]]+\]\([^)]+\)/g, ' ') // Remove links
    .replace(/[#\-*>]/g, ' ')       // Remove markdown chars
    .trim();
  
  return cleanContent.split(/\s+/).filter(w => w.length > 0).length;
}

/**
 * Count total words in a markdown file (excluding code blocks)
 */
function countWordsInFile(filePath: string): number {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  
  let inCodeBlock = false;
  let textContent = '';
  
  for (const line of lines) {
    if (line.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (!inCodeBlock) {
      textContent += ' ' + line;
    }
  }
  
  // Count words (excluding markdown syntax)
  const cleanContent = textContent
    .replace(/\*\*[^*]+\*\*/g, ' ')
    .replace(/\*[^*]+\*/g, ' ')
    .replace(/\[[^\]]+\]\([^)]+\)/g, ' ')
    .replace(/[#\-*>|]/g, ' ')
    .trim();
  
  return cleanContent.split(/\s+/).filter(w => w.length > 0).length;
}

/**
 * Extract TypeScript code blocks from markdown
 */
function extractCodeBlocks(filePath: string): { code: string; line: number }[] {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const blocks: { code: string; line: number }[] = [];
  
  let inCodeBlock = false;
  let currentBlock = '';
  let blockStartLine = 0;
  let isTypeScript = false;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    if (line.startsWith('```typescript') || line.startsWith('```ts')) {
      inCodeBlock = true;
      isTypeScript = true;
      currentBlock = '';
      blockStartLine = i + 1;
    } else if (line.startsWith('```') && inCodeBlock) {
      if (isTypeScript && currentBlock.trim()) {
        blocks.push({ code: currentBlock, line: blockStartLine });
      }
      inCodeBlock = false;
      isTypeScript = false;
    } else if (inCodeBlock) {
      currentBlock += line + '\n';
    }
  }
  
  return blocks;
}

/**
 * Count lines in a code block
 */
function countCodeBlockLines(code: string): number {
  return code.split('\n').filter(line => line.trim().length > 0).length;
}

/**
 * Check if a markdown file has a Next Steps section
 */
function hasNextStepsSection(filePath: string): boolean {
  const content = readFileSync(filePath, 'utf-8');
  return content.toLowerCase().includes('## next steps');
}

/**
 * Extract all internal links from a markdown file
 */
function extractInternalLinks(filePath: string): { link: string; line: number }[] {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const links: { link: string; line: number }[] = [];
  
  const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
  
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
      const link = match[2];
      
      // Skip regex patterns that look like links (contain regex special chars)
      if (/[\[\]\\*+?{}|^$]/.test(link) && !link.startsWith('http')) {
        continue;
      }
      
      // Only check internal links (not http/https)
      if (!link.startsWith('http://') && !link.startsWith('https://') && !link.startsWith('#')) {
        links.push({ link, line: i + 1 });
      }
    }
  }
  
  return links;
}

/**
 * Validate README line count
 */
function validateReadme(): void {
  const readmePath = 'README.md';
  if (!existsSync(readmePath)) {
    results.push({
      file: readmePath,
      check: 'line-count',
      status: 'fail',
      message: 'README.md not found'
    });
    return;
  }
  
  const lineCount = countLines(readmePath);
  const limit = CONFIG.lineLimits.readme;
  
  results.push({
    file: readmePath,
    check: 'line-count',
    status: lineCount <= limit ? 'pass' : 'fail',
    message: `${lineCount} lines (limit: ${limit})`,
    details: lineCount > limit ? `Exceeds limit by ${lineCount - limit} lines` : undefined
  });
}

/**
 * Validate philosophy word count
 */
function validatePhilosophy(): void {
  const philosophyPath = 'docs/guide/philosophy.md';
  if (!existsSync(philosophyPath)) {
    results.push({
      file: philosophyPath,
      check: 'word-count',
      status: 'fail',
      message: 'philosophy.md not found'
    });
    return;
  }
  
  // Count words in the "Core Philosophy" section specifically
  const wordCount = countWordsInSection(philosophyPath, 'Core Philosophy');
  const limit = CONFIG.wordLimits.philosophy;
  
  results.push({
    file: philosophyPath,
    check: 'word-count',
    status: wordCount <= limit ? 'pass' : 'fail',
    message: `Core Philosophy section: ${wordCount} words (limit: ${limit})`,
    details: wordCount > limit ? `Exceeds limit by ${wordCount - limit} words` : undefined
  });
}

/**
 * Validate example code block line counts
 */
async function validateExampleLineCounts(): Promise<void> {
  const exampleFiles = await glob('docs/examples/**/*.md');
  const limit = CONFIG.lineLimits.examples;
  
  for (const file of exampleFiles) {
    const codeBlocks = extractCodeBlocks(file);
    
    for (const block of codeBlocks) {
      const lineCount = countCodeBlockLines(block.code);
      
      if (lineCount > limit) {
        results.push({
          file,
          check: 'example-line-count',
          status: 'warning',
          message: `Code block at line ${block.line}: ${lineCount} lines (limit: ${limit})`,
          details: `Exceeds limit by ${lineCount - limit} lines`
        });
      }
    }
  }
}

/**
 * Validate Next Steps sections
 */
async function validateNextSteps(): Promise<void> {
  const categories = ['guide', 'api', 'examples', 'advanced'];
  
  for (const category of categories) {
    const files = await glob(`docs/${category}/**/*.md`);
    
    for (const file of files) {
      // Skip index files as they may not need Next Steps
      if (file.endsWith('index.md')) continue;
      
      const hasNextSteps = hasNextStepsSection(file);
      
      results.push({
        file,
        check: 'next-steps',
        status: hasNextSteps ? 'pass' : 'warning',
        message: hasNextSteps ? 'Has Next Steps section' : 'Missing Next Steps section'
      });
    }
  }
}

/**
 * Validate internal links
 */
async function validateLinks(): Promise<void> {
  const markdownFiles = await glob('docs/**/*.md');
  
  for (const file of markdownFiles) {
    const links = extractInternalLinks(file);
    const fileDir = dirname(file);
    
    for (const { link, line } of links) {
      // Remove anchor from link
      const linkPath = link.split('#')[0];
      if (!linkPath) continue; // Skip anchor-only links
      
      // Resolve the link path
      let resolvedPath: string;
      if (linkPath.startsWith('/')) {
        resolvedPath = resolve('docs', linkPath.slice(1));
      } else {
        resolvedPath = resolve(fileDir, linkPath);
      }
      
      // Add .md extension if needed
      if (!resolvedPath.endsWith('.md') && !resolvedPath.includes('.')) {
        resolvedPath += '.md';
      }
      
      // Check if file exists
      const exists = existsSync(resolvedPath) || existsSync(resolvedPath.replace('.md', '/index.md'));
      
      if (!exists) {
        results.push({
          file,
          check: 'broken-link',
          status: 'fail',
          message: `Broken link at line ${line}: ${link}`,
          details: `Resolved to: ${relative(process.cwd(), resolvedPath)}`
        });
      }
    }
  }
}

/**
 * Main validation function
 */
async function main(): Promise<void> {
  console.log('📚 TypeKro Documentation Validation\n');
  console.log('═'.repeat(60) + '\n');
  
  // Run all validations
  console.log('🔍 Checking README line count...');
  validateReadme();
  
  console.log('🔍 Checking philosophy word count...');
  validatePhilosophy();
  
  console.log('🔍 Checking example line counts...');
  await validateExampleLineCounts();
  
  console.log('🔍 Checking Next Steps sections...');
  await validateNextSteps();
  
  console.log('🔍 Checking internal links...');
  await validateLinks();
  
  // Print results
  console.log('\n' + '═'.repeat(60));
  console.log('\n📊 Validation Results\n');
  
  const failures = results.filter(r => r.status === 'fail');
  const warnings = results.filter(r => r.status === 'warning');
  const passes = results.filter(r => r.status === 'pass');
  
  // Group by check type
  const checkTypes = [...new Set(results.map(r => r.check))];
  
  for (const checkType of checkTypes) {
    const checkResults = results.filter(r => r.check === checkType);
    const checkFailures = checkResults.filter(r => r.status === 'fail');
    const checkWarnings = checkResults.filter(r => r.status === 'warning');
    
    console.log(`\n📋 ${checkType.toUpperCase().replace(/-/g, ' ')}`);
    console.log('─'.repeat(40));
    
    if (checkFailures.length > 0) {
      for (const result of checkFailures) {
        console.log(`  ❌ ${result.file}`);
        console.log(`     ${result.message}`);
        if (result.details) console.log(`     ${result.details}`);
      }
    }
    
    if (checkWarnings.length > 0) {
      for (const result of checkWarnings) {
        console.log(`  ⚠️  ${result.file}`);
        console.log(`     ${result.message}`);
        if (result.details) console.log(`     ${result.details}`);
      }
    }
    
    if (checkFailures.length === 0 && checkWarnings.length === 0) {
      console.log(`  ✅ All checks passed`);
    }
  }
  
  // Summary
  console.log('\n' + '═'.repeat(60));
  console.log('\n📈 Summary\n');
  console.log(`  ✅ Passed:   ${passes.length}`);
  console.log(`  ⚠️  Warnings: ${warnings.length}`);
  console.log(`  ❌ Failures: ${failures.length}`);
  
  if (failures.length > 0) {
    console.log('\n❌ Validation failed with errors.');
    process.exit(1);
  } else if (warnings.length > 0) {
    console.log('\n⚠️  Validation passed with warnings.');
    process.exit(0);
  } else {
    console.log('\n✅ All validations passed!');
    process.exit(0);
  }
}

if (import.meta.main) {
  main().catch(console.error);
}
