/**
 * YAML generation functionality for Kro ResourceGraphDefinitions
 */

import * as yaml from 'js-yaml';
import {
  extractResourceReferences,
  generateDeterministicResourceId,
  processResourceReferences,
} from '../../utils/index.js';
import type {
  ResourceDependency,
  SerializationContext,
  SerializationOptions,
} from '../types/serialization.js';
import type { KroResourceGraphDefinition, KroSimpleSchema, KubernetesResource } from '../types.js';
import { generateKroSchema } from './schema.js';

/**
 * Serializes resources to Kro YAML
 */
export function serializeResourceGraphToYaml(
  name: string,
  resources: Record<string, KubernetesResource>,
  options?: SerializationOptions,
  customSchema?: KroSimpleSchema
): string {
  // Create serialization context
  const context: SerializationContext = {
    celPrefix: 'resources', // Default Kro prefix, but now configurable
    ...(options?.namespace && { namespace: options.namespace }),
    resourceIdStrategy: 'deterministic',
  };

  // 1. Use embedded resource IDs and build dependency graph
  const resourceMap = new Map<string, { id: string; resource: KubernetesResource }>();
  const dependencies: ResourceDependency[] = [];

  // 2. Process each resource and extract references
  for (const [resourceName, resource] of Object.entries(resources)) {
    // Use the embedded resource ID if available, otherwise generate deterministic one
    const resourceId =
      (resource as { __resourceId?: string }).__resourceId ||
      generateDeterministicResourceId(
        resource.kind || 'Resource',
        resource.metadata?.name || resourceName,
        resource.metadata?.namespace || options?.namespace
      );
    resourceMap.set(resourceName, { id: resourceId, resource });

    // Extract all ResourceReference objects from the resource
    const refs = extractResourceReferences(resource);
    for (const ref of refs) {
      dependencies.push({
        from: resourceId,
        to: ref.resourceId,
        field: ref.fieldPath,
        required: true,
      });
    }
  }

  // 3. Generate Kro ResourceGraphDefinition
  const kroDefinition: KroResourceGraphDefinition = {
    apiVersion: 'kro.run/v1alpha1',
    kind: 'ResourceGraphDefinition',
    metadata: {
      name,
      namespace: options?.namespace || 'default',
    },
    spec: {
      schema: customSchema || generateKroSchema(name, resources),
      resources: Array.from(resourceMap.values()).map(({ id, resource }) => ({
        id,
        template: processResourceReferences(resource, context),
      })),
    },
  };

  // 4. Convert to YAML
  return yaml.dump(kroDefinition, {
    indent: options?.indent || 2,
    lineWidth: options?.lineWidth || -1,
    noRefs: options?.noRefs ?? true,
    sortKeys: false,
    quotingType: '"',
    forceQuotes: false,
  });
}
