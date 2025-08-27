/**
 * DebugLogger - Enhanced Debug Logging for Status Polling and Readiness Evaluation
 *
 * Provides detailed debug information during resource status polling and readiness
 * evaluation to help developers troubleshoot deployment issues.
 */

import { getComponentLogger } from '../logging/index.js';
import type { DeployedResource, DeploymentEvent, StatusDebugEvent } from '../types/deployment.js';

/**
 * Debug logging configuration
 */
export interface DebugLoggerOptions {
  /** Enable debug logging */
  enabled?: boolean;
  /** Enable status polling debug logs */
  statusPolling?: boolean;
  /** Enable readiness evaluation debug logs */
  readinessEvaluation?: boolean;
  /** Maximum status object size to log in bytes */
  maxStatusObjectSize?: number;
  /** Enable verbose mode with additional diagnostic information */
  verboseMode?: boolean;
  /** Progress callback for delivering debug events */
  progressCallback?: (event: DeploymentEvent) => void;
}

/**
 * Status logging context
 */
export interface StatusLoggingContext {
  attempt: number;
  elapsedTime: number;
  isTimeout: boolean;
  progressCallback?: (event: DeploymentEvent) => void;
}

/**
 * Readiness evaluation result
 */
export interface ReadinessResult {
  ready: boolean;
  reason?: string;
  details?: Record<string, unknown>;
}

/**
 * Readiness evaluator function type
 */
export type ReadinessEvaluator = (resource: unknown) => boolean | ReadinessResult;

/**
 * DebugLogger provides enhanced debug logging for deployment operations
 */
export class DebugLogger {
  private options: {
    enabled: boolean;
    statusPolling: boolean;
    readinessEvaluation: boolean;
    maxStatusObjectSize: number;
    verboseMode: boolean;
    progressCallback?: (event: DeploymentEvent) => void;
  };
  private logger = getComponentLogger('debug-logger');

  constructor(options: DebugLoggerOptions = {}) {
    this.options = {
      enabled: options.enabled ?? false,
      statusPolling: options.statusPolling ?? true,
      readinessEvaluation: options.readinessEvaluation ?? true,
      maxStatusObjectSize: options.maxStatusObjectSize || 1024,
      verboseMode: options.verboseMode ?? false,
      ...(options.progressCallback && { progressCallback: options.progressCallback }),
    };
  }

  /**
   * Log detailed status information during readiness polling
   */
  logResourceStatus(
    resource: DeployedResource,
    currentStatus: unknown,
    readinessResult: boolean | ReadinessResult,
    context: StatusLoggingContext
  ): void {
    if (!this.options.enabled || !this.options.statusPolling) {
      return;
    }

    const resourceId = `${resource.kind}/${resource.name}`;
    const statusSummary = this.summarizeStatus(currentStatus);
    const readinessInfo = this.formatReadinessResult(readinessResult);

    // Console logging
    if (this.options.verboseMode) {
      this.logger.debug('Resource status polling details', {
        resourceId,
        namespace: resource.namespace,
        attempt: context.attempt,
        elapsedTime: context.elapsedTime,
        isTimeout: context.isTimeout,
        readinessResult: readinessInfo,
        statusSummary,
        fullStatus: this.truncateStatus(currentStatus),
      });
    } else {
      this.logger.debug(
        `${resourceId} status check (attempt ${context.attempt}, ${context.elapsedTime}ms): ${readinessInfo.summary} - ${statusSummary}`
      );
    }

    // Progress callback delivery
    if (this.options.progressCallback || context.progressCallback) {
      const debugEvent: StatusDebugEvent = {
        type: 'status-debug',
        resourceId,
        message: `Status check: ${readinessInfo.summary} - ${statusSummary}`,
        timestamp: new Date(),
        currentStatus: this.sanitizeStatus(currentStatus),
        readinessResult,
        context: {
          attempt: context.attempt,
          elapsedTime: context.elapsedTime,
          isTimeout: context.isTimeout,
        },
      };

      const callback = context.progressCallback || this.options.progressCallback;
      if (callback) {
        callback(debugEvent);
      }
    }
  }

  /**
   * Log readiness evaluation details
   */
  logReadinessEvaluation(
    resource: DeployedResource,
    evaluator: ReadinessEvaluator,
    result: ReadinessResult
  ): void {
    if (!this.options.enabled || !this.options.readinessEvaluation) {
      return;
    }

    const resourceId = `${resource.kind}/${resource.name}`;
    const evaluatorInfo = this.getEvaluatorInfo(evaluator);

    this.logger.debug('Readiness evaluation completed', {
      resourceId,
      namespace: resource.namespace,
      evaluatorType: evaluatorInfo.type,
      evaluatorName: evaluatorInfo.name,
      result: result.ready,
      reason: result.reason,
      details: this.options.verboseMode ? result.details : undefined,
    });

    // Progress callback delivery
    if (this.options.progressCallback) {
      const debugEvent: StatusDebugEvent = {
        type: 'status-debug',
        resourceId,
        message: `Readiness evaluation: ${result.ready ? 'ready' : 'not ready'}${result.reason ? ` (${result.reason})` : ''}`,
        timestamp: new Date(),
        currentStatus: result.details || {},
        readinessResult: result,
        context: {
          attempt: 0, // Not applicable for evaluator logging
          elapsedTime: 0,
          isTimeout: false,
        },
      };

      this.options.progressCallback(debugEvent);
    }
  }

