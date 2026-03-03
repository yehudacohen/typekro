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

export class CompositionDebugger {
  private static debugMode = false;
  private static debugLog: string[] = [];

  /**
   * Enable debug mode for composition execution
   */
  static enableDebugMode(): void {
    CompositionDebugger.debugMode = true;
    CompositionDebugger.debugLog = [];
  }

  /**
   * Disable debug mode
   */
  static disableDebugMode(): void {
    CompositionDebugger.debugMode = false;
    CompositionDebugger.debugLog = [];
  }

  /**
   * Check if debug mode is enabled
   */
  static isDebugEnabled(): boolean {
    return CompositionDebugger.debugMode;
  }

  /**
   * Add a debug log entry
   */
  static log(phase: string, message: string, context?: Record<string, unknown>): void {
    if (!CompositionDebugger.debugMode) return;

    const timestamp = new Date().toISOString();
    const contextStr = context ? ` | Context: ${JSON.stringify(context)}` : '';
    const logEntry = `[${timestamp}] ${phase}: ${message}${contextStr}`;

    CompositionDebugger.debugLog.push(logEntry);

    // Also log via structured logger at debug level
    compositionLogger.debug(logEntry, { phase, ...(context ?? {}) });
  }

  /**
   * Get all debug logs
   */
  static getDebugLogs(): string[] {
    return [...CompositionDebugger.debugLog];
  }

  /**
   * Clear debug logs
   */
  static clearDebugLogs(): void {
    CompositionDebugger.debugLog = [];
  }

  /**
   * Create a debug summary for composition execution
   */
  static createDebugSummary(
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
      ...CompositionDebugger.debugLog,
      `=== End Debug Summary ===`,
    ];

    return summary.join('\n');
  }

  /**
   * Log resource registration
   */
  static logResourceRegistration(
    resourceId: string,
    resourceKind: string,
    factoryName: string
  ): void {
    CompositionDebugger.log('RESOURCE_REGISTRATION', `Registered resource '${resourceId}'`, {
      resourceKind,
      factoryName,
    });
  }

  /**
   * Log composition execution start
   */
  static logCompositionStart(compositionName: string): void {
    CompositionDebugger.log('COMPOSITION_START', `Starting composition execution`, {
      compositionName,
    });
  }

  /**
   * Log composition execution end
   */
  static logCompositionEnd(
    compositionName: string,
    resourceCount: number,
    statusFields: string[]
  ): void {
    CompositionDebugger.log('COMPOSITION_END', `Completed composition execution`, {
      compositionName,
      resourceCount,
      statusFields,
    });
  }

  /**
   * Log status object validation
   */
  static logStatusValidation(
    compositionName: string,
    statusObject: any,
    validationResult: 'success' | 'failure',
    issues?: string[]
  ): void {
    CompositionDebugger.log('STATUS_VALIDATION', `Status validation ${validationResult}`, {
      compositionName,
      statusObjectKeys: Object.keys(statusObject || {}),
      issues,
    });
  }

  /**
   * Log performance metrics
   */
  static logPerformanceMetrics(
    phase: string,
    startTime: number,
    endTime: number,
    additionalMetrics?: Record<string, unknown>
  ): void {
    const duration = endTime - startTime;
    CompositionDebugger.log('PERFORMANCE', `${phase} completed in ${duration}ms`, {
      duration,
      ...additionalMetrics,
    });
  }
}
