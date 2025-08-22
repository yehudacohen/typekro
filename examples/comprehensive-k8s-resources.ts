/**
 * Comprehensive Kubernetes Resource Coverage Example
 *
 * This example demonstrates TypeKro's extensive coverage of Kubernetes resource types,
 * including all major categories: Core, Apps, RBAC, Storage, Networking, Certificates,
 * Coordination, Admission, Extensions, Priority, and Runtime resources.
 */

import {
  // Certificate resources
  certificateSigningRequest,
  clusterRole,
  clusterRoleBinding,
  configMap,
  cronJob,
  csiDriver,
  // Extensions resources
  customResourceDefinition,
  // Apps resources
  daemonSet,
  // Core workload resources
  deployment,
  horizontalPodAutoscaler,
  ingress,
  ingressClass,
  job,
  // Coordination resources
  lease,
  limitRange,
  // Admission resources
  mutatingWebhookConfiguration,
  namespace,
  networkPolicy,
  persistentVolume,
  persistentVolumeClaim,
  // Policy resources
  podDisruptionBudget,
  // Priority and Runtime resources
  priorityClass,
  resourceQuota,
  // RBAC resources
  role,
  roleBinding,
  runtimeClass,
  secret,
  // Serialization
  serializeResourceGraphToYaml,
  service,
  serviceAccount,
  statefulSet,
  // Storage resources
  storageClass,
  validatingWebhookConfiguration,
} from '../src/index';

// =============================================================================
// 1. INFRASTRUCTURE FOUNDATION
// =============================================================================

// Namespace for our application
const appNamespace = namespace({
  metadata: { name: 'comprehensive-app' },
});

// Priority classes for different workload types
const highPriorityClass = priorityClass({
  metadata: { name: 'high-priority' },
  value: 1000,
  globalDefault: false,
  description: 'High priority class for critical workloads',
});

const lowPriorityClass = priorityClass({
  metadata: { name: 'low-priority' },
  value: 100,
  globalDefault: false,
  description: 'Low priority class for batch workloads',
});

// Runtime class for secure workloads
const secureRuntimeClass = runtimeClass({
  metadata: { name: 'gvisor' },
  handler: 'runsc',
});

// =============================================================================
// 2. STORAGE INFRASTRUCTURE
// =============================================================================

// Storage class for fast SSD storage
const fastStorageClass = storageClass({
  metadata: { name: 'fast-ssd' },
  provisioner: 'kubernetes.io/aws-ebs',
  parameters: {
    type: 'gp3',
    iops: '3000',
    throughput: '125',
  },
  allowVolumeExpansion: true,
  reclaimPolicy: 'Delete',
});

// CSI Driver for custom storage
const customCSIDriver = csiDriver({
  metadata: { name: 'custom-storage.example.com' },
  spec: {
    attachRequired: true,
    podInfoOnMount: true,
    volumeLifecycleModes: ['Persistent'],
  },
});

// Persistent Volume
const appPV = persistentVolume({
  metadata: { name: 'app-data-pv' },
  spec: {
    capacity: { storage: '10Gi' },
    accessModes: ['ReadWriteOnce'],
    persistentVolumeReclaimPolicy: 'Retain',
    storageClassName: fastStorageClass.metadata.name!,
    awsElasticBlockStore: {
      volumeID: 'vol-12345678',
      fsType: 'ext4',
    },
  },
});

// Persistent Volume Claim
const appPVC = persistentVolumeClaim({
  metadata: {
    name: 'app-data-pvc',
    namespace: appNamespace.metadata.name!,
  },
  spec: {
    accessModes: ['ReadWriteOnce'],
    resources: { requests: { storage: '10Gi' } },
    storageClassName: fastStorageClass.metadata.name!,
  },
});

// =============================================================================
// 3. RBAC CONFIGURATION
// =============================================================================

// Service Account for the application
const appServiceAccount = serviceAccount({
  metadata: {
    name: 'app-service-account',
    namespace: appNamespace.metadata.name!,
  },
});

