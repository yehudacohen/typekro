/**
 * A small structural validator for CRD `openAPIV3Schema`s, enough to check emitted objects
 * against Karpenter's published v1.14.1 CRDs offline (the chart version this factory pins): types, required and unknown properties, enums,
 * patterns, lengths, bounds, item counts and int-or-string. `x-kubernetes-validations` (CEL)
 * rules are not evaluated.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  pattern?: string;
  maxLength?: number;
  minLength?: number;
  maximum?: number;
  minimum?: number;
  maxItems?: number;
  minItems?: number;
  anyOf?: JsonSchema[];
  'x-kubernetes-int-or-string'?: boolean;
  'x-kubernetes-preserve-unknown-fields'?: boolean;
}

/** The storage version's schema from a CRD fixture in test/fixtures/karpenter. */
export function crdSchema(file: string): JsonSchema {
  const crd = yaml.load(
    readFileSync(join(import.meta.dir, '../../fixtures/karpenter', file), 'utf8')
  ) as { spec: { versions: Array<{ storage: boolean; schema: { openAPIV3Schema: JsonSchema } }> } };
  const version = crd.spec.versions.find((entry) => entry.storage);
  if (!version) throw new Error(`${file} has no storage version`);
  return version.schema.openAPIV3Schema;
}

function typeOf(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

export function validate(value: unknown, schema: JsonSchema, path = '$'): string[] {
  const errors: string[] = [];
  if (schema.anyOf) {
    const passing = schema.anyOf.some((option) => validate(value, option, path).length === 0);
    if (!passing) errors.push(`${path}: matches none of anyOf`);
  }
  const actual = typeOf(value);
  if (schema['x-kubernetes-int-or-string']) {
    if (actual !== 'integer' && actual !== 'string')
      errors.push(`${path}: expected int-or-string, got ${actual}`);
  } else if (schema.type) {
    const ok =
      schema.type === 'number'
        ? actual === 'number' || actual === 'integer'
        : actual === schema.type;
    if (!ok) {
      errors.push(`${path}: expected ${schema.type}, got ${actual}`);
      return errors;
    }
  }
  if (schema.enum && !schema.enum.includes(value))
    errors.push(`${path}: ${JSON.stringify(value)} not in enum`);
  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(value))
      errors.push(`${path}: does not match ${schema.pattern}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength)
      errors.push(`${path}: longer than ${schema.maxLength}`);
    if (schema.minLength !== undefined && value.length < schema.minLength)
      errors.push(`${path}: shorter than ${schema.minLength}`);
  }
  if (typeof value === 'number') {
    if (schema.maximum !== undefined && value > schema.maximum)
      errors.push(`${path}: above ${schema.maximum}`);
    if (schema.minimum !== undefined && value < schema.minimum)
      errors.push(`${path}: below ${schema.minimum}`);
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      errors.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.minItems !== undefined && value.length < schema.minItems)
      errors.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.items)
      value.forEach((item, index) =>
        errors.push(...validate(item, schema.items as JsonSchema, `${path}[${index}]`))
      );
  }
  if (actual === 'object' && (schema.properties || schema.additionalProperties !== undefined)) {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? [])
      if (!(key in record)) errors.push(`${path}: missing required ${key}`);
    for (const [key, item] of Object.entries(record)) {
      const property = schema.properties?.[key];
      if (property) errors.push(...validate(item, property, `${path}.${key}`));
      else if (typeof schema.additionalProperties === 'object')
        errors.push(...validate(item, schema.additionalProperties, `${path}.${key}`));
      else if (
        !schema['x-kubernetes-preserve-unknown-fields'] &&
        schema.additionalProperties !== true
      ) {
        errors.push(`${path}: unknown property ${key} (the API server would prune it)`);
      }
    }
  }
  return errors;
}
