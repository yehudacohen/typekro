/**
 * Offline checks of rendered objects against published CRD schemas.
 *
 * A CRD's storage-version `openAPIV3Schema` is read as data, from a vendored CRD YAML file or
 * a JSON fixture of schemas, and an object's `spec` is validated with the structural validator
 * in `kro-admission.ts`: types, `required`, unknown fields, `enum`, `pattern`, lengths, item
 * counts, bounds and `x-kubernetes-validations` rules (evaluated with cel-js). Transition rules,
 * which read `oldSelf`, are dropped, because the API server only runs them on updates.
 */
import { readFileSync } from 'node:fs';
import { loadAll } from 'js-yaml';
import { type OpenApiSchema, validateAgainst } from './kro-admission.js';

interface CrdDocument {
  kind?: string;
  metadata?: { name?: string };
  spec?: { versions?: Array<{ storage?: boolean; schema?: { openAPIV3Schema?: OpenApiSchema } }> };
}

/** The storage version's `openAPIV3Schema` of the CRD named `name` in a YAML file. */
export function crdSchemaFromYaml(file: string, name: string): OpenApiSchema {
  const crd = (loadAll(readFileSync(file, 'utf8')) as CrdDocument[]).find(
    (document) => document?.kind === 'CustomResourceDefinition' && document.metadata?.name === name
  );
  const schema = crd?.spec?.versions?.find((version) => version.storage)?.schema?.openAPIV3Schema;
  if (!schema) throw new Error(`No storage-version schema for CRD ${name} in ${file}.`);
  return schema;
}

/** The schema of the CRD named `name` in a JSON fixture of `{ crds: { <name>: { schema } } }`. */
export function crdSchemaFromJson(file: string, name: string): OpenApiSchema {
  const fixture = JSON.parse(readFileSync(file, 'utf8')) as {
    crds: Record<string, { schema: OpenApiSchema }>;
  };
  const schema = fixture.crds[name]?.schema;
  if (!schema) throw new Error(`No CRD ${name} in ${file}.`);
  return schema;
}

/** A copy of `schema` without transition rules (those that read `oldSelf`). */
function createRules(schema: OpenApiSchema): OpenApiSchema {
  const copy: OpenApiSchema = { ...schema };
  if (schema['x-kubernetes-validations']) {
    copy['x-kubernetes-validations'] = schema['x-kubernetes-validations'].filter(
      ({ rule }) => !/\boldSelf\b/.test(rule)
    );
  }
  if (schema.properties) {
    copy.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, child]) => [key, createRules(child)])
    );
  }
  if (schema.items) copy.items = createRules(schema.items);
  if (schema.additionalProperties)
    copy.additionalProperties = createRules(schema.additionalProperties);
  return copy;
}

/** Errors the API server would report for `spec` when an object is created; empty if admitted. */
export function crdSpecErrors(schema: OpenApiSchema, spec: unknown): string[] {
  const specSchema = schema.properties?.spec;
  if (!specSchema) throw new Error('The CRD schema has no spec.');
  return validateAgainst(createRules(specSchema), spec, 'spec');
}