  /**
   * Log timeout information with final status
   */
  logTimeout(
    resource: DeployedResource,
    finalStatus: unknown,
    totalElapsedTime: number,
    totalAttempts: number
  ): void {
    if (!this.options.enabled) {
      return;
    }

    const resourceId = `${resource.kind}/${resource.name}`;
    const statusSummary = this.summarizeStatus(finalStatus);

    this.logger.warn('Resource readiness timeout', {
      resourceId,
      namespace: resource.namespace,
      totalElapsedTime,
      totalAttempts,
      finalStatus: this.options.verboseMode ? this.truncateStatus(finalStatus) : statusSummary,
    });

    // Progress callback delivery
    if (this.options.progressCallback) {
      const debugEvent: StatusDebugEvent = {
        type: 'status-debug',
        resourceId,
        message: `Readiness timeout after ${totalElapsedTime}ms (${totalAttempts} attempts) - ${statusSummary}`,
        timestamp: new Date(),
        currentStatus: this.sanitizeStatus(finalStatus),
        readinessResult: false,
        context: {
          attempt: totalAttempts,
          elapsedTime: totalElapsedTime,
          isTimeout: true,
        },
      };

      this.options.progressCallback(debugEvent);
    }
  }

  /**
   * Log API errors during status polling
   */
  logApiError(resource: DeployedResource, error: Error, context: StatusLoggingContext): void {
    if (!this.options.enabled) {
      return;
    }

    const resourceId = `${resource.kind}/${resource.name}`;

    this.logger.debug('API error during status polling', {
      resourceId,
      namespace: resource.namespace,
      attempt: context.attempt,
      elapsedTime: context.elapsedTime,
      error: error.message,
      errorType: error.constructor.name,
    });

    // Progress callback delivery
    if (this.options.progressCallback || context.progressCallback) {
      const debugEvent: StatusDebugEvent = {
        type: 'status-debug',
        resourceId,
        message: `API error during status check (attempt ${context.attempt}): ${error.message}`,
        timestamp: new Date(),
        error,
        currentStatus: {},
        readinessResult: false,
        context: {
          attempt: context.attempt,
          elapsedTime: context.elapsedTime,
          isTimeout: context.isTimeout,
        },
      };

      const callback = context.progressCallback || this.options.progressCallback;
      if (callback) {
        callback(debugEvent);
      }
    }
  }

  /**
   * Update debug logger options
   */
  updateOptions(options: Partial<DebugLoggerOptions>): void {
    this.options = { ...this.options, ...options };
  }

  /**
   * Set progress callback
   */
  setProgressCallback(callback?: (event: DeploymentEvent) => void): void {
    if (callback) {
      this.options.progressCallback = callback;
    }
  }

  /**
   * Summarize status object for logging
   */
  private summarizeStatus(status: unknown): string {
    if (!status || typeof status !== 'object') {
      return String(status || 'no status');
    }

    const statusObj = status as Record<string, unknown>;
    const keys = Object.keys(statusObj);

    if (keys.length === 0) {
      return 'no status fields';
    }

    // Show key status fields
    const importantFields = [
      'phase',
      'state',
      'conditions',
      'replicas',
      'readyReplicas',
      'availableReplicas',
      'updatedReplicas',
      'observedGeneration',
    ];
    const summary: string[] = [];

    for (const field of importantFields) {
      if (field in statusObj) {
        const value = statusObj[field];
        if (field === 'conditions' && Array.isArray(value)) {
          const readyCondition = value.find(
            (c: unknown) => (c as { type?: string })?.type === 'Ready'
          );
          const availableCondition = value.find(
            (c: unknown) => (c as { type?: string })?.type === 'Available'
          );

          if (readyCondition) {
            summary.push(
              `Ready=${readyCondition.status}${readyCondition.reason ? `(${readyCondition.reason})` : ''}`
            );
          }
          if (availableCondition && !readyCondition) {
            summary.push(
              `Available=${availableCondition.status}${availableCondition.reason ? `(${availableCondition.reason})` : ''}`
            );
          }
        } else {
          summary.push(`${field}=${value}`);
        }
      }
    }

    if (summary.length === 0) {
      return `${keys.length} status fields: ${keys.slice(0, 3).join(', ')}${keys.length > 3 ? '...' : ''}`;
    }

    return summary.join(', ');
  }

