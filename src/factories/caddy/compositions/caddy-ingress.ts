/**
 * Caddy Ingress Composition
 *
 * Runs the official `caddy` image as a config-driven reverse proxy: a ConfigMap holds the Caddyfile, a
 * Deployment runs Caddy mounting it, a Service exposes it (ClusterIP by default), and a PVC persists
 * `/data` so Caddy's `tls internal` CA root survives restarts. No Helm, no etcd, no cert-manager.
 *
 * The Caddyfile arrives as a string on `spec.caddyfile` (build it with `renderCaddyfile()` from concrete
 * routes) so the composition is a pure passthrough that works identically in direct and KRO modes.
 */

import type { V1Volume } from '@kubernetes/client-node';
import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { configMap } from '../../kubernetes/config/config-map.js';
import { namespace } from '../../kubernetes/core/namespace.js';
import { service } from '../../kubernetes/networking/service.js';
import { persistentVolumeClaim } from '../../kubernetes/storage/persistent-volume-claim.js';
import { deployment } from '../../kubernetes/workloads/deployment.js';
import { CaddyIngressConfigSchema, CaddyIngressStatusSchema } from '../types.js';

/** Current stable Caddy version (Docker Hub, 2026-03); the `app.kubernetes.io/version` label + status. */
export const DEFAULT_CADDY_VERSION = '2.11.2';
/**
 * Full default image ref (repo:tag). Deliberately ONE field, not `${image}:${version}` — a template
 * literal derefs the optional `version` in KRO mode without applying its default (yields `caddy:`), whereas
 * a single `?? DEFAULT_CADDY_IMAGE` field compiles to a proper `has(...) ? ... : "caddy:2.11.2"` default.
 */
export const DEFAULT_CADDY_IMAGE = `caddy:${DEFAULT_CADDY_VERSION}`;
export const DEFAULT_CADDY_NAMESPACE = 'caddy-system';
export const DEFAULT_CADDY_HTTP_PORT = 80;
export const DEFAULT_CADDY_HTTPS_PORT = 443;
export const DEFAULT_CADDY_PVC_SIZE = '1Gi';

export const caddyIngress = kubernetesComposition(
  {
    name: 'caddy-ingress',
    kind: 'CaddyIngress',
    spec: CaddyIngressConfigSchema,
    status: CaddyIngressStatusSchema,
  },
  (spec) => {
    const name = spec.name;
    const ns = spec.namespace ?? DEFAULT_CADDY_NAMESPACE;
    const image = spec.image ?? DEFAULT_CADDY_IMAGE;
    const version = spec.version ?? DEFAULT_CADDY_VERSION;
    const httpPort = spec.httpPort ?? DEFAULT_CADDY_HTTP_PORT;
    const httpsPort = spec.httpsPort ?? DEFAULT_CADDY_HTTPS_PORT;
    const serviceType = spec.serviceType ?? 'ClusterIP';
    const pvcSize = spec.persistence?.size ?? DEFAULT_CADDY_PVC_SIZE;

    const labels = {
      'app.kubernetes.io/name': 'caddy',
      'app.kubernetes.io/instance': name,
      'app.kubernetes.io/version': version,
      'app.kubernetes.io/managed-by': 'typekro',
    };
    const selector = { 'app.kubernetes.io/name': 'caddy', 'app.kubernetes.io/instance': name };
    const configMapName = `${name}-caddyfile`;
    const pvcName = `${name}-data`;

    // The Caddy workload namespace (distinct from the namespace that holds a KRO instance, so no finalizer
    // deadlock). Cluster-scoped namespace factory handles its own readiness/deletion ordering.
    namespace({ metadata: { name: ns, labels }, id: 'caddyNamespace' });

    configMap({
      metadata: { name: configMapName, namespace: ns, labels },
      data: { Caddyfile: spec.caddyfile },
      id: 'caddyConfig',
    });

    // Always create the PVC: Caddy's `tls internal` CA root lives in /data and must survive restarts.
    persistentVolumeClaim({
      metadata: { name: pvcName, namespace: ns, labels },
      spec: {
        accessModes: ['ReadWriteOnce'],
        resources: { requests: { storage: pvcSize } },
        ...(spec.persistence?.storageClass
          ? { storageClassName: spec.persistence.storageClass }
          : {}),
      },
      id: 'caddyData',
    });

    const volumes: V1Volume[] = [
      { name: 'caddyfile', configMap: { name: configMapName } },
      { name: 'data', persistentVolumeClaim: { claimName: pvcName } },
    ];

    const caddyDeployment = deployment({
      metadata: { name, namespace: ns, labels },
      spec: {
        // Pinned to a single replica BY DESIGN: `tls internal` keeps its CA in the RWO `/data` PVC,
        // which exactly one pod can own. Multiple pods would (a) fail to co-mount the RWO volume and
        // (b) each mint a different CA → clients see mismatched certs. HA needs RWX storage or an
        // externalized CA — deliberately out of scope, so `replicaCount` is not a config knob.
        replicas: 1,
        // RWO + single replica REQUIRES Recreate: the default RollingUpdate surges a second pod that
        // can't mount the PVC held by the outgoing one → the rollout wedges. Recreate tears the old
        // pod down (releasing the volume) before starting the new one.
        strategy: { type: 'Recreate' },
        selector: { matchLabels: selector },
        template: {
          metadata: { labels },
          spec: {
            containers: [
              {
                name: 'caddy',
                image,
                // Full command (overrides entrypoint): the caddy image puts `caddy` in CMD, so overriding
                // only args would drop it ("exec: run: not found"). Reads the mounted Caddyfile.
                command: [
                  'caddy',
                  'run',
                  '--config',
                  '/etc/caddy/Caddyfile',
                  '--adapter',
                  'caddyfile',
                ],
                ports: [
                  { name: 'http', containerPort: httpPort },
                  { name: 'https', containerPort: httpsPort },
                ],
                volumeMounts: [
                  { name: 'caddyfile', mountPath: '/etc/caddy', readOnly: true },
                  { name: 'data', mountPath: '/data' },
                ],
                ...(spec.resources ? { resources: spec.resources } : {}),
                readinessProbe: {
                  tcpSocket: { port: httpsPort },
                  initialDelaySeconds: 5,
                  periodSeconds: 10,
                },
              },
            ],
            volumes,
          },
        },
      },
      id: 'caddyDeployment',
    });

    service({
      metadata: { name, namespace: ns, labels },
      spec: {
        type: serviceType,
        selector,
        ports: [
          { name: 'http', port: httpPort, targetPort: httpPort },
          { name: 'https', port: httpsPort, targetPort: httpsPort },
        ],
      },
      id: 'caddyService',
    });

    // Multi-resource non-Helm status: direct proxy comparison (no Cel.expr / conditions array). Compare
    // readyReplicas to the Deployment's OWN desired replicas (`spec.replicas`, a graph ref = 1). Because
    // the desired count is a concrete ≥1, this is only ready once the one pod is ready — it can't go
    // ready before the desired pod exists (the t=0 trap of comparing to `status.replicas`, which is 0
    // until the controller observes the spec). spec refs resolve in BOTH kro CEL and direct-mode
    // hydration (via the LIVE_SPEC_KEY core change). No `phase`: the `ready ? … : …` ternary mangles a
    // resource ref in CEL — see the status type.
    return {
      ready: caddyDeployment.status.readyReplicas >= caddyDeployment.spec.replicas,
      version,
    };
  }
);
