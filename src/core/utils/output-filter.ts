/**
 * Output Filter for Connection Reset Exceptions
 * 
 * A non-intrusive approach that filters console output without
 * interfering with cleanup processes or creating additional handles.
 */

import { getComponentLogger } from '../logging/index.js';

const logger = getComponentLogger('output-filter');

let originalConsoleError: typeof console.error | null = null;
let originalStderrWrite: typeof process.stderr.write | null = null;
let filterInstalled = false;

/**
 * Install a global output filter that suppresses connection reset exceptions
 * This is installed once and remains active for the entire process lifecycle
 */
export function installConnectionResetOutputFilter(): void {
  if (filterInstalled) {
    return; // Already installed
  }
  
  filterInstalled = true;
  originalConsoleError = console.error;
  originalStderrWrite = process.stderr.write;
  
  // Helper function to detect connection reset patterns
  const isConnectionResetMessage = (message: string): boolean => {
    return (
      (message.includes('ConnResetException') && message.includes('aborted')) ||
      (message.includes('ECONNRESET') && message.includes('code:')) ||
      (message.includes('Request.prototype.abort') && message.includes('self._aborted')) ||
      (message.includes('socketCloseListener') && message.includes('_http_client'))
    );
  };
  
  // Patch console.error
  console.error = (...args: any[]) => {
    const message = args.join(' ');
    
    if (isConnectionResetMessage(message)) {
      logger.debug('Filtered connection reset exception from console.error', {
        originalMessage: `${message.substring(0, 100)}...`
      });
      return;
    }
    
    // Pass through all other messages
    if (originalConsoleError) {
      originalConsoleError.apply(console, args);
    }
  };
  
  // Patch stderr.write with surgical precision
  process.stderr.write = function(chunk: any, encoding?: any, callback?: any): boolean {
    const message = chunk.toString();
    
    if (isConnectionResetMessage(message)) {
      logger.debug('Filtered connection reset exception from stderr.write', {
        originalMessage: `${message.substring(0, 100)}...`
      });
      
      // Call callback if provided to maintain stream behavior
      if (typeof encoding === 'function') {
        encoding(); // encoding is actually the callback
        return true;
      } else if (callback) {
        callback();
        return true;
      }
      return true;
    }
    
    // Pass through all other messages
    if (originalStderrWrite) {
      return originalStderrWrite.call(this, chunk, encoding, callback);
    }
    return true;
  };
  
  logger.debug('Installed connection reset output filter');
}

/**
 * Remove the output filter (for testing purposes)
 */
export function removeConnectionResetOutputFilter(): void {
  if (!filterInstalled) {
    return;
  }
  
  // Restore console.error
  if (originalConsoleError) {
    console.error = originalConsoleError;
    originalConsoleError = null;
  }
  
  // Restore stderr.write
  if (originalStderrWrite) {
    process.stderr.write = originalStderrWrite;
    originalStderrWrite = null;
  }
  
  filterInstalled = false;
  
  logger.debug('Removed connection reset output filter');
}