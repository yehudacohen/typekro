/**
 * Serialization module exports
 */

// Types
export type {
  ResourceBuilder,
  ResourceDependency,
  SchemaDefinition,
  SerializationContext,
  SerializationOptions,
  ValidationResult,
} from '../types/serialization.js';
// CEL reference serialization
export {
  generateCelReference,
  getInnerCelPath,
  processResourceReferences,
  serializeStatusMappingsToCel,
} from './cel-references.js';
// Core serialization functions
export { toResourceGraph } from './core.js';
// Schema generation
export { arktypeToKroSchema, generateKroSchema, generateKroSchemaFromArktype } from './schema.js';

// Validation and dependency analysis
export {
  getDependencyOrder,
  validateResourceGraph,
  visualizeDependencies,
} from './validation.js';
// YAML generation
export { serializeResourceGraphToYaml } from './yaml.js';
