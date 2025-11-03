/**
 * Test the connection reset output filter
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { installConnectionResetOutputFilter, removeConnectionResetOutputFilter } from '../../src/core/utils/output-filter.js';

describe('Connection Reset Output Filter', () => {
  let capturedLogs: string[] = [];
  let originalConsoleError: typeof console.error;

  beforeEach(() => {
    capturedLogs = [];
    originalConsoleError = console.error;
    
    // Capture console.error output
    console.error = (...args: any[]) => {
      capturedLogs.push(args.join(' '));
    };
  });

  afterEach(() => {
    console.error = originalConsoleError;
    removeConnectionResetOutputFilter();
  });

  it('should filter connection reset exceptions', () => {
    installConnectionResetOutputFilter();
    
    // Simulate connection reset exception
    console.error('ConnResetException: aborted\ncode: "ECONNRESET"\nat new ConnResetException (internal:http:99:10)');
    
    // Simulate normal error
    console.error('Normal error message');
    
    // Should only have the normal error, connection reset should be filtered
    expect(capturedLogs).toHaveLength(1);
    expect(capturedLogs[0]).toBe('Normal error message');
  });

  it('should pass through non-connection-reset errors', () => {
    installConnectionResetOutputFilter();
    
    // Various normal error messages
    console.error('Network timeout');
    console.error('File not found');
    console.error('Permission denied');
    
    expect(capturedLogs).toHaveLength(3);
    expect(capturedLogs).toEqual(['Network timeout', 'File not found', 'Permission denied']);
  });

  it('should not install multiple times', () => {
    const firstInstall = console.error;
    installConnectionResetOutputFilter();
    const afterFirstInstall = console.error;
    
    installConnectionResetOutputFilter(); // Second install
    const afterSecondInstall = console.error;
    
    // Should be the same function after both installs
    expect(afterFirstInstall).toBe(afterSecondInstall);
    expect(afterFirstInstall).not.toBe(firstInstall);
  });

  it('should properly restore console.error when removed', () => {
    const original = console.error;
    
    installConnectionResetOutputFilter();
    expect(console.error).not.toBe(original);
    
    removeConnectionResetOutputFilter();
    expect(console.error).toBe(original);
  });

  it('should filter stderr.write connection reset messages', () => {
    const capturedWrites: string[] = [];
    const originalStderrWrite = process.stderr.write;
    
    // Capture stderr.write output
    process.stderr.write = (chunk: any, encoding?: any, callback?: any): boolean => {
      capturedWrites.push(chunk.toString());
      if (typeof encoding === 'function') {
        encoding();
      } else if (callback) {
        callback();
      }
      return true;
    };
    
    try {
      installConnectionResetOutputFilter();
      
      // Simulate connection reset messages to stderr
      process.stderr.write('ConnResetException: aborted\ncode: "ECONNRESET"');
      process.stderr.write('Request.prototype.abort = function () {\n  var self = this\n  self._aborted = true');
      process.stderr.write('Normal stderr message');
      
      // Should only have the normal message, connection resets should be filtered
      expect(capturedWrites).toHaveLength(1);
      expect(capturedWrites[0]).toBe('Normal stderr message');
      
    } finally {
      process.stderr.write = originalStderrWrite;
      removeConnectionResetOutputFilter();
    }
  });

  it('should restore both console.error and stderr.write when removed', () => {
    const originalConsoleError = console.error;
    const originalStderrWrite = process.stderr.write;
    
    installConnectionResetOutputFilter();
    expect(console.error).not.toBe(originalConsoleError);
    expect(process.stderr.write).not.toBe(originalStderrWrite);
    
    removeConnectionResetOutputFilter();
    expect(console.error).toBe(originalConsoleError);
    expect(process.stderr.write).toBe(originalStderrWrite);
  });
});