/**
 * Cilium-specific error classes
 *
 * Extracted from types.ts so that the types module remains a pure
 * type-definitions file with no runtime imports.
 */

import { TypeKroError } from '../../core/errors.js';

/**
 * Cilium configuration validation error
 */
export class CiliumConfigurationError extends TypeKroError {
  constructor(
    message: string,
    public readonly configPath: string,
    public readonly validationErrors: string[]
  ) {
    super(`Cilium configuration error at ${configPath}: ${message}`, 'CILIUM_CONFIGURATION_ERROR', {
      configPath,
      validationErrors,
    });
    this.name = 'CiliumConfigurationError';
  }
}

/**
 * Cilium resource validation error
 */
export class CiliumResourceValidationError extends TypeKroError {
  constructor(
    message: string,
    public readonly resourceType: string,
    public readonly resourceName: string
  ) {
    super(
      `Cilium ${resourceType} validation error for ${resourceName}: ${message}`,
      'CILIUM_RESOURCE_VALIDATION_ERROR',
      {
        resourceType,
        resourceName,
      }
    );
    this.name = 'CiliumResourceValidationError';
  }
}

/**
 * Cilium deployment error
 */
export class CiliumDeploymentError extends TypeKroError {
  constructor(
    message: string,
    public readonly phase: string,
    public readonly componentErrors: string[]
  ) {
    super(`Cilium deployment error in ${phase}: ${message}`, 'CILIUM_DEPLOYMENT_ERROR', {
      phase,
      componentErrors,
    });
    this.name = 'CiliumDeploymentError';
  }
}

/**
 * Cilium readiness evaluation error
 */
export class CiliumReadinessError extends TypeKroError {
  constructor(
    message: string,
    public readonly component: string,
    public readonly expectedState: string,
    public readonly actualState: string
  ) {
    super(
      `Cilium ${component} readiness error: expected ${expectedState}, got ${actualState}. ${message}`,
      'CILIUM_READINESS_ERROR',
      {
        component,
        expectedState,
        actualState,
      }
    );
    this.name = 'CiliumReadinessError';
  }
}
