import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  createLogger,
  getComponentLogger,
  getDeploymentLogger,
  getResourceLogger,
  type LoggerConfig,
} from '../../src/core/logging/index.js';

describe('TypeKro Logging', () => {
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    // Save original environment
    originalEnv = {
      TYPEKRO_LOG_LEVEL: process.env.TYPEKRO_LOG_LEVEL,
      TYPEKRO_LOG_PRETTY: process.env.TYPEKRO_LOG_PRETTY,
      NODE_ENV: process.env.NODE_ENV,
    };
  });

  afterEach(() => {
    // Restore original environment
    Object.keys(originalEnv).forEach((key) => {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    });
  });

  describe('Logger Creation', () => {
    it('should create a logger with default configuration', () => {
      const logger = createLogger();
      expect(logger).toBeDefined();
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.error).toBe('function');
      expect(typeof logger.debug).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.trace).toBe('function');
      expect(typeof logger.fatal).toBe('function');
      expect(typeof logger.child).toBe('function');
    });

    it('should create a logger with custom configuration', () => {
      const config: LoggerConfig = {
        level: 'debug',
        pretty: true,
      };
      const logger = createLogger(config);
      expect(logger).toBeDefined();
    });

    it('should create child loggers with context', () => {
      const logger = createLogger();
      const childLogger = logger.child({ component: 'test' });
      expect(childLogger).toBeDefined();
      expect(typeof childLogger.info).toBe('function');
    });
  });

  describe('Environment Configuration', () => {
    it('should respect TYPEKRO_LOG_LEVEL environment variable', () => {
      process.env.TYPEKRO_LOG_LEVEL = 'debug';
      const logger = createLogger();
      expect(logger).toBeDefined();
    });

    it('should enable pretty printing in development', () => {
      process.env.NODE_ENV = 'development';
      const logger = createLogger();
      expect(logger).toBeDefined();
    });

    it('should enable pretty printing when TYPEKRO_LOG_PRETTY is true', () => {
      process.env.TYPEKRO_LOG_PRETTY = 'true';
      const logger = createLogger();
      expect(logger).toBeDefined();
    });
  });

  describe('Specialized Logger Functions', () => {
    it('should create component-specific loggers', () => {
      const logger = getComponentLogger('deployment-engine');
      expect(logger).toBeDefined();
      expect(typeof logger.info).toBe('function');
    });

    it('should create resource-specific loggers', () => {
      const logger = getResourceLogger('webapp-deployment');
      expect(logger).toBeDefined();
      expect(typeof logger.info).toBe('function');
    });

    it('should create deployment-specific loggers', () => {
      const logger = getDeploymentLogger('deploy-123', 'default');
      expect(logger).toBeDefined();
      expect(typeof logger.info).toBe('function');
    });

    it('should create deployment-specific loggers with additional context', () => {
      const logger = getDeploymentLogger('deploy-123', 'default', { version: '1.0.0' });
      expect(logger).toBeDefined();
      expect(typeof logger.info).toBe('function');
    });
  });

  describe('Logger Methods', () => {
    it('should handle all log levels without throwing', () => {
      const logger = createLogger({ level: 'trace' });

      expect(() => logger.trace('trace message')).not.toThrow();
      expect(() => logger.debug('debug message')).not.toThrow();
      expect(() => logger.info('info message')).not.toThrow();
      expect(() => logger.warn('warn message')).not.toThrow();
      expect(() => logger.error('error message')).not.toThrow();
      expect(() => logger.fatal('fatal message')).not.toThrow();
    });

    it('should handle error objects in error and fatal methods', () => {
      const logger = createLogger();
      const error = new Error('Test error');

      expect(() => logger.error('Error occurred', error)).not.toThrow();
      expect(() => logger.fatal('Fatal error occurred', error)).not.toThrow();
    });

    it('should handle metadata in log methods', () => {
      const logger = createLogger();
      const meta = { userId: '123', action: 'deploy' };

      expect(() => logger.info('User action', meta)).not.toThrow();
      expect(() => logger.error('Error with context', undefined, meta)).not.toThrow();
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid log levels gracefully', () => {
      expect(() => {
        createLogger({ level: 'invalid' as any });
      }).toThrow('Invalid log level');
    });

    it('should validate configuration', () => {
      expect(() => {
        createLogger({ level: 'info', destination: 123 as any });
      }).toThrow('Log destination must be a string');
    });
  });
});
