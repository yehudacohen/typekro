/**
 * Test that scoped connection reset suppression works without hanging
 */

import { describe, it, expect } from 'bun:test';
import { withConnectionResetSuppression, withConnectionResetSuppressionSync } from '../../src/core/utils/scoped-error-suppression.js';

describe('Scoped Connection Reset Suppression', () => {
  it('should not hang when suppressing connection resets', async () => {
    const startTime = Date.now();
    
    // Test that the suppression wrapper doesn't hang
    const result = await withConnectionResetSuppression(
      async () => {
        // Simulate some work
        await new Promise(resolve => setTimeout(resolve, 10));
        return 'success';
      },
      'test-operation'
    );
    
    const duration = Date.now() - startTime;
    
    expect(result).toBe('success');
    expect(duration).toBeLessThan(1000); // Should complete quickly, not hang
  });

  it('should handle synchronous operations without hanging', () => {
    const startTime = Date.now();
    
    // Test synchronous version
    const result = withConnectionResetSuppressionSync(
      () => {
        return 'sync-success';
      },
      'test-sync-operation'
    );
    
    const duration = Date.now() - startTime;
    
    expect(result).toBe('sync-success');
    expect(duration).toBeLessThan(100); // Should complete very quickly
  });

  it('should properly restore console methods after operation', async () => {
    const originalConsoleError = console.error;
    const originalConsoleLog = console.log;
    
    await withConnectionResetSuppression(
      async () => {
        // During suppression, console methods should be patched
        expect(console.error).not.toBe(originalConsoleError);
        expect(console.log).not.toBe(originalConsoleLog);
        
        await new Promise(resolve => setTimeout(resolve, 10));
      },
      'test-console-restoration'
    );
    
    // After suppression, console methods should be restored
    expect(console.error).toBe(originalConsoleError);
    expect(console.log).toBe(originalConsoleLog);
  });
});