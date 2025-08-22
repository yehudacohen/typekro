/**
 * Schema generation functionality for Kro ResourceGraphDefinitions
 */

import { arktypeToKroSchema, pascalCase } from '../../utils/index.js';
import type { SchemaDefinition } from '../types/serialization.js';
import type { KroCompatibleType, KroSimpleSchema, KubernetesResource } from '../types.js';

/**
 * Generate Kro schema from resources
 */
export function generateKroSchema(
  name: string,
  _resources: Record<string, KubernetesResource>
): KroSimpleSchema {
  const pascalName = pascalCase(name);

  // Generate spec fields based on resource names
  // For now, we'll create a simple schema that doesn't require input parameters
  // since our resources are fully defined in the ResourceGraphDefinition
  const spec: Record<string, string> = {
    // Add a simple name field that can be used for identification
    name: `string | default="${name}"`,
  };

  return {
    apiVersion: `v1alpha1`,
    kind: pascalName,
    spec,
    status: {
      // Empty status - Kro will automatically inject default fields
      // (phase, message, observedGeneration, conditions, state)
    },
  };
}

/**
 * Generate Kro schema from Arktype definition
 */
export function generateKroSchemaFromArktype<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType,
>(
  name: string,
  schemaDefinition: SchemaDefinition<TSpec, TStatus>,
  resources?: Record<string, KubernetesResource>,
  statusMappings?: any
): KroSimpleSchema {
  return arktypeToKroSchema(name, schemaDefinition, resources, statusMappings);
}
