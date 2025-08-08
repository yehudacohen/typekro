import pino from 'pino';
import type { TypeKroLogger, LoggerConfig, LoggerContext } from './types.js';
import { getLoggerConfigFromEnv, validateLoggerConfig } from './config.js';

/**
 * Pino-based implementation of TypeKroLogger
 */
class PinoLogger implements TypeKroLogger {
  private pinoLogger: pino.Logger;

  constructor(pinoLogger: pino.Logger) {
    this.pinoLogger = pinoLogger;
  }

  trace(msg: string, meta?: Record<string, any>): void {
    this.pinoLogger.trace(meta, msg);
  }

  debug(msg: string, meta?: Record<string, any>): void {
    this.pinoLogger.debug(meta, msg);
  }

  info(msg: string, meta?: Record<string, any>): void {
    this.pinoLogger.info(meta, msg);
  }

  warn(msg: string, meta?: Record<string, any>): void {
    this.pinoLogger.warn(meta, msg);
  }

  error(msg: string, error?: Error, meta?: Record<string, any>): void {
    const logData = { ...meta };
    if (error) {
      logData.error = {
        name: error.name,
        message: error.message,
        stack: error.stack,
      };
    }
    this.pinoLogger.error(logData, msg);
  }

  fatal(msg: string, error?: Error, meta?: Record<string, any>): void {
    const logData = { ...meta };
    if (error) {
      logData.error = {
        name: error.name,
        message: error.message,
        stack: error.stack,
      };
    }
    this.pinoLogger.fatal(logData, msg);
  }

  child(bindings: Record<string, any>): TypeKroLogger {
    return new PinoLogger(this.pinoLogger.child(bindings));
  }
}

/**
 * Create a TypeKro logger with the specified configuration
 */
export function createLogger(config?: Partial<LoggerConfig>): TypeKroLogger {
  const finalConfig = { ...getLoggerConfigFromEnv(), ...config };
  validateLoggerConfig(finalConfig);

  const pinoOptions: pino.LoggerOptions = {
    level: finalConfig.level,
    timestamp: finalConfig.options?.timestamp !== false,
    formatters: {
      level: (label) => ({ level: label }),
    },
  };

  // Configure transport for pretty printing or custom destination
  let transport: pino.TransportSingleOptions | undefined;
  
  if (finalConfig.pretty) {
    transport = {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    };
  } else if (finalConfig.destination && finalConfig.destination !== 'stdout') {
    transport = {
      target: 'pino/file',
      options: {
        destination: finalConfig.destination,
      },
    };
  }

  const pinoLogger = transport ? pino(pinoOptions, pino.transport(transport)) : pino(pinoOptions);
  
  return new PinoLogger(pinoLogger);
}

/**
 * Create a logger with TypeKro-specific context
 */
export function createContextLogger(context: LoggerContext, config?: Partial<LoggerConfig>): TypeKroLogger {
  const logger = createLogger(config);
  return logger.child(context);
}

/**
 * Default logger instance using environment configuration
 */
export const logger: TypeKroLogger = createLogger();

/**
 * Create a component-specific logger
 */
export function getComponentLogger(component: string, additionalContext?: Record<string, any>): TypeKroLogger {
  return logger.child({ component, ...additionalContext });
}

/**
 * Create a resource-specific logger
 */
export function getResourceLogger(resourceId: string, additionalContext?: Record<string, any>): TypeKroLogger {
  return logger.child({ resourceId, ...additionalContext });
}

/**
 * Create a deployment-specific logger
 */
export function getDeploymentLogger(deploymentId: string, namespace?: string, additionalContext?: Record<string, any>): TypeKroLogger {
  return logger.child({ deploymentId, namespace, ...additionalContext });
}