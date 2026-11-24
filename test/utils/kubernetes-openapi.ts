/**
 * Offline checks of built-in Kubernetes objects against the OpenAPI v3 schemas of a pinned
 * Kubernetes release.
 *
 * The fixture holds the component schemas reachable from the kinds under test (written by a
 * vendoring script such as `scripts/vendor-agent-substrate-release.ts`). An object is checked the
 * way the API server decodes it with strict field validation: unknown fields, value types
 * (including int-or-string and quantities), `required`, `enum` and list items. Defaulting and the
 * hand-written Go validation that is not expressed in OpenAPI are out of scope.
 */
import { readFileSync } from 'node:fs';

interface Schema {
  $ref?: string;
  allOf?: Schema[];
  oneOf?: Schema[];
  anyOf?: Schema[];
  type?: string;
  format?: string;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, Schema>;
  additionalProperties?: Schema | boolean;
  items?: Schema;
  'x-kubernetes-preserve-unknown-fields'?: boolean;
  'x-kubernetes-int-or-string'?: boolean;
}

export interface KubernetesOpenApiFixture {
  kubernetesVersion: string;
  scopes: Record<string, 'Cluster' | 'Namespaced'>;
  roots: Record<string, string>;
  schemas: Record<string, Schema>;
}

export function loadKubernetesOpenApi(file: string): KubernetesOpenApiFixture {
  return JSON.parse(readFileSync(file, 'utf8')) as KubernetesOpenApiFixture;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function validate(
  fixture: KubernetesOpenApiFixture,
  schema: Schema,
  value: unknown,
  path: string
): string[] {
  if (schema.$ref) {
    const target = fixture.schemas[schema.$ref.split('/').pop() ?? ''];
    if (!target) return [`${path}: no schema ${schema.$ref} in the fixture`];
    return validate(fixture, target, value, path);
  }
  const errors: string[] = [];
  for (const part of schema.allOf ?? []) errors.push(...validate(fixture, part, value, path));
  for (const choices of [schema.oneOf, schema.anyOf]) {
    if (choices && !choices.some((choice) => validate(fixture, choice, value, path).length === 0)) {
      errors.push(`${path}: matches none of its allowed shapes`);
    }
  }
  if (schema['x-kubernetes-int-or-string'] || schema.format === 'int-or-string') {
    if (!['integer', 'string'].includes(typeOf(value))) {
      errors.push(`${path}: expected an integer or string`);
    }
    return errors;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }
  const actual = typeOf(value);
  if (schema.type) {
    const matches = schema.type === actual || (schema.type === 'number' && actual === 'integer');
    if (!matches) return [...errors, `${path}: expected ${schema.type}, got ${actual}`];
  }
  if (actual === 'array' && schema.items) {
    (value as unknown[]).forEach((item, index) => {
      errors.push(...validate(fixture, schema.items as Schema, item, `${path}[${index}]`));
    });
  }
  if (actual === 'object' && (schema.type === 'object' || schema.properties)) {
    const object = value as Record<string, unknown>;
    for (const field of schema.required ?? []) {
      if (!(field in object)) errors.push(`${path}.${field}: required`);
    }
    for (const [field, child] of Object.entries(object)) {
      const property = schema.properties?.[field];
      if (property) {
        errors.push(...validate(fixture, property, child, `${path}.${field}`));
      } else if (typeof schema.additionalProperties === 'object') {
        errors.push(...validate(fixture, schema.additionalProperties, child, `${path}.${field}`));
      } else if (!schema.additionalProperties && !schema['x-kubernetes-preserve-unknown-fields']) {
        errors.push(`${path}.${field}: unknown field`);
      }
    }
  }
  return errors;
}

/** Errors for a built-in object; empty when it matches its kind's schema. */
export function kubernetesSchemaErrors(
  fixture: KubernetesOpenApiFixture,
  object: { apiVersion: string; kind: string }
): string[] {
  const key = `${object.apiVersion}/${object.kind}`;
  const root = fixture.roots[key];
  if (!root) return [`${key}: not a Kubernetes ${fixture.kubernetesVersion} kind in the fixture`];
  return validate(fixture, { $ref: root }, object, key);
}
