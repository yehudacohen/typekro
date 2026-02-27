/**
 * Structured metadata for log entries.
 * Values should be JSON-serializable primitives or nested records.
 */
export type LogMetadata = Record<string, unknown>;

/**
 * TypeKro logger interface providing structured logging capabilities
 */
export interface TypeKroLogger {
  /**
   * Log trace level messages (most verbose)
   */
  trace(msg: string, meta?: LogMetadata): void;

  /**
   * Log debug level messages
   */
  debug(msg: string, meta?: LogMetadata): void;

  /**
   * Log informational messages
   */
  info(msg: string, meta?: LogMetadata): void;

  /**
   * Log warning messages
   */
  warn(msg: string, meta?: LogMetadata): void;

  /**
   * Log error messages
   */
  error(msg: string, error?: Error, meta?: LogMetadata): void;

  /**
   * Log fatal error messages (most severe)
   */
  fatal(msg: string, error?: Error, meta?: LogMetadata): void;

  /**
   * Create a child logger with additional context bindings
   */
  child(bindings: LogMetadata): TypeKroLogger;
}

/**
 * Configuration options for the TypeKro logger
 */
export interface LoggerConfig {
  /**
   * Log level threshold
   */
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

  /**
   * Enable pretty printing for development (default: false in production)
   */
  pretty?: boolean;

  /**
   * Output destination (default: stdout)
   */
  destination?: string;

  /**
   * Additional logger options
   */
  options?: {
    /**
     * Include timestamp in logs (default: true)
     */
    timestamp?: boolean;

    /**
     * Include hostname in logs (default: true)
     */
    hostname?: boolean;

    /**
     * Include process ID in logs (default: true)
     */
    pid?: boolean;
  };
}

/**
 * Logger context for binding additional metadata
 */
export interface LoggerContext {
  /**
   * Component or module name
   */
  component?: string;

  /**
   * Resource identifier
   */
  resourceId?: string;

  /**
   * Deployment identifier
   */
  deploymentId?: string;

  /**
   * Kubernetes namespace
   */
  namespace?: string;

  /**
   * Additional context metadata
   */
  [key: string]: unknown;
}