  /**
   * Format readiness result for display
   */
  private formatReadinessResult(result: boolean | ReadinessResult): {
    summary: string;
    details?: string;
  } {
    if (typeof result === 'boolean') {
      return { summary: result ? 'ready' : 'not ready' };
    }

    const summary = result.ready ? 'ready' : 'not ready';
    const details = result.reason || (result.details ? JSON.stringify(result.details) : undefined);

    return {
      summary: details ? `${summary} (${details})` : summary,
      ...(details && { details }),
    };
  }

  /**
   * Get information about the readiness evaluator
   */
  private getEvaluatorInfo(evaluator: ReadinessEvaluator): { type: string; name: string } {
    const funcString = evaluator.toString();

    // Try to extract function name
    const nameMatch = funcString.match(/function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/);
    const name = nameMatch?.[1] || 'anonymous';

    // Determine evaluator type
    let type = 'custom';
    if (funcString.includes('readyReplicas') || funcString.includes('availableReplicas')) {
      type = 'deployment';
    } else if (funcString.includes('conditions')) {
      type = 'condition-based';
    } else if (funcString.includes('phase')) {
      type = 'phase-based';
    }

    return { type, name };
  }

  /**
   * Truncate status object to fit size limits
   */
  private truncateStatus(status: unknown): unknown {
    if (!status || typeof status !== 'object') {
      return status;
    }

    const statusString = JSON.stringify(status);
    if (statusString.length <= this.options.maxStatusObjectSize) {
      return status;
    }

    // Truncate and add indicator
    const truncated = statusString.substring(0, this.options.maxStatusObjectSize - 20);
    try {
      return JSON.parse(`${truncated}...[truncated]"}`);
    } catch {
      return `${truncated}...[truncated]`;
    }
  }

  /**
   * Sanitize status object for progress callbacks (remove sensitive data)
   */
  private sanitizeStatus(status: unknown): Record<string, unknown> {
    if (!status || typeof status !== 'object') {
      return { value: status };
    }

    const statusObj = status as Record<string, unknown>;
    const sanitized: Record<string, unknown> = {};

    // List of potentially sensitive fields to exclude
    const sensitiveFields = ['token', 'password', 'secret', 'key', 'cert', 'credential'];

    for (const [key, value] of Object.entries(statusObj)) {
      const lowerKey = key.toLowerCase();
      const isSensitive = sensitiveFields.some((field) => lowerKey.includes(field));

      if (isSensitive) {
        sanitized[key] = '[REDACTED]';
      } else if (typeof value === 'object' && value !== null) {
        // Recursively sanitize nested objects (with depth limit)
        sanitized[key] = this.sanitizeNestedObject(value, 2);
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }

  /**
   * Sanitize nested objects with depth limit
   */
  private sanitizeNestedObject(obj: unknown, maxDepth: number): unknown {
    if (maxDepth <= 0 || !obj || typeof obj !== 'object') {
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.slice(0, 10).map((item) => this.sanitizeNestedObject(item, maxDepth - 1));
    }

    const result: Record<string, unknown> = {};
    const entries = Object.entries(obj as Record<string, unknown>);

    // Limit number of fields to prevent huge objects
    for (const [key, value] of entries.slice(0, 20)) {
      const lowerKey = key.toLowerCase();
      const sensitiveFields = ['token', 'password', 'secret', 'key', 'cert', 'credential'];
      const isSensitive = sensitiveFields.some((field) => lowerKey.includes(field));

      if (isSensitive) {
        result[key] = '[REDACTED]';
      } else {
        result[key] = this.sanitizeNestedObject(value, maxDepth - 1);
      }
    }

    if (entries.length > 20) {
      result['...'] = `[${entries.length - 20} more fields]`;
    }

    return result;
  }
}

/**
 * Create a DebugLogger instance
 */
export function createDebugLogger(options: DebugLoggerOptions = {}): DebugLogger {
  return new DebugLogger(options);
}

/**
 * Create DebugLogger from deployment options
 */
export function createDebugLoggerFromDeploymentOptions(options: {
  debugLogging?: {
    enabled?: boolean;
    statusPolling?: boolean;
    readinessEvaluation?: boolean;
    maxStatusObjectSize?: number;
    verboseMode?: boolean;
  };
  progressCallback?: (event: DeploymentEvent) => void;
}): DebugLogger {
  const debugOptions: DebugLoggerOptions = {
    enabled: options.debugLogging?.enabled ?? false,
    statusPolling: options.debugLogging?.statusPolling ?? false,
    readinessEvaluation: options.debugLogging?.readinessEvaluation ?? false,
    maxStatusObjectSize: options.debugLogging?.maxStatusObjectSize ?? 1000,
    verboseMode: options.debugLogging?.verboseMode ?? false,
    ...(options.progressCallback && { progressCallback: options.progressCallback }),
  };

  return createDebugLogger(debugOptions);
}
