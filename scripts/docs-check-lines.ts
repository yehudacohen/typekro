#!/usr/bin/env bun

/**
 * Documentation Line Count Checker
 * 
 * Validates line count constraints from the design document:
 * - README: ≤ 500 lines
 * - Hero example: ≤ 30 lines
 * - Individual examples: ≤ 50 lines each
 */

import { glob } from 'glob';
import { readFileSync, existsSync } from 'fs';

interface LineCountResult {
  file: string;
  type: 'readme' | 'hero' | 'example';
  lineCount: number;
  limit: number;
  status: 'pass' | 'fail';
}

const CONFIG = {
  readme: 500,
  heroExample: 30,
  examples: 50
};

/**
 * Count lines in a file
 */
function countLines(filePath: string): number {
  const content = readFileSync(filePath, 'utf-8');
  return content.split('\n').length;
}

/**
 * Extract TypeScript code blocks from markdown
 */
function extractCodeBlocks(filePath: string): { code: string; line: number; isHero: boolean }[] {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const blocks: { code: string; line: number; isHero: boolean }[] = [];
  
  let inCodeBlock = false;
  let currentBlock = '';
  let blockStartLine = 0;
  let isTypeScript = false;
  let isFirstBlock = true;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    if (line.startsWith('```typescript') || line.startsWith('```ts')) {
      inCodeBlock = true;
      isTypeScript = true;
      currentBlock = '';
      blockStartLine = i + 1;
    } else if (line.startsWith('```') && inCodeBlock) {
      if (isTypeScript && currentBlock.trim()) {
        blocks.push({ 
          code: currentBlock, 
          line: blockStartLine,
          isHero: isFirstBlock && filePath.includes('index.md')
        });
        isFirstBlock = false;
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
 * Count non-empty lines in code
 */
function countCodeLines(code: string): number {
  return code.split('\n').filter(line => line.trim().length > 0).length;
}

async function main(): Promise<void> {
  console.log('📏 TypeKro Documentation Line Count Check\n');
  console.log('═'.repeat(60) + '\n');
  
  const results: LineCountResult[] = [];
  
  // Check README
  console.log('📄 Checking README.md...');
  if (existsSync('README.md')) {
    const lineCount = countLines('README.md');
    results.push({
      file: 'README.md',
      type: 'readme',
      lineCount,
      limit: CONFIG.readme,
      status: lineCount <= CONFIG.readme ? 'pass' : 'fail'
    });
    console.log(`   ${lineCount <= CONFIG.readme ? '✅' : '❌'} ${lineCount} lines (limit: ${CONFIG.readme})`);
  } else {
    console.log('   ⚠️  README.md not found');
  }
  
  // Check hero example in docs/index.md
  console.log('\n🦸 Checking hero example in docs/index.md...');
  if (existsSync('docs/index.md')) {
    const blocks = extractCodeBlocks('docs/index.md');
    const heroBlock = blocks.find(b => b.isHero);
    
    if (heroBlock) {
      const lineCount = countCodeLines(heroBlock.code);
      results.push({
        file: 'docs/index.md (hero)',
        type: 'hero',
        lineCount,
        limit: CONFIG.heroExample,
        status: lineCount <= CONFIG.heroExample ? 'pass' : 'fail'
      });
      console.log(`   ${lineCount <= CONFIG.heroExample ? '✅' : '❌'} ${lineCount} lines (limit: ${CONFIG.heroExample})`);
    } else {
      console.log('   ⚠️  No hero example found');
    }
  }
  
  // Check example files
  console.log('\n📝 Checking example code blocks...');
  const exampleFiles = await glob('docs/examples/**/*.md');
  
  let exampleViolations = 0;
  
  for (const file of exampleFiles) {
    const blocks = extractCodeBlocks(file);
    
    for (const block of blocks) {
      const lineCount = countCodeLines(block.code);
      const status = lineCount <= CONFIG.examples ? 'pass' : 'fail';
      
      results.push({
        file: `${file}:${block.line}`,
        type: 'example',
        lineCount,
        limit: CONFIG.examples,
        status
      });
      
      if (status === 'fail') {
        exampleViolations++;
        console.log(`   ❌ ${file}:${block.line} - ${lineCount} lines (limit: ${CONFIG.examples})`);
      }
    }
  }
  
  if (exampleViolations === 0) {
    console.log(`   ✅ All ${results.filter(r => r.type === 'example').length} example blocks within limits`);
  }
  
  // Summary
  console.log('\n' + '═'.repeat(60));
  console.log('\n📊 Summary\n');
  
  const failures = results.filter(r => r.status === 'fail');
  const passes = results.filter(r => r.status === 'pass');
  
  console.log(`  Total checks: ${results.length}`);
  console.log(`  ✅ Passed: ${passes.length}`);
  console.log(`  ❌ Failed: ${failures.length}`);
  
  if (failures.length > 0) {
    console.log('\n❌ Line count violations found:');
    for (const failure of failures) {
      console.log(`   - ${failure.file}: ${failure.lineCount} lines (limit: ${failure.limit})`);
    }
    process.exit(1);
  } else {
    console.log('\n✅ All line count checks passed!');
    process.exit(0);
  }
}

if (import.meta.main) {
  main().catch(console.error);
}
