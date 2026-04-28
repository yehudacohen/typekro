/**
 * Debugging utilities for composition execution
 *
 * Extracted from errors.ts to break the circular dependency:
 *   errors.ts -> logging/index.ts -> logging/config.ts -> errors.ts
 *
 * CompositionDebugger depends on logging (getComponentLogger), which
 * depends on config, which depends on TypeKroError. Keeping it in
 * errors.ts forced errors.ts to import from logging, creating the cycle.
 */

import { getComponentLogger } from './logging/index.js';

const compositionLogger = getComponentLogger('composition-debugger');

let debugMode = false;
let debugLog: string[] = [];

/**
 * Enable debug mode for composition execution
 */
function enableDebugMode(): void {
  debugMode = true;
  debugLog = [];
}

/**
 * Disable debug mode
 */
function disableDebugMode(): void {
  debugMode = false;
  debugLog = [];
}

/**
 * Check if debug mode is enabled
 */
function isDebugEnabled(): boolean {
  return debugMode;
}

/**
 * Add a debug log entry
 */
function log(phase: string, message: string, context?: Record<string, unknown>): void {
  if (!debugMode) return;

  const timestamp = new Date().toISOString();
  const contextStr = context ? ` | Context: ${JSON.stringify(context)}` : '';
  const logEntry = `[${timestamp}] ${phase}: ${message}${contextStr}`;

  debugLog.push(logEntry);

  // Also log via structured logger at debug level
  compositionLogger.debug(logEntry, { phase, ...(context ?? {}) });
}

/**
 * Get all debug logs
 */
function getDebugLogs(): string[] {
  return [...debugLog];
}

/**
 * Clear debug logs
 */
function clearDebugLogs(): void {
  debugLog = [];
}

/**
 * Create a debug summary for composition execution
 */
function createDebugSummary(
  compositionName: string,
  resourceCount: number,
  executionTimeMs: number,
  statusFields: string[]
): string {
  const summary = [
    `=== Composition Debug Summary ===`,
    `Composition: ${compositionName}`,
    `Execution Time: ${executionTimeMs}ms`,
    `Resources Created: ${resourceCount}`,
    `Status Fields: ${statusFields.join(', ')}`,
    ``,
    `=== Debug Log ===`,
    ...debugLog,
    `=== End Debug Summary ===`,
  ];

  return summary.join('\n');
}

/**
 * Log resource registration
 */
function logResourceRegistration(
  resourceId: string,
  resourceKind: string,
  factoryName: string
): void {
  log('RESOURCE_REGISTRATION', `Registered resource '${resourceId}'`, {
    resourceKind,
    factoryName,
  });
}

/**
 * Log composition execution start
 */
function logCompositionStart(compositionName: string): void {
  log('COMPOSITION_START', `Starting composition execution`, {
    compositionName,
  });
}

/**
 * Log composition execution end
 */
function logCompositionEnd(
  compositionName: string,
  resourceCount: number,
  statusFields: string[]
): void {
  log('COMPOSITION_END', `Completed composition execution`, {
    compositionName,
    resourceCount,
    statusFields,
  });
}

/**
 * Log status object validation
 */
function logStatusValidation(
  compositionName: string,
  statusObject: unknown,
  validationResult: 'success' | 'failure',
  issues?: string[]
): void {
  log('STATUS_VALIDATION', `Status validation ${validationResult}`, {
    compositionName,
    statusObjectKeys: Object.keys(statusObject || {}),
    issues,
  });
}

/**
 * Log performance metrics
 */
function logPerformanceMetrics(
  phase: string,
  startTime: number,
  endTime: number,
  additionalMetrics?: Record<string, unknown>
): void {
  const duration = endTime - startTime;
  log('PERFORMANCE', `${phase} completed in ${duration}ms`, {
    duration,
    ...additionalMetrics,
  });
}

/**
 * Debugging utilities for composition execution.
 * Provides debug mode toggling, structured logging, and performance tracking.
 */
export const CompositionDebugger = {
  enableDebugMode,
  disableDebugMode,
  isDebugEnabled,
  log,
  getDebugLogs,
  clearDebugLogs,
  createDebugSummary,
  logResourceRegistration,
  logCompositionStart,
  logCompositionEnd,
  logStatusValidation,
  logPerformanceMetrics,
} as const;