// Role with specific permissions
const appRole = role({
  metadata: {
    name: 'app-role',
    namespace: appNamespace.metadata.name!,
  },
  rules: [
    {
      apiGroups: [''],
      resources: ['configmaps', 'secrets'],
      verbs: ['get', 'list', 'watch'],
    },
  ],
});

// Role binding
const appRoleBinding = roleBinding({
  metadata: {
    name: 'app-role-binding',
    namespace: appNamespace.metadata.name!,
  },
  subjects: [
    {
      kind: 'ServiceAccount',
      name: appServiceAccount.metadata.name!,
      namespace: appNamespace.metadata.name!,
    },
  ],
  roleRef: {
    kind: 'Role',
    name: appRole.metadata.name!,
    apiGroup: 'rbac.authorization.k8s.io',
  },
});

// Cluster role for cross-namespace access
const monitoringClusterRole = clusterRole({
  metadata: { name: 'monitoring-cluster-role' },
  rules: [
    {
      apiGroups: [''],
      resources: ['nodes', 'pods'],
      verbs: ['get', 'list', 'watch'],
    },
  ],
});

// Cluster role binding
const monitoringClusterRoleBinding = clusterRoleBinding({
  metadata: { name: 'monitoring-cluster-role-binding' },
  subjects: [
    {
      kind: 'ServiceAccount',
      name: appServiceAccount.metadata.name!,
      namespace: appNamespace.metadata.name!,
    },
  ],
  roleRef: {
    kind: 'ClusterRole',
    name: monitoringClusterRole.metadata.name!,
    apiGroup: 'rbac.authorization.k8s.io',
  },
});

// =============================================================================
// 4. APPLICATION CONFIGURATION
// =============================================================================

// Configuration data
const appConfig = configMap({
  metadata: {
    name: 'app-config',
    namespace: appNamespace.metadata.name!,
  },
  data: {
    'database.host': 'postgres.database.svc.cluster.local',
    'database.port': '5432',
    'log.level': 'info',
    'feature.flags': 'auth,metrics,tracing',
  },
});

// Secret data
const appSecret = secret({
  metadata: {
    name: 'app-secrets',
    namespace: appNamespace.metadata.name!,
  },
  type: 'Opaque',
  stringData: {
    'database.username': 'app_user',
    'database.password': 'secure_password_123',
    'api.key': 'sk-1234567890abcdef',
  },
});

// =============================================================================
// 5. WORKLOAD RESOURCES
// =============================================================================

// Main application deployment
const appDeployment = deployment({
  metadata: {
    name: 'web-app',
    namespace: appNamespace.metadata.name!,
  },
  spec: {
    replicas: 3,
    selector: { matchLabels: { app: 'web-app' } },
    template: {
      metadata: { labels: { app: 'web-app' } },
      spec: {
        serviceAccountName: appServiceAccount.metadata.name!,
        priorityClassName: highPriorityClass.metadata.name!,
        runtimeClassName: secureRuntimeClass.metadata.name!,
        containers: [
          {
            name: 'web-app',
            image: 'nginx:1.21',
            ports: [{ containerPort: 8080 }],
            env: [
              {
                name: 'DB_HOST',
                valueFrom: {
                  configMapKeyRef: { name: appConfig.metadata.name!, key: 'database.host' },
                },
              },
              {
                name: 'DB_USER',
                valueFrom: {
                  secretKeyRef: { name: appSecret.metadata.name!, key: 'database.username' },
                },
              },
              {
                name: 'DB_PASS',
                valueFrom: {
                  secretKeyRef: { name: appSecret.metadata.name!, key: 'database.password' },
                },
              },
            ],
            volumeMounts: [
              {
                name: 'app-data',
                mountPath: '/data',
              },
            ],
            resources: {
              requests: { cpu: '100m', memory: '128Mi' },
              limits: { cpu: '500m', memory: '512Mi' },
            },
          },
        ],
        volumes: [
          {
            name: 'app-data',
            persistentVolumeClaim: { claimName: appPVC.metadata.name! },
          },
        ],
      },
    },
  },
});

