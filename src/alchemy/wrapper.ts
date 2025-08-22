/**
 * Alchemy Integration Utilities
 *
 * This file contains utility functions that align with the dynamic registration approach.
 * Static resource registration functions have been removed to avoid conflicts.
 */

import { generateDeterministicResourceId as _generateDeterministicResourceId } from '../utils/helpers.js';

/**
 * Utility to check if a factory is alchemy-managed
 */
export function isAlchemyWrapped(factory: any): boolean {
  return (
    factory !== null &&
    factory !== undefined &&
    typeof factory === 'object' &&
    factory.isAlchemyManaged === true
  );
}

/**
 * Re-export utility function for deterministic resource ID generation
 */
export const generateDeterministicResourceId = _generateDeterministicResourceId;

// All static resource registration functions have been removed to align with
// the dynamic registration approach using ensureResourceTypeRegistered()
