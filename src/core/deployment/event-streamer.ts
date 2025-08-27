/**
 * EventStreamer - Output Management for Events and Debug Information
 *
 * Handles console logging and progress callback delivery for Kubernetes events
 * and debug information with proper formatting and rate limiting.
 */

import { getComponentLogger } from '../logging/index.js';
import type {
  ChildResourceDiscoveredEvent,
  DeploymentEvent,
  DeploymentOptions,
  KubernetesEventData,
  StatusDebugEvent,
} from '../types/deployment.js';

/**
 * Event streaming configuration
 */
export interface EventStreamerOptions {
  /** Enable console logging */
  consoleLogging?: boolean;
  /** Log level for console output */
  logLevel?: 'error' | 'warn' | 'info' | 'debug';
  /** Event types to deliver via progress callbacks */
  progressCallbackEvents?: ('kubernetes-event' | 'status-debug' | 'child-resource-discovered')[];
  /** Maximum events per second to prevent overwhelming */
  maxEventsPerSecond?: number;
  /** Batch size for high-volume scenarios */
  batchSize?: number;
  /** Batch timeout in milliseconds */
  batchTimeoutMs?: number;
}

/**
 * Event batch for high-volume scenarios
 */
interface EventBatch {
  events: DeploymentEvent[];
  startTime: number;
  timeoutId?: NodeJS.Timeout;
}

/**
 * Rate limiting state
 */
interface RateLimitState {
  eventCount: number;
  windowStart: number;
  droppedEvents: number;
}

/**
 * EventStreamer manages output of events and debug information
 */
export class EventStreamer {
  private options: Required<EventStreamerOptions>;
  private logger = getComponentLogger('event-streamer');
  private rateLimitState: RateLimitState = {
    eventCount: 0,
    windowStart: Date.now(),
    droppedEvents: 0,
  };
  private currentBatch?: EventBatch | undefined;
  private progressCallback?: ((event: DeploymentEvent) => void) | undefined;

  constructor(options: EventStreamerOptions = {}) {
    this.options = {
      consoleLogging: options.consoleLogging ?? true,
      logLevel: options.logLevel || 'info',
      progressCallbackEvents: options.progressCallbackEvents || [
        'kubernetes-event',
        'status-debug',
        'child-resource-discovered',
      ],
      maxEventsPerSecond: options.maxEventsPerSecond || 50,
      batchSize: options.batchSize || 10,
      batchTimeoutMs: options.batchTimeoutMs || 1000,
    };
  }

  /**
   * Set progress callback for event delivery
   */
  setProgressCallback(callback?: (event: DeploymentEvent) => void): void {
    this.progressCallback = callback;
  }

  /**
   * Stream a Kubernetes event
   */
  streamKubernetesEvent(event: KubernetesEventData): void {
    // Check rate limiting
    if (!this.checkRateLimit()) {
      this.rateLimitState.droppedEvents++;
      return;
    }

    // Console logging
    if (this.options.consoleLogging) {
      this.logKubernetesEventToConsole(event);
    }

    // Progress callback delivery
    if (this.progressCallback && this.options.progressCallbackEvents.includes('kubernetes-event')) {
      this.deliverEventViaCallback(event);
    }
  }

  /**
   * Stream a status debug event
   */
  streamStatusDebugEvent(event: StatusDebugEvent): void {
    // Check rate limiting
    if (!this.checkRateLimit()) {
      this.rateLimitState.droppedEvents++;
      return;
    }

    // Console logging
    if (this.options.consoleLogging) {
      this.logStatusDebugEventToConsole(event);
    }

    // Progress callback delivery
    if (this.progressCallback && this.options.progressCallbackEvents.includes('status-debug')) {
      this.deliverEventViaCallback(event);
    }
  }

  /**
   * Stream a child resource discovered event
   */
  streamChildResourceDiscoveredEvent(event: ChildResourceDiscoveredEvent): void {
    // Check rate limiting
    if (!this.checkRateLimit()) {
      this.rateLimitState.droppedEvents++;
      return;
    }

    // Console logging
    if (this.options.consoleLogging) {
      this.logChildResourceDiscoveredEventToConsole(event);
    }

    // Progress callback delivery
    if (
      this.progressCallback &&
      this.options.progressCallbackEvents.includes('child-resource-discovered')
    ) {
      this.deliverEventViaCallback(event);
    }
  }

