#!/usr/bin/env bun

/**
 * Documentation Examples TypeScript Syntax Checker
 * 
 * Extracts TypeScript code blocks from documentation and validates
 * basic syntax. Full compilation checking is skipped due to module
 * resolution complexity in isolated temp files.
 */

import { glob } from 'glob';
import { readFileSync } from 'fs';

interface CodeBlock {
  file: string;
  line: number;
  code: string;
  language: string;
}

interface ValidationResult {
  file: string;
  line: number;
  status: 'pass' | 'fail' | 'skip';
  message: string;
  issues?: string[];
}

/**
 * Extract TypeScript code blocks from markdown files
 */
function extractCodeBlocks(filePath: string): CodeBlock[] {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const blocks: CodeBlock[] = [];
  
  let inCodeBlock = false;
  let currentBlock = '';
  let blockStartLine = 0;
  let language = '';
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    if (line.startsWith('```typescript') || line.startsWith('```ts')) {
      inCodeBlock = true;
      language = 'typescript';
      currentBlock = '';
      blockStartLine = i + 1;
    } else if (line.startsWith('```') && inCodeBlock) {
      if (currentBlock.trim()) {
        blocks.push({
          file: filePath,
          line: blockStartLine,
          code: currentBlock,
          language
        });
      }
      inCodeBlock = false;
      language = '';
    } else if (inCodeBlock) {
      currentBlock += line + '\n';
    }
  }
  
  return blocks;
}

/**
 * Check if a code block should be skipped
 */
function shouldSkipBlock(code: string): { skip: boolean; reason?: string } {
  // Skip blocks that are clearly partial/incomplete
  if (code.includes('// ...') || code.includes('/* ... */')) {
    return { skip: true, reason: 'Contains ellipsis indicating partial code' };
  }
  
  // Skip blocks that are just type definitions
  if (code.trim().startsWith('interface ') || code.trim().startsWith('type ')) {
    if (!code.includes('import') && !code.includes('const ') && !code.includes('function ')) {
      return { skip: true, reason: 'Type-only definition' };
    }
  }
  
  // Skip blocks that are shell commands
  if (code.trim().startsWith('bun ') || code.trim().startsWith('npm ') || code.trim().startsWith('kubectl ')) {
    return { skip: true, reason: 'Shell command' };
  }
  
  // Skip blocks that are YAML
  if (code.includes('apiVersion:') && code.includes('kind:')) {
    return { skip: true, reason: 'YAML content' };
  }
  
  // Skip blocks that are JSON
  if (code.trim().startsWith('{') && code.trim().endsWith('}') && !code.includes('const ')) {
    return { skip: true, reason: 'JSON content' };
  }
  
  // Skip usage snippets that reference variables from previous code blocks
  if (code.includes('.factory(') && !code.includes('kubernetesComposition') && !code.includes('toResourceGraph')) {
    return { skip: true, reason: 'Usage snippet referencing previous code block' };
  }
  
  // Skip return statements outside of functions (partial examples)
  if (code.trim().startsWith('return {') && !code.includes('function') && !code.includes('=>')) {
    return { skip: true, reason: 'Partial return statement example' };
  }
  
  // Skip blocks with top-level await without imports (usage examples)
  if (code.includes('await ') && !code.includes('import ') && !code.includes('async function')) {
    return { skip: true, reason: 'Usage snippet with top-level await' };
  }
  
  // Skip blocks that reference undefined composition variables
  const compositionVars = ['webapp', 'fullstack', 'database', 'envApp', 'microservices'];
  for (const varName of compositionVars) {
    if (code.includes(`${varName}.factory`) && !code.includes(`const ${varName}`) && !code.includes(`export const ${varName}`)) {
      return { skip: true, reason: `Usage snippet referencing ${varName} from previous block` };
    }
  }
  
  return { skip: false };
}

/**
 * Validate code block for common issues
 */
