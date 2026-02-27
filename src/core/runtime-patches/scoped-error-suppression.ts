/**
 * Scoped Error Suppression Utility
 * 
 * Provides a way to suppress specific types of errors during cleanup operations
 * without affecting global error handling.
 */

import { getComponentLogger } from '../logging/index.js';

const logger = getComponentLogger('scoped-error-suppression');

let finalCleanupHandlerInstalled = false;
let suppressFinalConnectionResets: ((error: Error) => void) | null = null;

/**
 * Execute a function with comprehensive connection reset error suppression
 * This patches all output streams to catch connection reset exceptions wherever they appear
 */
export async function withConnectionResetSuppression<T>(
  fn: () => Promise<T>,
  context: string = 'cleanup'
): Promise<T> {
  // Store original methods to restore later
  const originalConsoleError = console.error;
  const originalConsoleLog = console.log;
  const originalStderrWrite = process.stderr.write;
  const originalStdoutWrite = process.stdout.write;
  
  // Create suppression function
  const suppressConnectionReset = (message: string): boolean => {
    return message.includes('ConnResetException') && 
           message.includes('aborted') && 
           message.includes('ECONNRESET');
  };
  
  // Patch console.error
  const patchedConsoleError = (...args: any[]) => {
    const message = args.join(' ');
    if (suppressConnectionReset(message)) {
      logger.debug(`Suppressed connection reset exception during ${context}`, {
        originalMessage: message
      });
      return;
    }
    originalConsoleError.apply(console, args);
  };
  
  // Patch console.log (in case exceptions go there)
  const patchedConsoleLog = (...args: any[]) => {
    const message = args.join(' ');
    if (suppressConnectionReset(message)) {
      logger.debug(`Suppressed connection reset exception during ${context}`, {
        originalMessage: message
      });
      return;
    }
    originalConsoleLog.apply(console, args);
  };
  
  // Patch stderr.write
  const patchedStderrWrite = function(this: any, chunk: any, encoding?: any, callback?: any) {
    const message = chunk.toString();
    if (suppressConnectionReset(message)) {
      logger.debug(`Suppressed connection reset exception during ${context}`, {
        originalMessage: message.trim()
      });
      // Call callback if provided to maintain stream behavior
      if (typeof encoding === 'function') {
        encoding(); // encoding is actually the callback
      } else if (callback) {
        callback();
      }
      return true;
    }
    return originalStderrWrite.call(this, chunk, encoding, callback);
  };
  
  // Patch stdout.write (in case exceptions go there)
  const patchedStdoutWrite = function(this: any, chunk: any, encoding?: any, callback?: any) {
    const message = chunk.toString();
    if (suppressConnectionReset(message)) {
      logger.debug(`Suppressed connection reset exception during ${context}`, {
        originalMessage: message.trim()
      });
      // Call callback if provided to maintain stream behavior
      if (typeof encoding === 'function') {
        encoding(); // encoding is actually the callback
      } else if (callback) {
        callback();
      }
      return true;
    }
    return originalStdoutWrite.call(this, chunk, encoding, callback);
  };
  
  try {
    // Patch all output methods
    console.error = patchedConsoleError;
    console.log = patchedConsoleLog;
    process.stderr.write = patchedStderrWrite;
    process.stdout.write = patchedStdoutWrite;
    
    // Execute the function
    return await fn();
  } finally {
    // Always restore all original methods
    console.error = originalConsoleError;
    console.log = originalConsoleLog;
    process.stderr.write = originalStderrWrite;
    process.stdout.write = originalStdoutWrite;
  }
}

/**
 * Synchronous version for non-async cleanup operations
 */
export function withConnectionResetSuppressionSync<T>(
  fn: () => T,
  context: string = 'cleanup'
): T {
  // Store original methods to restore later
  const originalConsoleError = console.error;
  const originalConsoleLog = console.log;
  const originalStderrWrite = process.stderr.write;
  const originalStdoutWrite = process.stdout.write;
  
  // Create suppression function
  const suppressConnectionReset = (message: string): boolean => {
    return message.includes('ConnResetException') && 
           message.includes('aborted') && 
           message.includes('ECONNRESET');
  };
  
  // Patch console.error
  const patchedConsoleError = (...args: any[]) => {
    const message = args.join(' ');
    if (suppressConnectionReset(message)) {
      logger.debug(`Suppressed connection reset exception during ${context}`, {
        originalMessage: message
      });
      return;
    }
    originalConsoleError.apply(console, args);
  };
  
  // Patch console.log
  const patchedConsoleLog = (...args: any[]) => {
    const message = args.join(' ');
    if (suppressConnectionReset(message)) {
      logger.debug(`Suppressed connection reset exception during ${context}`, {
        originalMessage: message
      });
      return;
    }
    originalConsoleLog.apply(console, args);
  };
  
  // Patch stderr.write
  const patchedStderrWrite = function(this: any, chunk: any, encoding?: any, callback?: any) {
    const message = chunk.toString();
    if (suppressConnectionReset(message)) {
      logger.debug(`Suppressed connection reset exception during ${context}`, {
        originalMessage: message.trim()
      });
      if (typeof encoding === 'function') {
        encoding();
      } else if (callback) {
        callback();
      }
      return true;
    }
    return originalStderrWrite.call(this, chunk, encoding, callback);
  };
  
  // Patch stdout.write
  const patchedStdoutWrite = function(this: any, chunk: any, encoding?: any, callback?: any) {
    const message = chunk.toString();
    if (suppressConnectionReset(message)) {
      logger.debug(`Suppressed connection reset exception during ${context}`, {
        originalMessage: message.trim()
      });
      if (typeof encoding === 'function') {
        encoding();
      } else if (callback) {
        callback();
      }
      return true;
    }
    return originalStdoutWrite.call(this, chunk, encoding, callback);
  };
  
  try {
    // Patch all output methods
    console.error = patchedConsoleError;
    console.log = patchedConsoleLog;
    process.stderr.write = patchedStderrWrite;
    process.stdout.write = patchedStdoutWrite;
    
    // Execute the function
    return fn();
  } finally {
    // Always restore all original methods immediately
    console.error = originalConsoleError;
    console.log = originalConsoleLog;
    process.stderr.write = originalStderrWrite;
    process.stdout.write = originalStdoutWrite;
  }
}

/**
 * Install a final cleanup handler to suppress connection reset exceptions during process exit
 * This should be called once during application initialization
 */
export function installFinalCleanupHandler(): void {
  if (finalCleanupHandlerInstalled) {
    return; // Already installed
  }
  
  finalCleanupHandlerInstalled = true;
  
  suppressFinalConnectionResets = (error: Error) => {
    if (error.message?.includes('aborted') && (error as any).code === 'ECONNRESET') {
      // Suppress these final connection reset exceptions silently
      logger.debug('Suppressed final connection reset exception during process exit', {
        message: error.message,
        code: (error as any).code
      });
      return;
    }
    // Re-throw unexpected errors
    throw error;
  };
  
  // Add handler for final cleanup phase
  process.on('uncaughtException', suppressFinalConnectionResets);
  
  logger.debug('Installed final cleanup handler for connection reset suppression');
}

/**
 * Remove the final cleanup handler to allow process to exit naturally
 */
export function removeFinalCleanupHandler(): void {
  if (suppressFinalConnectionResets) {
    process.removeListener('uncaughtException', suppressFinalConnectionResets);
    suppressFinalConnectionResets = null;
    finalCleanupHandlerInstalled = false;
    logger.debug('Removed final cleanup handler for connection reset suppression');
  }
}