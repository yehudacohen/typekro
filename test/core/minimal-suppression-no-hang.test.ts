/**
 * Test that minimal connection reset suppression works without hanging
 */

import { describe, it, expect } from 'bun:test';
import { withMinimalConnectionResetSuppression, withMinimalConnectionResetSuppressionSync } from '../../src/core/utils/minimal-connection-reset-suppression.js';

describe('Minimal Connection Reset Suppression', () => {
  it('should not hang when suppressing connection resets', async () => {
    const startTime = Date.now();
    
    // Test that the minimal suppression wrapper doesn't hang
    const result = await withMinimalConnectionResetSuppression(
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
    const result = withMinimalConnectionResetSuppressionSync(
      () => {
        return 'sync-success';
      },
      'test-sync-operation'
    );
    
    const duration = Date.now() - startTime;
    
    expect(result).toBe('sync-success');
    expect(duration).toBeLessThan(100); // Should complete very quickly
  });

  it('should only patch console.error and restore it properly', async () => {
    const originalConsoleError = console.error;
    const originalConsoleLog = console.log;
    const originalStderrWrite = process.stderr.write;
    const originalStdoutWrite = process.stdout.write;
    
    await withMinimalConnectionResetSuppression(
      async () => {
        // During suppression, only console.error should be patched
        expect(console.error).not.toBe(originalConsoleError);
        
        // These should NOT be patched (this is the key difference from full suppression)
        expect(console.log).toBe(originalConsoleLog);
        expect(process.stderr.write).toBe(originalStderrWrite);
        expect(process.stdout.write).toBe(originalStdoutWrite);
        
        await new Promise(resolve => setTimeout(resolve, 10));
      },
      'test-minimal-patching'
    );
    
    // After suppression, everything should be restored
    expect(console.error).toBe(originalConsoleError);
    expect(console.log).toBe(originalConsoleLog);
    expect(process.stderr.write).toBe(originalStderrWrite);
    expect(process.stdout.write).toBe(originalStdoutWrite);
  });

  it('should suppress connection reset messages', async () => {
    const capturedLogs: string[] = [];
    const originalConsoleError = console.error;
    
    // Capture what gets through the suppression
    console.error = (...args: any[]) => {
      capturedLogs.push(args.join(' '));
    };
    
    try {
      await withMinimalConnectionResetSuppression(
        async () => {
          // Simulate connection reset exception
          console.error('ConnResetException: aborted\ncode: "ECONNRESET"\nat new ConnResetException (internal:http:99:10)');
          
          // Simulate normal error that should pass through
          console.error('Normal error message');
          
          await new Promise(resolve => setTimeout(resolve, 10));
        },
        'test-suppression'
      );
      
      // Should only have the normal error, connection reset should be suppressed
      expect(capturedLogs).toHaveLength(1);
      expect(capturedLogs[0]).toBe('Normal error message');
      
    } finally {
      console.error = originalConsoleError;
    }
  });
});