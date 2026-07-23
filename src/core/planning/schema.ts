import { TypeKroError } from '../errors.js';

import { canonicalDigest, canonicalStringify } from './canonical.js';
import type {
  PlanDiagnostic,
  PlanPrimitive,
  SchemaConstraintValue,
  SchemaIR,
  SchemaNodeIR,
  SchemaPropertyIR,
} from './types.js';
import { lowerPlanValue } from './values.js';

interface SchemaLoweringState {
  readonly diagnostics: PlanDiagnostic[];
}

function primitiveConstraintValue(value: unknown): value is PlanPrimitive {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

function portableConstraintValue(value: unknown): value is SchemaConstraintValue {
  return (
    primitiveConstraintValue(value) ||
    (Array.isArray(value) && value.every((entry) => primitiveConstraintValue(entry)))
  );
}

function unsupportedSchemaNode(
  value: unknown,
  path: string,
  state: SchemaLoweringState,
  description: string
): SchemaNodeIR {
  state.diagnostics.push({
    code: 'SCHEMA_IR_UNSUPPORTED',
    severity: 'error',
    message: `${description} at ${path}.`,
    path,
  });
  return {
    kind: 'unsupported',
    description,
    raw: lowerPlanValue(value).value,
  };
}

function schemaProperties(
  entries: unknown,
  required: boolean,
  path: string,
  state: SchemaLoweringState
): SchemaPropertyIR[] {
  if (entries === undefined) return [];
  if (!Array.isArray(entries)) {
    state.diagnostics.push({
      code: 'SCHEMA_IR_INVALID_PROPERTIES',
      severity: 'error',
      message: `ArkType properties at ${path} must be an array.`,
      path,
    });
    return [];
  }

  const properties: SchemaPropertyIR[] = [];
  entries.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      state.diagnostics.push({
        code: 'SCHEMA_IR_INVALID_PROPERTY',
        severity: 'error',
        message: `ArkType property at ${path}[${index}] must be an object.`,
        path: `${path}[${index}]`,
      });
      return;
    }
    const key = Reflect.get(entry, 'key');
    const value = Reflect.get(entry, 'value');
    if (typeof key !== 'string') {
      state.diagnostics.push({
        code: 'SCHEMA_IR_INVALID_PROPERTY_KEY',
        severity: 'error',
        message: `ArkType property key at ${path}[${index}] must be a string.`,
        path: `${path}[${index}].key`,
      });
      return;
    }
    const defaultValue = Reflect.get(entry, 'default');
    properties.push({
      name: key,
      required,
      schema: lowerSchemaNode(value, `${path}.${key}`, state),
      ...(defaultValue !== undefined ? { defaultValue: lowerPlanValue(defaultValue).value } : {}),
    });
  });
  return properties;
}

function lowerSchemaNode(value: unknown, path: string, state: SchemaLoweringState): SchemaNodeIR {
  if (typeof value === 'string') {
    if (value === 'string' || value === 'number' || value === 'boolean' || value === 'unknown') {
      return { kind: 'primitive', type: value };
    }
    if (value === 'null') return { kind: 'primitive', type: 'null' };
    return unsupportedSchemaNode(value, path, state, `Unsupported ArkType string node ${value}`);
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return unsupportedSchemaNode(value, path, state, 'Empty ArkType union');
    }
    return {
      kind: 'union',
      variants: value.map((variant, index) => lowerSchemaNode(variant, `${path}[${index}]`, state)),
    };
  }

  if (!value || typeof value !== 'object') {
    return unsupportedSchemaNode(value, path, state, 'Unsupported ArkType schema node');
  }

  if (Object.hasOwn(value, 'unit')) {
    const unit = Reflect.get(value, 'unit');
    if (primitiveConstraintValue(unit)) return { kind: 'literal', value: unit };
    return unsupportedSchemaNode(value, path, state, 'Non-primitive ArkType unit');
  }

  const proto = Reflect.get(value, 'proto');
  if (proto === 'Array') {
    return {
      kind: 'array',
      items: lowerSchemaNode(Reflect.get(value, 'sequence'), `${path}[]`, state),
    };
  }

  const domain = Reflect.get(value, 'domain');
  if (domain === 'object') {
    const properties = [
      ...schemaProperties(Reflect.get(value, 'required'), true, `${path}.required`, state),
      ...schemaProperties(Reflect.get(value, 'optional'), false, `${path}.optional`, state),
    ].sort((left, right) => left.name.localeCompare(right.name));
    return { kind: 'object', properties };
  }

  if (domain === 'string' || domain === 'number' || domain === 'boolean') {
    const constraints: Record<string, SchemaConstraintValue> = {};
    for (const key of Object.keys(value).sort()) {
      if (key === 'domain') continue;
      const constraint = Reflect.get(value, key);
      if (portableConstraintValue(constraint)) {
        constraints[key] = constraint;
      } else {
        state.diagnostics.push({
          code: 'SCHEMA_IR_UNSUPPORTED_CONSTRAINT',
          severity: 'error',
          message: `Constraint ${key} at ${path} is not in the portable profile.`,
          path: `${path}.${key}`,
        });
      }
    }
    return {
      kind: 'primitive',
      type: domain,
      ...(Object.keys(constraints).length > 0 ? { constraints } : {}),
    };
  }

  return unsupportedSchemaNode(value, path, state, 'Unsupported ArkType object node');
}

/** Convert ArkType JSON into canonical, versioned Schema IR. */
export function schemaToIR(
  schema: { readonly json?: unknown },
  options: { readonly strict?: boolean } = {}
): SchemaIR {
  const state: SchemaLoweringState = { diagnostics: [] };
  const root = lowerSchemaNode(schema.json, '$', state);
  if (options.strict && state.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    throw new TypeKroError(
      `Schema is outside the portable planning profile: ${state.diagnostics
        .map((diagnostic) => diagnostic.message)
        .join('; ')}`,
      'SCHEMA_IR_UNSUPPORTED',
      { diagnostics: state.diagnostics }
    );
  }
  return {
    version: 1,
    root,
    digest: canonicalDigest({ version: 1, root }),
    diagnostics: state.diagnostics,
  };
}

/** Canonical serialized representation used by property and compatibility tests. */
export function encodeSchemaIR(schema: SchemaIR): string {
  return canonicalStringify(schema);
}