// Background job processor
const jobProcessor = deployment({
  metadata: {
    name: 'job-processor',
    namespace: appNamespace.metadata.name!,
  },
  spec: {
    replicas: 2,
    selector: { matchLabels: { app: 'job-processor' } },
    template: {
      metadata: { labels: { app: 'job-processor' } },
      spec: {
        serviceAccountName: appServiceAccount.metadata.name!,
        priorityClassName: lowPriorityClass.metadata.name!,
        containers: [
          {
            name: 'processor',
            image: 'job-processor:latest',
            env: [
              {
                name: 'QUEUE_URL',
                valueFrom: {
                  configMapKeyRef: { name: appConfig.metadata.name!, key: 'queue.url' },
                },
              },
            ],
          },
        ],
      },
    },
  },
});

// DaemonSet for logging
const loggingDaemonSet = daemonSet({
  metadata: {
    name: 'log-collector',
    namespace: appNamespace.metadata.name!,
  },
  spec: {
    selector: { matchLabels: { app: 'log-collector' } },
    template: {
      metadata: { labels: { app: 'log-collector' } },
      spec: {
        serviceAccountName: appServiceAccount.metadata.name!,
        containers: [
          {
            name: 'fluentd',
            image: 'fluentd:v1.14',
            volumeMounts: [
              {
                name: 'varlog',
                mountPath: '/var/log',
              },
            ],
          },
        ],
        volumes: [
          {
            name: 'varlog',
            hostPath: { path: '/var/log' },
          },
        ],
      },
    },
  },
});

// StatefulSet for database
const database = statefulSet({
  metadata: {
    name: 'postgres-db',
    namespace: appNamespace.metadata.name!,
  },
  spec: {
    serviceName: 'postgres-service',
    replicas: 1,
    selector: { matchLabels: { app: 'postgres' } },
    template: {
      metadata: { labels: { app: 'postgres' } },
      spec: {
        containers: [
          {
            name: 'postgres',
            image: 'postgres:13',
            env: [
              { name: 'POSTGRES_DB', value: 'appdb' },
              {
                name: 'POSTGRES_USER',
                valueFrom: {
                  secretKeyRef: { name: appSecret.metadata.name!, key: 'database.username' },
                },
              },
              {
                name: 'POSTGRES_PASSWORD',
                valueFrom: {
                  secretKeyRef: { name: appSecret.metadata.name!, key: 'database.password' },
                },
              },
            ],
            ports: [{ containerPort: 5432 }],
            volumeMounts: [
              {
                name: 'postgres-data',
                mountPath: '/var/lib/postgresql/data',
              },
            ],
          },
        ],
      },
    },
    volumeClaimTemplates: [
      {
        metadata: { name: 'postgres-data' },
        spec: {
          accessModes: ['ReadWriteOnce'],
          resources: { requests: { storage: '20Gi' } },
          storageClassName: fastStorageClass.metadata.name!,
        },
      },
    ],
  },
});

// Batch job for data migration
const migrationJob = job({
  metadata: {
    name: 'data-migration',
    namespace: appNamespace.metadata.name!,
  },
  spec: {
    template: {
      spec: {
        serviceAccountName: appServiceAccount.metadata.name!,
        restartPolicy: 'OnFailure',
        containers: [
          {
            name: 'migration',
            image: 'migration-tool:latest',
            env: [
              {
                name: 'DB_HOST',
                valueFrom: {
                  configMapKeyRef: { name: appConfig.metadata.name!, key: 'database.host' },
                },
              },
              {
                name: 'DB_USER',
                valueFrom: {
                  secretKeyRef: { name: appSecret.metadata.name!, key: 'database.username' },
                },
              },
            ],
          },
        ],
      },
    },
  },
});

