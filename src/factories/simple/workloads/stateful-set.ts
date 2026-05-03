/**
 * Simple StatefulSet Factory
 *
 * This module provides a simplified factory function for creating
 * Kubernetes StatefulSet resources with sensible defaults.
 */

import type { V1Container, V1EnvVar, V1Volume } from '@kubernetes/client-node';
import type { AspectOverrideSchemaNode } from '../../../core/aspects/metadata.js';
import { setAspectMetadata } from '../../../core/aspects/metadata.js';
import type {
  AspectFactoryTargetBrand,
  ResourceSpecOverrideSchema,
} from '../../../core/aspects/types.js';
import type { Enhanced } from '../../../core/types.js';
import type { V1StatefulSetSpec, V1StatefulSetStatus } from '../../kubernetes/types.js';
import { statefulSet } from '../../kubernetes/workloads/stateful-set.js';
import type { StatefulSetConfig } from '../types.js';

const STATEFUL_SET_ASPECT_OVERRIDE_SCHEMA: AspectOverrideSchemaNode = Object.freeze({
  kind: 'object',
  children: Object.freeze({
    spec: Object.freeze({
      kind: 'object',
      children: Object.freeze({
        replicas: Object.freeze({ kind: 'scalar' }),
        serviceName: Object.freeze({ kind: 'scalar' }),
        template: Object.freeze({
          kind: 'object',
          children: Object.freeze({
            metadata: Object.freeze({
              kind: 'object',
              children: Object.freeze({
                labels: Object.freeze({ kind: 'object' }),
              }),
            }),
            spec: Object.freeze({
              kind: 'object',
              children: Object.freeze({
                containers: Object.freeze({ kind: 'array' }),
                volumes: Object.freeze({ kind: 'array' }),
              }),
            }),
          }),
        }),
      }),
    }),
  }),
});

/**
 * Creates a simple StatefulSet with sensible defaults
 *
 * @param config - Configuration for the stateful set
 * @returns Enhanced StatefulSet resource
 *
 * @example
 * ```typescript
 * const db = StatefulSet({
 *   name: 'postgres',
 *   image: 'postgres:16',
 *   serviceName: 'postgres-headless',
 *   replicas: 3,
 *   ports: [{ containerPort: 5432 }],
 * });
 * ```
 */
function createStatefulSet(
  config: StatefulSetConfig
): Enhanced<V1StatefulSetSpec, V1StatefulSetStatus> {
  const env: V1EnvVar[] = config.env
    ? Object.entries(config.env).map(([name, value]) => ({ name, value }))
    : [];

  const resource = statefulSet({
    ...(config.id && { id: config.id }),
    metadata: {
      name: config.name,
      ...(config.namespace && { namespace: config.namespace }),
      labels: { app: config.name },
    },
    spec: {
      serviceName: config.serviceName,
      replicas: config.replicas || 1,
      selector: { matchLabels: { app: config.name } },
      template: {
        metadata: { labels: { app: config.name } },
        spec: {
          containers: [
            {
              name: config.name,
              image: config.image,
              ...(env.length > 0 && { env }),
              ...(config.ports && { ports: config.ports }),
            },
          ],
        },
      },
      ...(config.volumeClaimTemplates && {
        volumeClaimTemplates: config.volumeClaimTemplates,
      }),
    },
  });
  setAspectMetadata(resource, {
    factoryTarget: 'StatefulSet',
    targetGroups: ['workloads'],
    surfaces: ['metadata', 'override'],
    name: config.name,
    kind: 'StatefulSet',
    labels: { app: config.name },
    overrideSchema: STATEFUL_SET_ASPECT_OVERRIDE_SCHEMA,
    ...(config.id !== undefined ? { id: config.id } : {}),
    ...(config.namespace !== undefined ? { namespace: config.namespace } : {}),
  });
  return resource;
}
type StatefulSetAspectSpec = {
  replicas: number;
  serviceName: string;
  template: {
    metadata: { labels: Record<string, string> };
    spec: {
      containers: readonly V1Container[];
      volumes: readonly V1Volume[];
    };
  };
};

export const StatefulSet = createStatefulSet as typeof createStatefulSet &
  AspectFactoryTargetBrand<
    'metadata' | 'override',
    ResourceSpecOverrideSchema<StatefulSetAspectSpec>
  >;
Reflect.set(StatefulSet, '__typekroAspectTargetId', 'StatefulSet');
Reflect.set(StatefulSet, '__typekroAspectSurfaces', Object.freeze(['metadata', 'override']));
Reflect.set(StatefulSet, '__typekroAspectOverrideSchema', STATEFUL_SET_ASPECT_OVERRIDE_SCHEMA);
