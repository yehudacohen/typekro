import type { V1ObjectMeta } from '@kubernetes/client-node';
import { type Type, type } from 'arktype';
import { formatArktypeError } from '../../../core/errors.js';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export function customResource<TSpec extends object, TStatus extends object>(
  schema: { apiVersion: string; kind: string; spec: Type<TSpec> },
  definition: { metadata: V1ObjectMeta; spec: TSpec }
): Enhanced<TSpec, TStatus> {
  // Validate the spec with enhanced error handling
  const result = schema.spec(definition.spec);

  if (result instanceof type.errors) {
    throw formatArktypeError(
      result,
      schema.kind,
      definition.metadata.name || 'unnamed',
      definition.spec
    );
  }

  return createResource({
    apiVersion: schema.apiVersion,
    kind: schema.kind,
    metadata: definition.metadata,
    spec: result as TSpec,
  });
}
