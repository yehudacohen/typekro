#!/usr/bin/env bun

/**
 * Documentation Examples Validation Script
 * 
 * This script extracts TypeScript code blocks from markdown files
 * and validates they follow the correct TypeKro API patterns.
 */

import { glob } from 'glob';
import { readFileSync } from 'fs';

interface ValidationResult {
  file: string;
  line: number;
  issue: string;
  severity: 'error' | 'warning';
}

function validateMarkdownFile(filePath: string): ValidationResult[] {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const results: ValidationResult[] = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Check for old toResourceGraph API patterns
    if (line.includes('toResourceGraph(') && line.includes("'")) {
      // Check if it's the old string-first API
      const match = line.match(/toResourceGraph\(\s*['"`]([^'"`]+)['"`]/);
      if (match) {
        results.push({
          file: filePath,
          line: i + 1,
          issue: `Old API: toResourceGraph('${match[1]}', ...) should use object syntax: toResourceGraph({ name: '${match[1]}', ... }, ...)`,
          severity: 'error'
        });
      }
    }
    
    // Check for old schema patterns
    if (line.includes('schema: {') && line.includes('spec:')) {
      results.push({
        file: filePath,
        line: i + 1,
        issue: 'Old schema syntax: should use { spec: Schema, status: Schema } directly in toResourceGraph config',
        severity: 'error'
      });
    }
    
    // Check for statusMappings usage
    if (line.includes('statusMappings:')) {
      results.push({
        file: filePath,
        line: i + 1,
        issue: 'Old statusMappings: should use StatusBuilder function as third parameter',
        severity: 'error'
      });
    }
    
    // Check for missing Cel expressions in status builders
    if (line.includes('resources.') && line.includes('.status.') && !line.includes('Cel.')) {
      // This might be in a status builder context
      if (content.substring(0, content.indexOf(line)).includes('(schema, resources)')) {
        results.push({
          file: filePath,
          line: i + 1,
          issue: 'Status builder should use Cel.expr<Type>() or Cel.template() for dynamic values',
          severity: 'warning'
        });
      }
    }
  }
  
  return results;
}

async function main() {
  console.log('🔍 Validating TypeKro documentation for API consistency...\n');
  
  const markdownFiles = await glob('docs/**/*.md');
  
  let totalIssues = 0;
  let errorCount = 0;
  let warningCount = 0;
  
  for (const file of markdownFiles) {
    const results = validateMarkdownFile(file);
    
    if (results.length > 0) {
      console.log(`📄 ${file}:`);
      
      for (const result of results) {
        const icon = result.severity === 'error' ? '❌' : '⚠️';
        console.log(`  ${icon} Line ${result.line}: ${result.issue}`);
        
        if (result.severity === 'error') errorCount++;
        else warningCount++;
        totalIssues++;
      }
      console.log();
    }
  }
  
  console.log(`📊 Validation Summary:`);
  console.log(`Files checked: ${markdownFiles.length}`);
  console.log(`Total issues: ${totalIssues}`);
  console.log(`Errors: ${errorCount}`);
  console.log(`Warnings: ${warningCount}`);
  
  if (errorCount > 0) {
    console.log(`\n❌ Found ${errorCount} API compatibility errors that need fixing.`);
    process.exit(1);
  } else if (warningCount > 0) {
    console.log(`\n⚠️ Found ${warningCount} warnings. Consider updating for better patterns.`);
  } else {
    console.log(`\n✅ All documentation follows current TypeKro API patterns!`);
  }
}

if (import.meta.main) {
  main().catch(console.error);
}
