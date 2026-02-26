/**
 * Shared utilities for factory functions
 *
 * This module re-exports the core proxy engine (`createResource`) and
 * composition context infrastructure for backward compatibility with
 * existing factory consumers.
 *
 * The canonical implementations live in:
 * - Proxy engine: `src/core/proxy/create-resource.ts`
 * - Composition context: `src/core/composition/context.ts`
 */

import type { CompositionContext, CompositionContextOptions } from '../core/composition/context.js';
import {
  createCompositionContext,
  getCurrentCompositionContext,
  registerDeploymentClosure,
  runInStatusBuilderContext,
  runWithCompositionContext,
} from '../core/composition/context.js';

// Re-export composition context infrastructure for backward compatibility
export type { CompositionContext, CompositionContextOptions };
export {
  createCompositionContext,
  getCurrentCompositionContext,
  registerDeploymentClosure,
  runInStatusBuilderContext,
  runWithCompositionContext,
};

export type { CreateResourceOptions } from '../core/proxy/create-resource.js';
// Re-export proxy engine from its canonical location in core/
export { createResource } from '../core/proxy/create-resource.js';
