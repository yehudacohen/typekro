/**
 * Offline admission checks against a generated KRO instance schema.
 *
 * KRO turns an RGD's SimpleSchema (`spec.schema.spec` and `spec.schema.types`) into the
 * instance CRD's `openAPIV3Schema`, and the API server refuses an instance that breaks it.
 * This module converts the SimpleSchema the same way for the types and markers TypeKro emits,
 * then validates an instance spec against the result: types, `required`, `enum`, `pattern`
 * (RE2), lengths, item counts, bounds and `validation` rules, which it evaluates with cel-js.
 *
 * An unknown type or marker throws, so a test can't pass on a schema it didn't read. Unknown
 * fields are refused, as `kubectl apply` does with strict field validation. Defaults are not
 * applied.
 */
import { evaluate } from 'cel-js';
import { loadAll } from 'js-yaml';
import { RE2JS } from 're2js';

export interface OpenApiSchema {
  type?: 'string' | 'integer' | 'number' | 'boolean' | 'object' | 'array';
  properties?: Record<string, OpenApiSchema>;
  additionalProperties?: OpenApiSchema;
  items?: OpenApiSchema;
  required?: string[];
  enum?: unknown[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  uniqueItems?: boolean;
  'x-kubernetes-preserve-unknown-fields'?: boolean;
  'x-kubernetes-validations'?: Array<{ rule: string }>;
}

type SimpleSchemaTypes = Record<string, unknown>;

interface RgdDocument {
  kind?: string;
  spec?: { schema?: { kind?: string; spec?: Record<string, unknown>; types?: SimpleSchemaTypes } };
}

/** The `openAPIV3Schema` of `spec` for the RGD in `yamlText` whose instance kind is `kind`. */
export function instanceSpecSchema(yamlText: string, kind: string): OpenApiSchema {
  const rgd = (loadAll(yamlText) as RgdDocument[]).find(
    (document) =>
      document?.kind === 'ResourceGraphDefinition' && document.spec?.schema?.kind === kind
  );
  if (!rgd?.spec?.schema?.spec) throw new Error(`No ResourceGraphDefinition for kind ${kind}.`);
  return simpleSchemaToOpenApi(rgd.spec.schema.spec, rgd.spec.schema.types ?? {});
}

/** Errors the API server would report for `spec` on an instance of `kind`; empty when admitted. */
export function admissionErrors(yamlText: string, kind: string, spec: unknown): string[] {
  return validateAgainst(instanceSpecSchema(yamlText, kind), spec, 'spec');
}

/** Convert a SimpleSchema field map (an object's fields) to an OpenAPI object schema. */
export function simpleSchemaToOpenApi(
  fields: Record<string, unknown>,
  types: SimpleSchemaTypes,
  seen: readonly string[] = []
): OpenApiSchema {
  const properties: Record<string, OpenApiSchema> = {};
  const required: string[] = [];
  for (const [name, definition] of Object.entries(fields)) {
    const { schema, isRequired } = convertField(definition, types, seen);
    properties[name] = schema;
    if (isRequired) required.push(name);
  }
  return { type: 'object', properties, ...(required.length > 0 && { required }) };
}

function convertField(
  definition: unknown,
  types: SimpleSchemaTypes,
  seen: readonly string[]
): { schema: OpenApiSchema; isRequired: boolean } {
  if (definition && typeof definition === 'object' && !Array.isArray(definition)) {
    return {
      schema: simpleSchemaToOpenApi(definition as Record<string, unknown>, types, seen),
      isRequired: false,
    };
  }
  if (typeof definition !== 'string') {
    throw new Error(`Unsupported SimpleSchema field ${JSON.stringify(definition)}.`);
  }
  const bar = definition.indexOf('|');
  const typeText = (bar === -1 ? definition : definition.slice(0, bar)).trim();
  const markers = bar === -1 ? [] : parseMarkers(definition.slice(bar + 1));
  const schema = convertType(typeText, types, seen);
  let isRequired = false;
  for (const [key, value] of markers) {
    switch (key) {
      case 'required':
        isRequired = value === 'true';
        break;
      case 'default':
      case 'description':
        break;
      case 'enum':
        schema.enum = value
          .split(',')
          .map((entry) =>
            schema.type === 'integer' || schema.type === 'number' ? Number(entry) : entry
          );
        break;
      case 'pattern':
        schema.pattern = value;
        break;
      case 'minLength':
      case 'maxLength':
      case 'minItems':
      case 'maxItems':
      case 'minimum':
      case 'maximum':
        schema[key] = Number(value);
        break;
      case 'uniqueItems':
        schema.uniqueItems = value === 'true';
        break;
      case 'validation':
        schema['x-kubernetes-validations'] = [
          ...(schema['x-kubernetes-validations'] ?? []),
          { rule: value },
        ];
        break;
      default:
        throw new Error(`Unsupported SimpleSchema marker ${key} in ${definition}.`);
    }
  }
  return { schema, isRequired };
}

function convertType(
  typeText: string,
  types: SimpleSchemaTypes,
  seen: readonly string[]
): OpenApiSchema {
  if (typeText.startsWith('[]')) {
    return { type: 'array', items: convertType(typeText.slice(2), types, seen) };
  }
  if (typeText.startsWith('map[string]')) {
    return {
      type: 'object',
      additionalProperties: convertType(typeText.slice('map[string]'.length), types, seen),
    };
  }
  switch (typeText) {
    case 'string':
    case 'integer':
    case 'boolean':
      return { type: typeText };
    case 'float':
    case 'number':
      return { type: 'number' };
    case 'object':
      return { type: 'object', 'x-kubernetes-preserve-unknown-fields': true };
  }
  if (Object.hasOwn(types, typeText)) {
    if (seen.includes(typeText)) throw new Error(`Recursive SimpleSchema type ${typeText}.`);
    return convertField(types[typeText], types, [...seen, typeText]).schema;
  }
  throw new Error(`Unsupported SimpleSchema type ${typeText}.`);
}

/** `key=value` pairs; a value is a bare token or a double-quoted string with `\` escapes. */
function parseMarkers(text: string): [string, string][] {
  const markers: [string, string][] = [];
  let index = 0;
  while (index < text.length) {
    while (text[index] === ' ') index++;
    if (index >= text.length) break;
    const equals = text.indexOf('=', index);
    if (equals === -1) throw new Error(`Malformed SimpleSchema markers: ${text}`);
    const key = text.slice(index, equals).trim();
    index = equals + 1;
    let value = '';
    if (text[index] === '"') {
      index++;
      while (index < text.length && text[index] !== '"') {
        if (text[index] === '\\') index++;
        value += text[index] ?? '';
        index++;
      }
      if (text[index] !== '"') throw new Error(`Unterminated SimpleSchema marker: ${text}`);
      index++;
    } else {
      while (index < text.length && text[index] !== ' ') value += text[index++];
    }
    markers.push([key, value]);
  }
  return markers;
}

function typeOf(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

/** Validate `value` against `schema`, as the API server's structural validation would. */
export function validateAgainst(schema: OpenApiSchema, value: unknown, path: string): string[] {
  const errors: string[] = [];
  const actual = typeOf(value);
  if (schema.type) {
    const matches =
      schema.type === 'number'
        ? actual === 'number' || actual === 'integer'
        : actual === schema.type;
    if (!matches) return [`${path}: expected ${schema.type}, got ${actual}`];
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }
  if (typeof value === 'string') {
    if (schema.pattern !== undefined && !RE2JS.compile(schema.pattern).matcher(value).find()) {
      errors.push(`${path}: ${JSON.stringify(value)} does not match ${schema.pattern}`);
    }
    if (schema.minLength !== undefined && value.length < schema.minLength)
      errors.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength)
      errors.push(`${path}: longer than ${schema.maxLength}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum)
      errors.push(`${path}: less than ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum)
      errors.push(`${path}: greater than ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      errors.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      errors.push(`${path}: more than ${schema.maxItems} items`);
    if (
      schema.uniqueItems &&
      new Set(value.map((item) => JSON.stringify(item))).size !== value.length
    )
      errors.push(`${path}: items are not unique`);
    if (schema.items) {
      value.forEach((item, index) => {
        errors.push(...validateAgainst(schema.items as OpenApiSchema, item, `${path}[${index}]`));
      });
    }
  }
  if (actual === 'object' && !schema['x-kubernetes-preserve-unknown-fields']) {
    const object = value as Record<string, unknown>;
    for (const name of schema.required ?? []) {
      if (!Object.hasOwn(object, name)) errors.push(`${path}.${name}: Required value`);
    }
    for (const [name, child] of Object.entries(object)) {
      const childSchema = schema.properties?.[name] ?? schema.additionalProperties;
      if (!childSchema) {
        errors.push(`${path}.${name}: unknown field`);
        continue;
      }
      errors.push(...validateAgainst(childSchema, child, `${path}.${name}`));
    }
  }
  // The API server evaluates a field's rules only when its schema checks pass.
  if (errors.length === 0) {
    for (const { rule } of schema['x-kubernetes-validations'] ?? []) {
      if (evaluate(rule, { self: value }) !== true) {
        errors.push(`${path}: failed rule: ${rule}`);
      }
    }
  }
  return errors;
}
