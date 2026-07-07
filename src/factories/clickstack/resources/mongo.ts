/**
 * ClickStack Internal MongoDB Resources
 *
 * HyperDX has a HARD MongoDB dependency for app state (dashboards, alerts,
 * users, saved sources — MongoDB is SSPL at runtime). The official chart's
 * bundled MongoDB is a `MongoDBCommunity` CRD owned by the separate
 * `clickstack-operators` prerequisite chart, which this family deliberately
 * does NOT install (its ClickHouse operator CRDs would collide with the
 * Altinity operator; see types.ts). Internal mode therefore provisions a
 * minimal typekro-native StatefulSet + Service instead — NO operator, NO CRDs.
 *
 * ⚠️ LOUD CAVEATS — read before pointing production at this:
 * - APP METADATA ONLY: observability data lives in ClickHouse; Mongo holds
 *   HyperDX dashboards/alerts/users. Losing it loses UI state, not telemetry.
 * - SINGLE REPLICA, NO AUTH: one `mongo:7` pod with a PVC, reachable only
 *   inside the cluster via its ClusterIP Service. Dev-first sizing — use
 *   `mongo: { mode: 'external', uri }` for anything with an SLA.
 */

import { Cel } from '../../../core/references/cel.js';
import type { Composable, Enhanced } from '../../../core/types/index.js';
import type { V1ServiceSpec, V1ServiceStatus } from '../../kubernetes/types.js';
import { service } from '../../kubernetes/networking/service.js';
import {
  statefulSet,
  type V1StatefulSetSpec,
  type V1StatefulSetStatus,
} from '../../kubernetes/workloads/stateful-set.js';
import type { ClickStackMongoConfig } from '../types.js';

/** Pinned major-version Mongo image for the internal app-state store. */
export const DEFAULT_CLICKSTACK_MONGO_IMAGE = 'mongo:7';

/** MongoDB port. */
export const CLICKSTACK_MONGO_PORT = 27017;

/** Default PVC size for the internal Mongo. */
export const DEFAULT_CLICKSTACK_MONGO_STORAGE_SIZE = '5Gi';

/** Suffix appended to the ClickStack instance name for Mongo resources. */
export const CLICKSTACK_MONGO_NAME_SUFFIX = '-mongodb';

function mongoLabels(instanceName: ClickStackMongoConfig['name']) {
  return {
    'app.kubernetes.io/name': 'clickstack-mongodb',
    'app.kubernetes.io/instance': instanceName,
    'app.kubernetes.io/managed-by': 'typekro',
  };
}

/**
 * Create the single-replica internal Mongo StatefulSet (`<name>-mongodb`).
 */
export function clickstackMongoStatefulSet(
  config: Composable<ClickStackMongoConfig>
): Enhanced<V1StatefulSetSpec, V1StatefulSetStatus> {
  const resourceName = Cel.template('%s%s', config.name, CLICKSTACK_MONGO_NAME_SUFFIX);
  const labels = mongoLabels(config.name);

  return statefulSet({
    metadata: {
      name: resourceName,
      namespace: config.namespace,
      labels,
    },
    spec: {
      // SINGLE REPLICA by design (see module doc) — not configurable.
      replicas: 1,
      serviceName: resourceName,
      selector: { matchLabels: labels },
      template: {
        metadata: { labels },
        spec: {
          containers: [
            {
              name: 'mongodb',
              image: config.image ?? DEFAULT_CLICKSTACK_MONGO_IMAGE,
              ports: [{ name: 'mongodb', containerPort: CLICKSTACK_MONGO_PORT }],
              volumeMounts: [{ name: 'data', mountPath: '/data/db' }],
              readinessProbe: {
                tcpSocket: { port: CLICKSTACK_MONGO_PORT },
                initialDelaySeconds: 5,
                periodSeconds: 10,
              },
              livenessProbe: {
                tcpSocket: { port: CLICKSTACK_MONGO_PORT },
                initialDelaySeconds: 30,
                periodSeconds: 20,
              },
            },
          ],
        },
      },
      volumeClaimTemplates: [
        {
          metadata: { name: 'data' },
          spec: {
            accessModes: ['ReadWriteOnce'],
            resources: {
              requests: {
                storage: config.storageSize ?? DEFAULT_CLICKSTACK_MONGO_STORAGE_SIZE,
              },
            },
            ...(config.storageClassName !== undefined && {
              storageClassName: config.storageClassName,
            }),
          },
        },
      ],
    },
    ...(config.statefulSetId && { id: config.statefulSetId }),
  });
}

/**
 * Create the ClusterIP Service (`<name>-mongodb`) fronting the internal Mongo.
 * `hyperdx.config.MONGO_URI` points at this Service's DNS name.
 */
export function clickstackMongoService(
  config: Composable<ClickStackMongoConfig>
): Enhanced<V1ServiceSpec, V1ServiceStatus> {
  return service({
    metadata: {
      name: Cel.template('%s%s', config.name, CLICKSTACK_MONGO_NAME_SUFFIX),
      namespace: config.namespace,
      labels: mongoLabels(config.name),
    },
    spec: {
      type: 'ClusterIP',
      selector: mongoLabels(config.name),
      ports: [
        {
          name: 'mongodb',
          port: CLICKSTACK_MONGO_PORT,
          targetPort: CLICKSTACK_MONGO_PORT,
        },
      ],
    },
    ...(config.serviceId && { id: config.serviceId }),
  });
}
