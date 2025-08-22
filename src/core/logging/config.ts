import type { LoggerConfig } from './types.js';

/**
 * Default logger configuration
 */
export const DEFAULT_LOGGER_CONFIG: LoggerConfig = {
  level: 'info',
  pretty: false,
  options: {
    timestamp: true,
    hostname: true,
    pid: true,
  },
};

/**
 * Get logger configuration from environment variables
 */
export function getLoggerConfigFromEnv(): LoggerConfig {
  const config: LoggerConfig = { ...DEFAULT_LOGGER_CONFIG };

  // Set log level from environment
  const envLevel = process.env.TYPEKRO_LOG_LEVEL?.toLowerCase();
  if (envLevel && ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].includes(envLevel)) {
    config.level = envLevel as LoggerConfig['level'];
  }

  // Enable pretty printing in development
  if (process.env.NODE_ENV === 'development' || process.env.TYPEKRO_LOG_PRETTY === 'true') {
    config.pretty = true;
  }

  // Set custom destination if specified
  if (process.env.TYPEKRO_LOG_DESTINATION) {
    config.destination = process.env.TYPEKRO_LOG_DESTINATION;
  }

  // Configure timestamp option
  if (process.env.TYPEKRO_LOG_TIMESTAMP === 'false') {
    config.options = { ...config.options, timestamp: false };
  }

  // Configure hostname option
  if (process.env.TYPEKRO_LOG_HOSTNAME === 'false') {
    config.options = { ...config.options, hostname: false };
  }

  // Configure PID option
  if (process.env.TYPEKRO_LOG_PID === 'false') {
    config.options = { ...config.options, pid: false };
  }

  return config;
}

/**
 * Validate logger configuration
 */
export function validateLoggerConfig(config: LoggerConfig): void {
  const validLevels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
  if (!validLevels.includes(config.level)) {
    throw new Error(
      `Invalid log level: ${config.level}. Must be one of: ${validLevels.join(', ')}`
    );
  }

  if (config.destination && typeof config.destination !== 'string') {
    throw new Error('Log destination must be a string');
  }
}
