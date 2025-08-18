import type {
  V1Container,
  V1EnvVar,
  V1IngressRule,
  V1IngressTLS,
  V1JobSpec,
  V1JobStatus,
  V1LabelSelector,
  V1NetworkPolicyEgressRule,
  V1NetworkPolicyIngressRule,
  V1PersistentVolumeClaim,
  V1ServicePort,
} from '@kubernetes/client-node';

import {
  configMap,
  cronJob,
  deployment,
  horizontalPodAutoscaler,
  ingress,
  job,
  networkPolicy,
  persistentVolumeClaim,
  secret,
  service,
  statefulSet,
} from '../../factories/kubernetes/index.js';

import type {
  V1ConfigMapData,
  V1CronJobSpec,
  V1CronJobStatus,
  V1DeploymentSpec,
  V1DeploymentStatus,
  V1IngressSpec,
  V1NetworkPolicySpec,
  V1PvcSpec,
  V1PvcStatus,
  V1SecretData,
  V1ServiceSpec,
  V1ServiceStatus,
  V1StatefulSetSpec,
  V1StatefulSetStatus,
  V2HpaSpec,
  V2HpaStatus,
} from '../../factories/kubernetes/types.js';
import type { Enhanced } from '../types.js';
import type { SimpleConfigMapConfig } from './types.js';
import type { SimpleDeploymentConfig } from './types.js';

export function simpleDeployment(config: SimpleDeploymentConfig): Enhanced<V1DeploymentSpec, V1DeploymentStatus> {
  const env: V1EnvVar[] = config.env
    ? Object.entries(config.env).map(([name, value]) => ({ name, value }))
    : [];
    
  return deployment({
    ...(config.id && { id: config.id }),
    metadata: {
      name: config.name,
      ...(config.namespace && { namespace: config.namespace }),
      labels: { app: config.name },
    },
    spec: {
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
              ...(config.resources && { resources: config.resources }),
              ...(config.volumeMounts && { volumeMounts: config.volumeMounts }),
            },
          ],
          ...(config.volumes && { volumes: config.volumes }),
        },
      },
    },
  });
}

export function simpleStatefulSet(config: {
  name: string;
  image: string;
  serviceName: string;
  replicas?: number;
  namespace?: string;
  env?: Record<string, string>;
  ports?: V1Container['ports'];
  volumeClaimTemplates?: V1PersistentVolumeClaim[];
}): Enhanced<V1StatefulSetSpec, V1StatefulSetStatus> {
  const env: V1EnvVar[] = config.env
    ? Object.entries(config.env).map(([name, value]) => ({ name, value }))
    : [];
  return statefulSet({
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
      ...(config.volumeClaimTemplates && { volumeClaimTemplates: config.volumeClaimTemplates }),
    },
  });
}

export function simpleJob(config: {
  name: string;
  image: string;
  namespace?: string;
  command?: string[];
  completions?: number;
  backoffLimit?: number;
  restartPolicy?: 'OnFailure' | 'Never';
}): Enhanced<V1JobSpec, V1JobStatus> {
  return job({
    metadata: { name: config.name, ...(config.namespace && { namespace: config.namespace }) },
    spec: {
      ...(config.completions && { completions: config.completions }),
      ...(config.backoffLimit && { backoffLimit: config.backoffLimit }),
      template: {
        spec: {
          containers: [
            {
              name: config.name,
              image: config.image,
              ...(config.command && { command: config.command }),
            },
          ],
          restartPolicy: config.restartPolicy ?? 'OnFailure',
        },
      },
    },
  });
}

export function simpleCronJob(config: {
  name: string;
  image: string;
  schedule: string;
  namespace?: string;
  command?: string[];
}): Enhanced<V1CronJobSpec, V1CronJobStatus> {
  return cronJob({
    metadata: { name: config.name, ...(config.namespace && { namespace: config.namespace }) },
    spec: {
      schedule: config.schedule,
      jobTemplate: {
        spec: {
          template: {
            spec: {
              containers: [
                {
                  name: config.name,
                  image: config.image,
                  ...(config.command && { command: config.command }),
                },
              ],
              restartPolicy: 'OnFailure',
            },
          },
        },
      },
    },
  });
}

export function simpleConfigMap(config: SimpleConfigMapConfig): Enhanced<V1ConfigMapData, unknown> {
  return configMap({
    ...(config.id && { id: config.id }),
    metadata: { name: config.name, ...(config.namespace && { namespace: config.namespace }) },
    data: config.data,
  });
}

export function simpleSecret(config: {
  name: string;
  namespace?: string;
  stringData: Record<string, string>;
}): Enhanced<V1SecretData, unknown> {
  return secret({
    metadata: { name: config.name, ...(config.namespace && { namespace: config.namespace }) },
    stringData: config.stringData,
  });
}