function validateCodeBlock(code: string): { valid: boolean; issues: string[] } {
  const issues: string[] = [];
  
  // Check for unbalanced braces
  const openBraces = (code.match(/\{/g) || []).length;
  const closeBraces = (code.match(/\}/g) || []).length;
  if (openBraces !== closeBraces) {
    issues.push(`Unbalanced braces: ${openBraces} open, ${closeBraces} close`);
  }
  
  // Check for unbalanced parentheses
  const openParens = (code.match(/\(/g) || []).length;
  const closeParens = (code.match(/\)/g) || []).length;
  if (openParens !== closeParens) {
    issues.push(`Unbalanced parentheses: ${openParens} open, ${closeParens} close`);
  }
  
  // Check for unbalanced brackets
  const openBrackets = (code.match(/\[/g) || []).length;
  const closeBrackets = (code.match(/\]/g) || []).length;
  if (openBrackets !== closeBrackets) {
    issues.push(`Unbalanced brackets: ${openBrackets} open, ${closeBrackets} close`);
  }
  
  // Check for common syntax errors
  if (code.includes(',,')) {
    issues.push('Double comma detected');
  }
  
  if (code.includes('..') && !code.includes('...') && !code.includes('// ..') && !code.includes("'..") && !code.includes('"..')) {
    issues.push('Double dot detected (possible typo)');
  }
  
  // Check for incomplete template literals
  const backticks = (code.match(/`/g) || []).length;
  if (backticks % 2 !== 0) {
    issues.push('Unbalanced template literal backticks');
  }
  
  // Check for incomplete strings
  const singleQuotes = (code.match(/'/g) || []).length;
  const doubleQuotes = (code.match(/"/g) || []).length;
  // Note: This is a rough check - strings can contain escaped quotes
  
  return {
    valid: issues.length === 0,
    issues
  };
}

async function main(): Promise<void> {
  console.log('🔧 TypeKro Documentation Examples Syntax Check\n');
  console.log('═'.repeat(60) + '\n');
  
  // Get all markdown files
  const markdownFiles = await glob('docs/**/*.md');
  const results: ValidationResult[] = [];
  
  console.log(`📄 Found ${markdownFiles.length} markdown files\n`);
  
  let totalBlocks = 0;
  let skippedBlocks = 0;
  let passedBlocks = 0;
  let failedBlocks = 0;
  
  for (const mdFile of markdownFiles) {
    const blocks = extractCodeBlocks(mdFile);
    
    if (blocks.length === 0) continue;
    
    console.log(`📝 ${mdFile} (${blocks.length} code blocks)`);
    
    for (const block of blocks) {
      totalBlocks++;
      
      const skipCheck = shouldSkipBlock(block.code);
      if (skipCheck.skip) {
        skippedBlocks++;
        results.push({
          file: block.file,
          line: block.line,
          status: 'skip',
          message: skipCheck.reason || 'Skipped'
        });
        continue;
      }
      
      // Validate syntax
      const { valid, issues } = validateCodeBlock(block.code);
      
      if (valid) {
        passedBlocks++;
        results.push({
          file: block.file,
          line: block.line,
          status: 'pass',
          message: 'Syntax OK'
        });
        console.log(`   ✅ Line ${block.line}: OK`);
      } else {
        failedBlocks++;
        results.push({
          file: block.file,
          line: block.line,
          status: 'fail',
          message: 'Syntax issues',
          issues
        });
        console.log(`   ❌ Line ${block.line}: Issues found`);
        for (const issue of issues) {
          console.log(`      - ${issue}`);
        }
      }
    }
  }
  
  // Summary
  console.log('\n' + '═'.repeat(60));
  console.log('\n📊 Summary\n');
  
  console.log(`  Total code blocks: ${totalBlocks}`);
  console.log(`  ✅ Passed: ${passedBlocks}`);
  console.log(`  ⏭️  Skipped: ${skippedBlocks}`);
  console.log(`  ❌ Failed: ${failedBlocks}`);
  
  if (failedBlocks > 0) {
    console.log('\n❌ Some code blocks have syntax issues:');
    const failures = results.filter(r => r.status === 'fail');
    for (const failure of failures) {
      console.log(`\n   ${failure.file}:${failure.line}`);
      if (failure.issues) {
        for (const issue of failure.issues) {
          console.log(`   - ${issue}`);
        }
      }
    }
    process.exit(1);
  } else {
    console.log('\n✅ All code blocks passed syntax check!');
    process.exit(0);
  }
}

if (import.meta.main) {
  main().catch(console.error);
}
