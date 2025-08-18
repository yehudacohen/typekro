# TypeKro Logging System

The TypeKro logging system provides professional, structured logging capabilities using the Pino logging framework. This system is designed for production use with configurable log levels, structured JSON output, and contextual logging support.

## Features

- **Structured Logging**: JSON-formatted logs suitable for production log aggregation
- **Configurable Log Levels**: Support for trace, debug, info, warn, error, and fatal levels
- **Environment-based Configuration**: Configure logging through environment variables
- **Contextual Logging**: Bind additional context like resource IDs, deployment IDs, and namespaces
- **Pretty Printing**: Human-readable output for development environments
- **Performance**: Built on Pino, one of the fastest Node.js loggers

## Basic Usage

```typescript
import { logger, createLogger, getComponentLogger } from 'typekro';

// Use the default logger
logger.info('Application started');
logger.error('Something went wrong', new Error('Details'));

// Create a custom logger
const customLogger = createLogger({
  level: 'debug',
  pretty: true
});

// Create a component-specific logger
const deploymentLogger = getComponentLogger('deployment-engine');
deploymentLogger.info('Starting deployment', { resourceId: 'webapp-123' });
```

## Environment Configuration

Configure logging behavior through environment variables:

```bash
# Set log level (trace, debug, info, warn, error, fatal)
export TYPEKRO_LOG_LEVEL=debug

# Enable pretty printing
export TYPEKRO_LOG_PRETTY=true

# Set custom log destination (file path)
export TYPEKRO_LOG_DESTINATION=/var/log/typekro.log

# Disable timestamp, hostname, or PID
export TYPEKRO_LOG_TIMESTAMP=false
export TYPEKRO_LOG_HOSTNAME=false
export TYPEKRO_LOG_PID=false
```

## Contextual Logging

Create loggers with specific context for better traceability:

```typescript
import { getResourceLogger, getDeploymentLogger, createContextLogger } from 'typekro';

// Resource-specific logging
const resourceLogger = getResourceLogger('webapp-deployment');
resourceLogger.info('Resource created successfully');

// Deployment-specific logging
const deployLogger = getDeploymentLogger('deploy-123', 'production');
deployLogger.warn('Deployment taking longer than expected');

// Custom context logging
const contextLogger = createContextLogger({
  component: 'status-hydrator',
  resourceId: 'webapp-123',
  namespace: 'production',
  version: '1.2.3'
});
contextLogger.debug('Processing status update');
```

## Log Levels

The logging system supports six log levels in order of severity:

1. **trace**: Most verbose, typically for detailed debugging
2. **debug**: Debug information, disabled in production by default
3. **info**: General informational messages
4. **warn**: Warning conditions that don't prevent operation
5. **error**: Error conditions that may affect functionality
6. **fatal**: Critical errors that may cause the application to terminate

## Structured Output

All logs are output as structured JSON, making them suitable for log aggregation systems:

```json
{
  "level": "info",
  "time": 1640995200000,
  "pid": 12345,
  "hostname": "server-01",
  "component": "deployment-engine",
  "resourceId": "webapp-123",
  "msg": "Deployment completed successfully"
}
```

## Error Logging

When logging errors, include the error object for full stack trace information:

```typescript
try {
  // Some operation
} catch (error) {
  logger.error('Operation failed', error, { 
    operation: 'deploy',
    resourceId: 'webapp-123' 
  });
}
```

## Child Loggers

Create child loggers to maintain context throughout a request or operation:

```typescript
const baseLogger = getComponentLogger('deployment-engine');
const operationLogger = baseLogger.child({ 
  deploymentId: 'deploy-123',
  operation: 'status-check'
});

operationLogger.info('Starting status check');
operationLogger.debug('Checking pod readiness');
operationLogger.info('Status check completed');
```

## Migration from Console Statements

When migrating from console statements, use these guidelines:

- `console.log()` → `logger.info()` or `logger.debug()`
- `console.warn()` → `logger.warn()`
- `console.error()` → `logger.error()`
- Debug/development logs → `logger.debug()` or remove if not needed
- Critical failures → `logger.fatal()`

## Best Practices

1. **Use appropriate log levels**: Don't log everything at info level
2. **Include context**: Add relevant metadata to help with debugging
3. **Avoid sensitive data**: Don't log passwords, tokens, or personal information
4. **Use child loggers**: Maintain context throughout operations
5. **Structure your messages**: Use consistent message formats
6. **Handle errors properly**: Always include error objects when logging errors

## Performance Considerations

- Pino is designed for high performance with minimal overhead
- JSON serialization is optimized for speed
- Log level filtering happens early to avoid unnecessary work
- Pretty printing adds overhead and should only be used in development