  /**
   * Flush any pending batched events
   */
  flush(): void {
    if (this.currentBatch && this.currentBatch.events.length > 0) {
      this.deliverBatch(this.currentBatch);
      this.currentBatch = undefined;
    }
  }

  /**
   * Get rate limiting statistics
   */
  getRateLimitStats(): { eventsProcessed: number; droppedEvents: number; windowStart: number } {
    return {
      eventsProcessed: this.rateLimitState.eventCount,
      droppedEvents: this.rateLimitState.droppedEvents,
      windowStart: this.rateLimitState.windowStart,
    };
  }

  /**
   * Check rate limiting
   */
  private checkRateLimit(): boolean {
    const now = Date.now();
    const windowDuration = 1000; // 1 second window

    // Reset window if needed
    if (now - this.rateLimitState.windowStart >= windowDuration) {
      if (this.rateLimitState.droppedEvents > 0) {
        this.logger.warn('Rate limiting dropped events', {
          droppedEvents: this.rateLimitState.droppedEvents,
          windowDuration: windowDuration / 1000,
        });
      }

      this.rateLimitState = {
        eventCount: 0,
        windowStart: now,
        droppedEvents: 0,
      };
    }

    // Check if we're within rate limit
    if (this.rateLimitState.eventCount >= this.options.maxEventsPerSecond) {
      return false;
    }

    this.rateLimitState.eventCount++;
    return true;
  }

  /**
   * Log Kubernetes event to console
   */
  private logKubernetesEventToConsole(event: KubernetesEventData): void {
    const logLevel = this.getLogLevelForEventType(event.eventType);
    const message = this.formatKubernetesEventForConsole(event);

    switch (logLevel) {
      case 'error':
        this.logger.error(message, undefined, {
          eventType: event.eventType,
          reason: event.reason,
          involvedObject: event.involvedObject,
        });
        break;
      case 'warn':
        this.logger.warn(message, {
          eventType: event.eventType,
          reason: event.reason,
          involvedObject: event.involvedObject,
        });
        break;
      case 'info':
        this.logger.info(message, {
          eventType: event.eventType,
          reason: event.reason,
          involvedObject: event.involvedObject,
        });
        break;
      case 'debug':
        this.logger.debug(message, {
          eventType: event.eventType,
          reason: event.reason,
          involvedObject: event.involvedObject,
        });
        break;
    }
  }

  /**
   * Log status debug event to console
   */
  private logStatusDebugEventToConsole(event: StatusDebugEvent): void {
    const message = this.formatStatusDebugEventForConsole(event);
    this.logger.debug(message, {
      resourceId: event.resourceId,
      readinessResult: event.readinessResult,
      context: event.context,
    });
  }

  /**
   * Log child resource discovered event to console
   */
  private logChildResourceDiscoveredEventToConsole(event: ChildResourceDiscoveredEvent): void {
    const message = `Discovered child resource: ${event.childResource.kind}/${event.childResource.name} (parent: ${event.parentResource})`;
    this.logger.debug(message, {
      parentResource: event.parentResource,
      childResource: event.childResource,
    });
  }

  /**
   * Deliver event via progress callback (with batching if needed)
   */
  private deliverEventViaCallback(event: DeploymentEvent): void {
    if (!this.progressCallback) {
      return;
    }

    if (this.options.batchSize <= 1) {
      // No batching - deliver immediately
      this.progressCallback(event);
      return;
    }

    // Add to batch
    if (!this.currentBatch) {
      this.currentBatch = {
        events: [],
        startTime: Date.now(),
      };

      // Set timeout for batch delivery
      this.currentBatch.timeoutId = setTimeout(() => {
        if (this.currentBatch) {
          this.deliverBatch(this.currentBatch);
          this.currentBatch = undefined;
        }
      }, this.options.batchTimeoutMs);
    }

    this.currentBatch.events.push(event);

    // Deliver batch if it's full
    if (this.currentBatch.events.length >= this.options.batchSize) {
      if (this.currentBatch.timeoutId) {
        clearTimeout(this.currentBatch.timeoutId);
      }
      this.deliverBatch(this.currentBatch);
      this.currentBatch = undefined;
    }
  }