// Scheduled backup job
const backupCronJob = cronJob({
  metadata: {
    name: 'database-backup',
    namespace: appNamespace.metadata.name!,
  },
  spec: {
    schedule: '0 2 * * *', // Daily at 2 AM
    jobTemplate: {
      spec: {
        template: {
          spec: {
            serviceAccountName: appServiceAccount.metadata.name!,
            restartPolicy: 'OnFailure',
            containers: [
              {
                name: 'backup',
                image: 'backup-tool:latest',
                env: [
                  {
                    name: 'DB_HOST',
                    valueFrom: {
                      configMapKeyRef: { name: appConfig.metadata.name!, key: 'database.host' },
                    },
                  },
                ],
              },
            ],
          },
        },
      },
    },
  },
});

// =============================================================================
// 6. NETWORKING RESOURCES
// =============================================================================

// Service for the web application
const appService = service({
  metadata: {
    name: 'web-app-service',
    namespace: appNamespace.metadata.name!,
  },
  spec: {
    selector: { app: 'web-app' },
    ports: [
      {
        port: 80,
        targetPort: 8080,
        protocol: 'TCP',
      },
    ],
    type: 'ClusterIP',
  },
});

// Service for the database
const dbService = service({
  metadata: {
    name: 'postgres-service',
    namespace: appNamespace.metadata.name!,
  },
  spec: {
    selector: { app: 'postgres' },
    ports: [
      {
        port: 5432,
        targetPort: 5432,
        protocol: 'TCP',
      },
    ],
    type: 'ClusterIP',
  },
});

// Ingress class
const nginxIngressClass = ingressClass({
  metadata: { name: 'nginx' },
  spec: {
    controller: 'k8s.io/ingress-nginx',
  },
});

// Ingress for external access
const appIngress = ingress({
  metadata: {
    name: 'web-app-ingress',
    namespace: appNamespace.metadata.name!,
    annotations: {
      'kubernetes.io/ingress.class': nginxIngressClass.metadata.name!,
      'cert-manager.io/cluster-issuer': 'letsencrypt-prod',
    },
  },
  spec: {
    ingressClassName: nginxIngressClass.metadata.name!,
    tls: [
      {
        hosts: ['app.example.com'],
        secretName: 'app-tls-cert',
      },
    ],
    rules: [
      {
        host: 'app.example.com',
        http: {
          paths: [
            {
              path: '/',
              pathType: 'Prefix',
              backend: {
                service: {
                  name: appService.metadata.name!,
                  port: { number: 80 },
                },
              },
            },
          ],
        },
      },
    ],
  },
});

// Network policy for security
const appNetworkPolicy = networkPolicy({
  metadata: {
    name: 'web-app-netpol',
    namespace: appNamespace.metadata.name!,
  },
  spec: {
    podSelector: { matchLabels: { app: 'web-app' } },
    policyTypes: ['Ingress', 'Egress'],
    ingress: [
      {
        from: [{ namespaceSelector: { matchLabels: { name: 'ingress-nginx' } } }],
        ports: [{ protocol: 'TCP', port: 8080 }],
      },
    ],
    egress: [
      {
        to: [{ podSelector: { matchLabels: { app: 'postgres' } } }],
        ports: [{ protocol: 'TCP', port: 5432 }],
      },
    ],
  },
});

// =============================================================================
// 7. AUTOSCALING AND POLICIES
// =============================================================================

// Horizontal Pod Autoscaler V2
const appHPA = horizontalPodAutoscaler({
  metadata: {
    name: 'web-app-hpa',
    namespace: appNamespace.metadata.name!,
  },
  spec: {
    scaleTargetRef: {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      name: appDeployment.metadata.name!,
    },
    minReplicas: 2,
    maxReplicas: 10,
    metrics: [
      {
        type: 'Resource',
        resource: {
          name: 'cpu',
          target: {
            type: 'Utilization',
            averageUtilization: 70,
          },
        },
      },
    ],
  },
});

// Pod Disruption Budget
const appPDB = podDisruptionBudget({
  metadata: {
    name: 'web-app-pdb',
    namespace: appNamespace.metadata.name!,
  },
  spec: {
    minAvailable: 1,
    selector: { matchLabels: { app: 'web-app' } },
  },
});

