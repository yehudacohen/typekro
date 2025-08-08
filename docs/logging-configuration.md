# TypeKro Logging Configuration Guide

TypeKro uses structured logging with the Pino framework to provide professional, production-ready logging capabilities. This guide covers configuration, usage patterns, and best practices.

## Quick Start

```typescript
import { logger, getComponentLogger } from '@skates/typekro';

// Use the default logger
logger.info('Application started');

// Create a component-specific logger
const deploymentLogger = getComponentLogger('deployment-engine');
deploymentLogger.info('Starting deployment', { resourceCount: 5 });
```

## Environment Configuration

Configure TypeKro logging through environment variables:

### Log Level
```bash
# Set log level (trace, debug, info, warn, error, fatal)
export TYPEKRO_LOG_LEVEL=info
```

### Pretty Printing (Development)
```bash
# Enable human-readable output for development
export TYPEKRO_LOG_PRETTY=true

# Or enable automatically in development
export NODE_ENV=development
```

### Custom Log Destination
```bash
# Write logs to a file instead of stdout
export TYPEKRO_LOG_DESTINATION=/var/log/typekro.log
```

### Additional Options
```bash
# Disable timestamp, hostname, or PID
export TYPEKRO_LOG_TIMESTAMP=false
export TYPEKRO_LOG_HOSTNAME=false
export TYPEKRO_LOG_PID=false
```

## Log Levels

TypeKro supports six log levels in order of severity:

1. **trace** - Most verbose, detailed debugging information
2. **debug** - Debug information, disabled in production by default
3. **info** - General informational messages
4. **warn** - Warning conditions that don't prevent operation
5. **error** - Error conditions that may affect functionality
6. **fatal** - Critical errors that may cause the application to terminate

## Logger Types

### Default Logger
```typescript
import { logger } from '@skates/typekro';

logger.info('General application message');
logger.error('Something went wrong', new Error('Details'));
```

### Component Loggers
```typescript
import { getComponentLogger } from '@skates/typekro';

const deploymentLogger = getComponentLogger('deployment-engine');
const statusLogger = getComponentLogger('status-hydrator');
```

### Resource Loggers
```typescript
import { getResourceLogger } from '@skates/typekro';

const resourceLogger = getResourceLogger('webapp-deployment');
resourceLogger.info('Resource created successfully');
```

### Deployment Loggers
```typescript
import { getDeploymentLogger } from '@skates/typekro';

const deployLogger = getDeploymentLogger('deploy-123', 'production');
deployLogger.warn('Deployment taking longer than expected');
```

### Custom Context Loggers
```typescript
import { createContextLogger } from '@skates/typekro';

const contextLogger = createContextLogger({
  component: 'kro-factory',
  resourceId: 'webapp-123',
  namespace: 'production',
  deploymentId: 'deploy-456'
});
```

## Child Loggers

Create child loggers to maintain context throughout operations:

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

When logging errors, always include the error object:

```typescript
try {
  // Some operation
} catch (error) {
  logger.error('Operation failed', error);
  
  // With additional context
  const contextLogger = logger.child({ operation: 'deploy', resourceId: 'webapp-123' });
  contextLogger.error('Deployment failed', error);
}
```

## Component-Specific Logging Patterns

### Deployment Engine
```typescript
const deploymentLogger = getComponentLogger('deployment-engine');
const resourceLogger = deploymentLogger.child({ resourceId, kind, name });

resourceLogger.info('Starting resource deployment');
resourceLogger.debug('Resolving references');
resourceLogger.info('Resource deployed successfully');
```

### Status Hydrator
```typescript
const statusLogger = getComponentLogger('status-hydrator');
const hydrationLogger = statusLogger.child({ resourceId });

hydrationLogger.debug('Starting status hydration');
hydrationLogger.warn('Status hydration failed', error);
```

### Kubernetes API
```typescript
const apiLogger = getComponentLogger('kubernetes-api');
const resourceLogger = apiLogger.child({ kind, name, namespace });

resourceLogger.info('Resource created');
resourceLogger.error('Error applying manifest', error);
```

## Production Configuration

### Recommended Production Settings
```bash
# Production environment
export NODE_ENV=production
export TYPEKRO_LOG_LEVEL=info
export TYPEKRO_LOG_PRETTY=false
export TYPEKRO_LOG_DESTINATION=/var/log/typekro/app.log
```

### Log Rotation
For production deployments, configure log rotation:

