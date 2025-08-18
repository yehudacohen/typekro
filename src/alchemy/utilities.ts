/**
 * Alchemy Utility Functions
 * 
 * This module provides utility functions for alchemy integration
 * with TypeKro resources.
 */

import type { Enhanced } from '../core/types/kubernetes.js';
import { generateDeterministicResourceId } from '../utils/helpers.js';

/**
 * Utility function to create deterministic resource IDs for alchemy resources
 */
export function createAlchemyResourceId<T extends Enhanced<any, any>>(
    resource: T,
    namespace?: string
): string {
    const kind = resource.kind || 'Resource';
    const name = resource.metadata?.name || 'unnamed';

    return generateDeterministicResourceId(kind, name, namespace);
}