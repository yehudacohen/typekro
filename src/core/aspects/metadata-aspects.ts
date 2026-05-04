import { allResources, aspect, merge, metadata } from './primitives.js';

import type {
  AnnotationMap,
  AspectDefinition,
  LabelMap,
  MetadataAspectSurface,
} from './types.js';

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
  return aspect.on(
    allResources,
    metadata({
      ...(options.labels !== undefined && { labels: merge(options.labels) }),
      ...(options.annotations !== undefined && { annotations: merge(options.annotations) }),
    })
  );
}