// Resource Quota
const namespaceQuota = resourceQuota({
  metadata: {
    name: 'namespace-quota',
    namespace: appNamespace.metadata.name!,
  },
  spec: {
    hard: {
      'requests.cpu': '4',
      'requests.memory': '8Gi',
      'limits.cpu': '8',
      'limits.memory': '16Gi',
      persistentvolumeclaims: '10',
    },
  },
});

// Limit Range
const namespaceLimits = limitRange({
  metadata: {
    name: 'namespace-limits',
    namespace: appNamespace.metadata.name!,
  },
  spec: {
    limits: [
      {
        type: 'Container',
        _default: { cpu: '100m', memory: '128Mi' },
        defaultRequest: { cpu: '50m', memory: '64Mi' },
        max: { cpu: '2', memory: '4Gi' },
        min: { cpu: '10m', memory: '32Mi' },
      },
    ],
  },
});

// =============================================================================
// 8. COORDINATION AND CERTIFICATES
// =============================================================================

// Lease for leader election
const leaderLease = lease({
  metadata: {
    name: 'web-app-leader',
    namespace: appNamespace.metadata.name!,
  },
  spec: {
    holderIdentity: 'web-app-0',
    leaseDurationSeconds: 30,
  },
});

// Certificate Signing Request
const appCSR = certificateSigningRequest({
  metadata: { name: 'web-app-csr' },
  spec: {
    request: Buffer.from(
      '-----BEGIN CERTIFICATE REQUEST-----\nMIICWjCCAUICAQAwFTETMBEGA1UEAwwKd2ViLWFwcC5jb20wggEiMA0GCSqGSIb3\n-----END CERTIFICATE REQUEST-----'
    ).toString('base64'),
    signerName: 'kubernetes.io/kube-apiserver-client',
    usages: ['client auth'],
  },
});

// =============================================================================
// 9. ADMISSION CONTROL
// =============================================================================

// Mutating Webhook Configuration
const mutatingWebhook = mutatingWebhookConfiguration({
  metadata: { name: 'app-mutating-webhook' },
  webhooks: [
    {
      name: 'mutate.example.com',
      sideEffects: 'None',
      clientConfig: {
        service: {
          name: 'webhook-service',
          namespace: appNamespace.metadata.name!,
          path: '/mutate',
        },
      },
      rules: [
        {
          operations: ['CREATE'],
          apiGroups: ['apps'],
          apiVersions: ['v1'],
          resources: ['deployments'],
        },
      ],
      admissionReviewVersions: ['v1', 'v1beta1'],
    },
  ],
});

// Validating Webhook Configuration
const validatingWebhook = validatingWebhookConfiguration({
  metadata: { name: 'app-validating-webhook' },
  webhooks: [
    {
      name: 'validate.example.com',
      sideEffects: 'None',
      clientConfig: {
        service: {
          name: 'webhook-service',
          namespace: appNamespace.metadata.name!,
          path: '/validate',
        },
      },
      rules: [
        {
          operations: ['CREATE', 'UPDATE'],
          apiGroups: ['apps'],
          apiVersions: ['v1'],
          resources: ['deployments'],
        },
      ],
      admissionReviewVersions: ['v1', 'v1beta1'],
    },
  ],
});

// =============================================================================
// 10. CUSTOM RESOURCE DEFINITION
// =============================================================================

