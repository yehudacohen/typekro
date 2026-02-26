/**
 * Type Guards for Dependency Resolution
 *
 * Re-exports canonical type guards from `src/utils/type-guards.ts`.
 * This module exists for backward compatibility — consumers that import
 * from this path will get the same canonical implementations.
 */

export { isCelExpression, isKubernetesRef } from '../../utils/type-guards.js';