export function simplePvc(config: {
  name: string;
  namespace?: string;
  size: string;
  storageClass?: string;
  accessModes?: ('ReadWriteOnce' | 'ReadOnlyMany' | 'ReadWriteMany')[];
}): Enhanced<V1PvcSpec, V1PvcStatus> {
  return persistentVolumeClaim({
    metadata: { name: config.name, ...(config.namespace && { namespace: config.namespace }) },
    spec: {
      accessModes: config.accessModes ?? ['ReadWriteOnce'],
      ...(config.storageClass && { storageClassName: config.storageClass }),
      resources: {
        requests: {
          storage: config.size,
        },
      },
    },
  });
}

export function simpleHpa(config: {
  name: string;
  namespace?: string;
  target: { name: string; kind: string };
  minReplicas: number;
  maxReplicas: number;
  cpuUtilization?: number;
}): Enhanced<V2HpaSpec, V2HpaStatus> {
  const spec: V2HpaSpec = {
    scaleTargetRef: {
      apiVersion: 'apps/v1',
      kind: config.target.kind,
      name: config.target.name,
    },
    minReplicas: config.minReplicas,
    maxReplicas: config.maxReplicas,
  };
  if (config.cpuUtilization) {
    spec.metrics = [
      {
        type: 'Resource',
        resource: {
          name: 'cpu',
          target: {
            type: 'Utilization',
            averageUtilization: config.cpuUtilization,
          },
        },
      },
    ];
  }
  return horizontalPodAutoscaler({
    metadata: { name: config.name, ...(config.namespace && { namespace: config.namespace }) },
    spec: spec,
  });
}

export function simpleService(config: {
  name: string;
  selector: Record<string, string>;
  ports: V1ServicePort[];
  namespace?: string;
  type?: V1ServiceSpec['type'];
  id?: string;
}): Enhanced<V1ServiceSpec, V1ServiceStatus> {
  return service({
    ...(config.id && { id: config.id }),
    metadata: { name: config.name, ...(config.namespace && { namespace: config.namespace }) },
    spec: {
      selector: config.selector,
      ports: config.ports,
      ...(config.type && { type: config.type }),
      ipFamilies: ['IPv4'],
      ipFamilyPolicy: 'SingleStack',
    },
  });
}

export function simpleIngress(config: {
  name: string;
  namespace?: string;
  ingressClassName?: string;
  rules?: V1IngressRule[];
  tls?: V1IngressTLS[];
  annotations?: Record<string, string>;
}): Enhanced<V1IngressSpec, unknown> {
  return ingress({
    metadata: {
      name: config.name,
      ...(config.namespace && { namespace: config.namespace }),
      ...(config.annotations && { annotations: config.annotations }),
    },
    spec: {
      ...(config.ingressClassName && { ingressClassName: config.ingressClassName }),
      ...(config.rules && { rules: config.rules }),
      ...(config.tls && { tls: config.tls }),
    },
  });
}

export function simpleNetworkPolicy(config: {
  name: string;
  namespace?: string;
  podSelector: V1LabelSelector;
  policyTypes?: ('Ingress' | 'Egress')[];
  ingress?: V1NetworkPolicyIngressRule[];
  egress?: V1NetworkPolicyEgressRule[];
}): Enhanced<V1NetworkPolicySpec, unknown> {
  return networkPolicy({
    metadata: { name: config.name, ...(config.namespace && { namespace: config.namespace }) },
    spec: {
      podSelector: config.podSelector,
      ...(config.policyTypes && { policyTypes: config.policyTypes }),
      ...(config.ingress && { ingress: config.ingress }),
      ...(config.egress && { egress: config.egress }),
    },
  });
}

export interface WebServiceComponent {
  deployment: Enhanced<V1DeploymentSpec, V1DeploymentStatus>;
  service: Enhanced<V1ServiceSpec, V1ServiceStatus>;
}

export function createWebService(config: {
  name: string;
  image: string;
  namespace?: string;
  replicas?: number;
  port: number;
  targetPort?: number;
}): WebServiceComponent {
  const labels = { app: config.name };

  const deployment = simpleDeployment({
    name: config.name,
    image: config.image,
    ...(config.namespace && { namespace: config.namespace }),
    ...(config.replicas && { replicas: config.replicas }),
    ports: [{ containerPort: config.targetPort ?? config.port }],
  });

  const service = simpleService({
    name: config.name,
    selector: labels,
    ports: [{ port: config.port, targetPort: config.targetPort ?? config.port }],
    ...(config.namespace && { namespace: config.namespace }),
  });

  return { deployment, service };
}