// Custom Resource Definition for application configuration
const appConfigCRD = customResourceDefinition({
  metadata: { name: 'appconfigs.example.com' },
  spec: {
    group: 'example.com',
    versions: [
      {
        name: 'v1',
        served: true,
        storage: true,
        schema: {
          openAPIV3Schema: {
            type: 'object',
            properties: {
              spec: {
                type: 'object',
                properties: {
                  replicas: { type: 'integer', minimum: 1, maximum: 100 },
                  image: { type: 'string' },
                  config: {
                    type: 'object',
                    additionalProperties: { type: 'string' },
                  },
                },
                required: ['replicas', 'image'],
              },
              status: {
                type: 'object',
                properties: {
                  phase: { type: 'string' },
                  message: { type: 'string' },
                },
              },
            },
          },
        },
      },
    ],
    scope: 'Namespaced',
    names: {
      plural: 'appconfigs',
      singular: 'appconfig',
      kind: 'AppConfig',
      shortNames: ['ac'],
    },
  },
});

// =============================================================================
// 11. GENERATE KRO RESOURCE GRAPH
// =============================================================================

console.log('🚀 Generating comprehensive Kubernetes resource graph...\n');

const kroYaml = serializeResourceGraphToYaml('comprehensive-k8s-app', {
  // Infrastructure
  appNamespace,
  highPriorityClass,
  lowPriorityClass,
  secureRuntimeClass,

  // Storage
  fastStorageClass,
  customCSIDriver,
  appPV,
  appPVC,

  // RBAC
  appServiceAccount,
  appRole,
  appRoleBinding,
  monitoringClusterRole,
  monitoringClusterRoleBinding,

  // Configuration
  appConfig,
  appSecret,

  // Workloads
  appDeployment,
  jobProcessor,
  loggingDaemonSet,
  database,
  migrationJob,
  backupCronJob,

  // Networking
  appService,
  dbService,
  nginxIngressClass,
  appIngress,
  appNetworkPolicy,

  // Autoscaling & Policies
  appHPA,
  appPDB,
  namespaceQuota,
  namespaceLimits,

  // Coordination & Certificates
  leaderLease,
  appCSR,

  // Admission Control
  mutatingWebhook,
  validatingWebhook,

  // Extensions
  appConfigCRD,
});

console.log('📄 Generated Kro ResourceGraphDefinition YAML:');
console.log('='.repeat(80));
console.log(kroYaml);
console.log('='.repeat(80));

console.log('\n✅ Successfully demonstrated comprehensive Kubernetes resource coverage!');
console.log(
  `📊 Total resources: ${
    Object.keys({
      appNamespace,
      highPriorityClass,
      lowPriorityClass,
      secureRuntimeClass,
      fastStorageClass,
      customCSIDriver,
      appPV,
      appPVC,
      appServiceAccount,
      appRole,
      appRoleBinding,
      monitoringClusterRole,
      monitoringClusterRoleBinding,
      appConfig,
      appSecret,
      appDeployment,
      jobProcessor,
      loggingDaemonSet,
      database,
      migrationJob,
      backupCronJob,
      appService,
      dbService,
      nginxIngressClass,
      appIngress,
      appNetworkPolicy,
      appHPA,
      appPDB,
      namespaceQuota,
      namespaceLimits,
      leaderLease,
      appCSR,
      mutatingWebhook,
      validatingWebhook,
      appConfigCRD,
    }).length
  }`
);

console.log('\n🎯 Resource categories covered:');
console.log('  • Core Resources (Namespace, Pod, PV, PVC, etc.)');
console.log('  • Apps Resources (Deployment, StatefulSet, DaemonSet, Job, CronJob)');
console.log('  • RBAC Resources (Role, RoleBinding, ClusterRole, ServiceAccount)');
console.log('  • Storage Resources (StorageClass, CSIDriver, VolumeAttachment)');
console.log('  • Networking Resources (Service, Ingress, NetworkPolicy, IngressClass)');
console.log('  • Policy Resources (PDB, ResourceQuota, LimitRange, PriorityClass)');
console.log('  • Autoscaling Resources (HPA)');
console.log('  • Coordination Resources (Lease)');
console.log('  • Certificate Resources (CertificateSigningRequest)');
console.log('  • Admission Resources (MutatingWebhook, ValidatingWebhook)');
console.log('  • Extensions Resources (CustomResourceDefinition)');
console.log('  • Runtime Resources (RuntimeClass)');

export { kroYaml };