```bash
# Using logrotate
/var/log/typekro/*.log {
    daily
    rotate 30
    compress
    delaycompress
    missingok
    notifempty
    create 644 typekro typekro
    postrotate
        systemctl reload typekro
    endscript
}
```

### Container Logging
For containerized deployments, log to stdout and let the container runtime handle log collection:

```bash
# Container environment
export TYPEKRO_LOG_LEVEL=info
export TYPEKRO_LOG_PRETTY=false
# Don't set TYPEKRO_LOG_DESTINATION - use stdout
```

## Log Aggregation Integration

### ELK Stack
TypeKro's structured JSON logs work seamlessly with Elasticsearch, Logstash, and Kibana:

```json
{
  "level": "error",
  "time": 1640995200000,
  "component": "deployment-engine",
  "resourceId": "webapp-123",
  "namespace": "production",
  "msg": "Deployment failed",
  "error": {
    "name": "Error",
    "message": "Resource not found",
    "stack": "Error: Resource not found\n    at ..."
  }
}
```

### Prometheus Metrics
Consider adding log-based metrics for monitoring:

```typescript
// Count errors by component
const errorLogger = getComponentLogger('metrics');
errorLogger.error('Deployment failed', error, { 
  metric: 'deployment_errors_total',
  labels: { component: 'deployment-engine', namespace: 'production' }
});
```

## Best Practices

### 1. Use Appropriate Log Levels
- **trace/debug**: Development and troubleshooting only
- **info**: Important application events
- **warn**: Recoverable issues that need attention
- **error**: Errors that affect functionality
- **fatal**: Critical errors that may crash the application

### 2. Include Relevant Context
```typescript
// Good - includes context
const logger = getComponentLogger('deployment-engine').child({
  deploymentId: 'deploy-123',
  namespace: 'production'
});
logger.info('Starting deployment', { resourceCount: 5 });

// Avoid - lacks context
logger.info('Starting deployment');
```

### 3. Avoid Sensitive Data
Never log passwords, tokens, or personal information:

```typescript
// Bad - logs sensitive data
logger.info('User login', { username, password });

// Good - logs safely
logger.info('User login', { username });
```

### 4. Use Child Loggers for Operations
```typescript
const baseLogger = getComponentLogger('kro-factory');
const instanceLogger = baseLogger.child({ instanceName });

instanceLogger.info('Creating instance');
instanceLogger.debug('Validating spec');
instanceLogger.info('Instance created successfully');
```

### 5. Handle Errors Properly
```typescript
// Always include error objects
try {
  await deployResource();
} catch (error) {
  logger.error('Deployment failed', error); // Include the error object
}
```

## Troubleshooting

### Enable Debug Logging
```bash
export TYPEKRO_LOG_LEVEL=debug
export TYPEKRO_LOG_PRETTY=true
```

### Component-Specific Debugging
Focus on specific components by filtering logs:

```bash
# Filter by component
cat /var/log/typekro.log | grep '"component":"deployment-engine"'

# Filter by resource
cat /var/log/typekro.log | grep '"resourceId":"webapp-123"'
```

### Performance Impact
- Pino is designed for minimal performance impact
- JSON serialization is optimized for speed
- Log level filtering happens early to avoid unnecessary work
- Pretty printing adds overhead - only use in development

## Migration from Console Statements

When migrating from console statements, use these guidelines:

- `console.log()` → `logger.info()` or `logger.debug()`
- `console.warn()` → `logger.warn()`
- `console.error()` → `logger.error()`
- Debug/development logs → `logger.debug()` or remove if not needed
- Critical failures → `logger.fatal()`

## Examples

### Complete Deployment Logging
```typescript
import { getComponentLogger } from '@skates/typekro';

class DeploymentEngine {
  private logger = getComponentLogger('deployment-engine');

  async deploy(resources: Resource[], options: DeploymentOptions) {
    const deploymentLogger = this.logger.child({ 
      deploymentId: options.deploymentId,
      resourceCount: resources.length 
    });

    deploymentLogger.info('Starting deployment');

    for (const resource of resources) {
      const resourceLogger = deploymentLogger.child({
        resourceId: resource.id,
        kind: resource.kind,
        name: resource.metadata?.name
      });

      try {
        resourceLogger.debug('Deploying resource');
        await this.deployResource(resource);
        resourceLogger.info('Resource deployed successfully');
      } catch (error) {
        resourceLogger.error('Resource deployment failed', error);
        throw error;
      }
    }

    deploymentLogger.info('Deployment completed successfully');
  }
}
```

This logging system provides comprehensive observability for TypeKro operations while maintaining high performance and production readiness.