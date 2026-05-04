import { allResources, aspect, isPlainObject, merge, metadata } from './primitives.js';

import type {
  AnnotationMap,
  AspectDefinition,
  AspectDefinitionFunctionName,
  LabelMap,
  MetadataAspectSurface,
} from './types.js';
import { AspectDefinitionError } from './types.js';

function createDefinitionError(
  functionName: AspectDefinitionFunctionName,
  reason: string
): AspectDefinitionError {
  return new AspectDefinitionError(functionName, reason);
}

/** Creates a cross-cutting resource metadata label aspect. */
export function withLabels(labels: LabelMap): AspectDefinition<typeof allResources, MetadataAspectSurface> {
  return aspect.on(allResources, metadata({ labels: merge(labels) }));
}

/** Creates a cross-cutting resource metadata annotation aspect. */
export function withAnnotations(
  annotations: AnnotationMap
): AspectDefinition<typeof allResources, MetadataAspectSurface> {
  return aspect.on(allResources, metadata({ annotations: merge(annotations) }));
}

/** Creates a cross-cutting resource metadata aspect. */
export function withMetadata(options: {
  readonly labels?: LabelMap;
  readonly annotations?: AnnotationMap;
}): AspectDefinition<typeof allResources, MetadataAspectSurface> {
  if (!isPlainObject(options)) {
    throw createDefinitionError('metadata', 'withMetadata(...) options must be an object');
  }
  return aspect.on(
    allResources,
    metadata({
      ...(options.labels !== undefined && { labels: merge(options.labels) }),
      ...(options.annotations !== undefined && { annotations: merge(options.annotations) }),
    })
  );
}
