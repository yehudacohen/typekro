/**
 * Minimal Connection Reset Suppression
 * 
 * A lightweight approach that only suppresses connection reset logs
 * without creating additional handles or interfering with stream cleanup.
 */

import { getComponentLogger } from '../logging/index.js';

const logger = getComponentLogger('minimal-suppression');

/**
 * Minimal suppression that only patches console.error temporarily
 * without touching streams or creating additional handles
 */
export async function withMinimalConnectionResetSuppression<T>(
  fn: () => Promise<T>,
  context: string = 'cleanup'
): Promise<T> {
  // Store only console.error - don't touch streams
  const originalConsoleError = console.error;
  
  // Create a minimal suppression function
  const suppressConnectionReset = (...args: any[]) => {
    const message = args.join(' ');
    if (message.includes('ConnResetException') && 
        message.includes('aborted') && 
        message.includes('ECONNRESET')) {
      logger.debug(`Suppressed connection reset exception during ${context}`, {
        originalMessage: `${message.substring(0, 100)}...`
      });
      return;
    }
    // Pass through all other logs
    originalConsoleError.apply(console, args);
  };
  
  try {
    // Only patch console.error, nothing else
    console.error = suppressConnectionReset;
    
    // Execute the function
    return await fn();
  } finally {
    // Always restore immediately
    console.error = originalConsoleError;
  }
}

/**
 * Synchronous version for non-async operations
 */
export function withMinimalConnectionResetSuppressionSync<T>(
  fn: () => T,
  context: string = 'cleanup'
): T {
  // Store only console.error - don't touch streams
  const originalConsoleError = console.error;
  
  // Create a minimal suppression function
  const suppressConnectionReset = (...args: any[]) => {
    const message = args.join(' ');
    if (message.includes('ConnResetException') && 
        message.includes('aborted') && 
        message.includes('ECONNRESET')) {
      logger.debug(`Suppressed connection reset exception during ${context}`, {
        originalMessage: `${message.substring(0, 100)}...`
      });
      return;
    }
    // Pass through all other logs
    originalConsoleError.apply(console, args);
  };
  
  try {
    // Only patch console.error, nothing else
    console.error = suppressConnectionReset;
    
    // Execute the function
    return fn();
  } finally {
    // Always restore immediately
    console.error = originalConsoleError;
  }
}