  /**
   * Deliver a batch of events
   */
  private deliverBatch(batch: EventBatch): void {
    if (!this.progressCallback) {
      return;
    }

    // For now, deliver events individually
    // In the future, we could create a batch event type
    for (const event of batch.events) {
      this.progressCallback(event);
    }
  }

  /**
   * Get appropriate log level for event type
   */
  private getLogLevelForEventType(
    eventType: 'Normal' | 'Warning' | 'Error'
  ): 'error' | 'warn' | 'info' | 'debug' {
    switch (eventType) {
      case 'Error':
        return 'error';
      case 'Warning':
        return 'warn';
      case 'Normal':
        return 'info';
      default:
        return 'debug';
    }
  }

  /**
   * Format Kubernetes event for console display
   */
  private formatKubernetesEventForConsole(event: KubernetesEventData): string {
    const objectRef = `${event.involvedObject.kind}/${event.involvedObject.name}`;
    const namespace = event.involvedObject.namespace ? `[${event.involvedObject.namespace}]` : '';
    const count = event.count && event.count > 1 ? ` (x${event.count})` : '';

    return `${namespace} ${objectRef}: ${event.reason} - ${event.eventMessage}${count}`;
  }

  /**
   * Format status debug event for console display
   */
  private formatStatusDebugEventForConsole(event: StatusDebugEvent): string {
    const readinessInfo =
      typeof event.readinessResult === 'boolean'
        ? event.readinessResult
          ? 'ready'
          : 'not ready'
        : event.readinessResult.ready
          ? `ready (${event.readinessResult.reason || 'no reason'})`
          : `not ready (${event.readinessResult.reason || 'no reason'})`;

    const statusSummary = this.summarizeStatus(event.currentStatus);

    return `${event.resourceId} status check (attempt ${event.context.attempt}, ${event.context.elapsedTime}ms): ${readinessInfo} - ${statusSummary}`;
  }

  /**
   * Summarize status object for logging
   */
  private summarizeStatus(status: Record<string, unknown>): string {
    const keys = Object.keys(status);
    if (keys.length === 0) {
      return 'no status';
    }

    // Show key status fields
    const importantFields = [
      'phase',
      'conditions',
      'replicas',
      'readyReplicas',
      'availableReplicas',
    ];
    const summary: string[] = [];

    for (const field of importantFields) {
      if (field in status) {
        const value = status[field];
        if (field === 'conditions' && Array.isArray(value)) {
          const readyCondition = value.find(
            (c: { type: string; status: string }) => c.type === 'Ready'
          );
          if (readyCondition) {
            summary.push(`Ready=${readyCondition.status}`);
          }
        } else {
          summary.push(`${field}=${value}`);
        }
      }
    }

    if (summary.length === 0) {
      return `${keys.length} status fields`;
    }

    return summary.join(', ');
  }
}

/**
 * Create an EventStreamer instance
 */
export function createEventStreamer(options: EventStreamerOptions = {}): EventStreamer {
  return new EventStreamer(options);
}

/**
 * Create EventStreamer from deployment options
 */
export function createEventStreamerFromDeploymentOptions(
  options: DeploymentOptions
): EventStreamer {
  const streamerOptions: EventStreamerOptions = {
    consoleLogging: options.outputOptions?.consoleLogging ?? true,
    logLevel: options.outputOptions?.logLevel ?? 'info',
    progressCallbackEvents: options.outputOptions?.progressCallbackEvents ?? [
      'kubernetes-event',
      'status-debug',
      'child-resource-discovered',
    ],
    maxEventsPerSecond: options.eventMonitoring?.maxEventsPerSecond ?? 50,
  };

  const streamer = createEventStreamer(streamerOptions);
  streamer.setProgressCallback(options.progressCallback);

  return streamer;
}
