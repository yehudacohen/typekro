#!/usr/bin/env bun
/**
 * E2E Test Cleanup Script
 * 
 * Cleans up the test cluster and resources created by e2e-setup.ts
 */

import { execSync } from 'node:child_process';

const CLUSTER_NAME = 'typekro-e2e-test';

async function cleanupE2EEnvironment() {
  console.log('🧹 Cleaning up E2E test environment...');

  try {
    // Delete the kind cluster
    console.log(`🗑️  Deleting kind cluster: ${CLUSTER_NAME}...`);
    execSync(`kind delete cluster --name ${CLUSTER_NAME}`, { 
      stdio: 'inherit',
      timeout: 60000 
    });
    console.log('✅ Kind cluster deleted successfully');
  } catch (error) {
    console.error('❌ Failed to delete kind cluster:', error);
    console.log('You may need to manually clean up with:');
    console.log(`  kind delete cluster --name ${CLUSTER_NAME}`);
  }

  // Clean up temp files
  try {
    console.log('🧹 Cleaning up temporary files...');
    execSync('rm -rf temp/kro-*', { stdio: 'pipe' });
    console.log('✅ Temporary files cleaned up');
  } catch (error) {
    console.log('⚠️  Some temporary files may remain in temp/ directory');
  }

  console.log('✅ E2E environment cleanup completed!');
}

// Run the cleanup if this script is executed directly
if (import.meta.main) {
  cleanupE2EEnvironment().catch((error) => {
    console.error('❌ Cleanup failed:', error);
    process.exit(1);
  });
}