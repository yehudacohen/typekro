# Alchemy Integration

TypeKro integrates seamlessly with Alchemy to provide multi-cloud infrastructure-as-code capabilities. This allows you to combine Kubernetes resources with cloud provider services across AWS, GCP, and Azure in a single, type-safe codebase.

## What is Alchemy?

**Alchemy** is infrastructure-as-TypeScript that provides:

- **Cloud provider support** - AWS, Cloudflare, and more
- **Type-safe infrastructure** - Full TypeScript support with runtime validation
- **Individual resource registration** - Fine-grained control over cloud resources
- **TypeScript-first API** - Native TypeScript patterns, no YAML or DSL
- **Runtime state management** - Automatic resource lifecycle management

## TypeKro + Alchemy Architecture

```typescript
import alchemy from 'alchemy';
import { Bucket } from 'alchemy/aws';
import { toResourceGraph, simpleDeployment } from 'typekro';

// Alchemy handles cloud resources
const app = await alchemy('my-app');
const bucket = await Bucket('uploads');

// TypeKro handles Kubernetes resources that reference cloud resources
const k8sApp = toResourceGraph(
  {
    name: 'cloud-app',
    apiVersion: 'example.com/v1',
    kind: 'CloudApp',
    spec: type({ name: 'string' }),
    status: type({ ready: 'boolean' })
  },
  (schema) => ({
    deployment: simpleDeployment({
      name: schema.spec.name,
      image: 'myapp:latest',
      env: {
        BUCKET_NAME: bucket.name  // Reference to Alchemy resource
      }
    })
  }),
  (schema, resources) => ({
    ready: Cel.expr(resources.deployment.status.readyReplicas, ' > 0')
  })
);
```

## Prerequisites

### Install Alchemy

```bash
# Install Alchemy
npm install alchemy

# No login required - Alchemy uses your existing cloud credentials
```

### Configure Cloud Providers

Alchemy uses your existing cloud credentials:

```bash
# AWS (use existing AWS credentials)
export AWS_REGION=us-west-2

# Cloudflare (if using Cloudflare resources)
export CLOUDFLARE_API_TOKEN=your-token
```

### Install TypeKro with Alchemy

```bash
npm install alchemy typekro
```

## Basic Alchemy Integration

### Simple Cloud Database with Kubernetes Application

```typescript
import alchemy from 'alchemy';
import { RDS } from 'alchemy/aws';
import { type } from 'arktype';
import { toResourceGraph, simpleDeployment, simpleService, Cel } from 'typekro';

// Create Alchemy scope
const app = await alchemy('cloud-native-app');

// Cloud infrastructure with Alchemy
const database = await RDS('myapp-database', {
  engine: 'postgres',
  engineVersion: '15.3',
  instanceClass: 'db.t3.micro',
  allocatedStorage: 20,
  dbName: 'myapp',
  username: 'postgres',
  password: 'secretpassword'
});

// Kubernetes application that connects to cloud database
const CloudAppSpec = type({
  name: 'string',
  image: 'string',
  replicas: 'number'
});

const CloudAppStatus = type({
  ready: 'boolean',
  appUrl: 'string'
});

const cloudApp = toResourceGraph(
  {
    name: 'cloud-app',
    apiVersion: 'cloud.example.com/v1',
    kind: 'CloudApp',
    spec: CloudAppSpec,
    status: CloudAppStatus
  },
  (schema) => ({
    app: simpleDeployment({
      name: schema.spec.name,
      image: schema.spec.image,
      replicas: schema.spec.replicas,
      ports: [3000],
      env: {
        // Reference cloud database endpoint
        DATABASE_URL: database.endpoint,  // Direct Alchemy resource reference
        DATABASE_NAME: 'myapp',
        DATABASE_USER: 'postgres'
      }
    }),
    
    service: simpleService({
      name: schema.spec.name,
      selector: { app: schema.spec.name },
      ports: [{ port: 80, targetPort: 3000 }],
      type: 'LoadBalancer'
    })
  }),
  (schema, resources) => ({
    ready: Cel.expr(resources.app.status.readyReplicas, ' > 0'),
    appUrl: Cel.template(
      'http://%s',
      resources.service.spec.clusterIP
    )
  })
);

// Deploy both cloud and Kubernetes resources
await app.run(async () => {
  const factory = cloudApp.factory('direct', {
    namespace: 'production',
    alchemyScope: app  // Connect TypeKro to Alchemy scope
  });
  
  await factory.deploy({
    name: 'cloud-webapp',
    image: 'myapp:v1.0.0',
    replicas: 3
  });
});
```

## Multi-Cloud Architecture

### AWS + Cloudflare Hybrid Setup

```typescript
import alchemy from 'alchemy';
import { RDS } from 'alchemy/aws';
import { DNSRecord } from 'alchemy/cloudflare';

// Create Alchemy scope
const app = await alchemy('hybrid-cloud-app');

// AWS Database
const database = await RDS('primary-database', {
  engine: 'postgres',
  instanceClass: 'db.t3.micro',
  dbName: 'primarydb'
});

// Cloudflare DNS
const dnsRecord = await DNSRecord('app-dns', {
  zoneId: 'your-zone-id',
  name: 'api.example.com',
  type: 'A',
  value: '192.168.1.1'  // Will be updated with LoadBalancer IP
});

// Kubernetes application using both clouds
const hybridApp = toResourceGraph(
  { name: 'hybrid-app', schema: { spec: HybridAppSpec } },
  (schema) => ({
    app: simpleDeployment({
      name: schema.spec.name,
      image: schema.spec.image,
      
      env: {
        // AWS database connection
        PRIMARY_DATABASE_URL: Cel.template('postgresql://user:pass@%s:5432/primarydb', awsDatabase.endpoint),
        
        // GCP Redis connection
        CACHE_HOST: gcpRedis.host,
        CACHE_PORT: gcpRedis.port.toString(),
        
        // Multi-cloud configuration
        AWS_REGION: 'us-west-2',
        GCP_REGION: 'us-central1'
      }
    })
  }),
  (schema, resources) => ({
    awsDatabaseReady: awsDatabase.status === 'available',
    gcpCacheReady: gcpRedis.state === 'READY',
    
    multiCloudReady: Cel.expr(
      Cel.template('"%%s" == "available" && "%%s" == "READY"', awsDatabase.status, gcpRedis.state)
    )
  })
);
```

### Azure + Kubernetes Integration

```typescript
import * as azure from '@alchemy/azure';

// Azure SQL Database
const azureResourceGroup = new azure.core.ResourceGroup('myapp-rg', {
  location: 'East US'
});

const azureSqlServer = new azure.sql.SqlServer('myapp-sql-server', {
  resourceGroupName: azureResourceGroup.name,
  location: azureResourceGroup.location,
  version: '12.0',
  administratorLogin: 'sqladmin',
  administratorLoginPassword: 'StrongPassword123!'
});

const azureDatabase = new azure.sql.Database('myapp-database', {
  resourceGroupName: azureResourceGroup.name,
  location: azureResourceGroup.location,
  serverName: azureSqlServer.name,
  requestedServiceObjectiveName: 'S0'
});

// Azure Storage Account
const storageAccount = new azure.storage.Account('myappstorage', {
  resourceGroupName: azureResourceGroup.name,
  location: azureResourceGroup.location,
  accountTier: 'Standard',
  accountReplicationType: 'LRS'
});

const azureApp = toResourceGraph(
  { name: 'azure-app', schema: { spec: AzureAppSpec } },
  (schema) => ({
    app: simpleDeployment({
      name: schema.spec.name,
      image: schema.spec.image,
      
      env: {
        // Azure SQL connection
        DATABASE_URL: Cel.template(
          'Server=%s;Database=%s;User Id=%s;Password=%s;',
          azureSqlServer.fullyQualifiedDomainName,
          azureDatabase.name,
          'sqladmin',
          'StrongPassword123!'
        ),
        
        // Azure Storage connection
        AZURE_STORAGE_CONNECTION_STRING: storageAccount.primaryConnectionString,
        
        // Azure configuration
        AZURE_RESOURCE_GROUP: azureResourceGroup.name,
        AZURE_LOCATION: azureResourceGroup.location
      }
    })
  }),
  (schema, resources) => ({
    azureResourcesReady: true,  // Simplified for example
    storageEndpoint: storageAccount.primaryBlobEndpoint
  })
);
```

## Advanced Alchemy Patterns

### Infrastructure Composition

```typescript
// Reusable cloud infrastructure component
class CloudInfrastructure {
  public readonly database: aws.rds.Instance;
  public readonly cache: aws.elasticache.ReplicationGroup;
  public readonly loadBalancer: aws.alb.LoadBalancer;
  
  constructor(name: string, config: CloudInfraConfig) {
    // VPC and networking
    const vpc = new aws.ec2.Vpc(Cel.expr(name, "-vpc"), {
      cidrBlock: '10.0.0.0/16',
      enableDnsHostnames: true,
      enableDnsSupport: true
    });
    
    const publicSubnet = new aws.ec2.Subnet(Cel.expr(name, "-public"), {
      vpcId: vpc.id,
      cidrBlock: '10.0.1.0/24',
      availabilityZone: 'us-west-2a',
      mapPublicIpOnLaunch: true
    });
    
    const privateSubnet = new aws.ec2.Subnet(Cel.expr(name, "-private"), {
      vpcId: vpc.id,
      cidrBlock: '10.0.2.0/24',
      availabilityZone: 'us-west-2b'
    });
    
    // Security groups
    const dbSecurityGroup = new aws.ec2.SecurityGroup(Cel.expr(name, "-db-sg"), {
      vpcId: vpc.id,
      ingress: [{
        protocol: 'tcp',
        fromPort: 5432,
        toPort: 5432,
        cidrBlocks: ['10.0.0.0/16']
      }]
    });
    
    // Database
    const dbSubnetGroup = new aws.rds.SubnetGroup(Cel.expr(name, "-db-subnet"), {
      subnetIds: [privateSubnet.id, publicSubnet.id]
    });
    
    this.database = new aws.rds.Instance(Cel.expr(name, "-database"), {
      allocatedStorage: config.database.storage,
      instanceClass: config.database.instanceClass,
      engine: 'postgres',
      dbName: config.database.name,
      username: config.database.username,
      password: config.database.password,
      
      dbSubnetGroupName: dbSubnetGroup.name,
      vpcSecurityGroupIds: [dbSecurityGroup.id],
      
      skipFinalSnapshot: true
    });
    
    // Cache
    const cacheSubnetGroup = new aws.elasticache.SubnetGroup(Cel.expr(name, "-cache-subnet"), {
      subnetIds: [privateSubnet.id, publicSubnet.id]
    });
    
    this.cache = new aws.elasticache.ReplicationGroup(Cel.expr(name, "-cache"), {
      description: Cel.template('%s Redis cache', name),
      nodeType: config.cache.nodeType,
      numCacheClusters: config.cache.replicas,
      port: 6379,
      
      subnetGroupName: cacheSubnetGroup.name,
      securityGroupIds: [dbSecurityGroup.id]  // Reuse security group
    });
    
    // Load Balancer
    this.loadBalancer = new aws.alb.LoadBalancer(Cel.expr(name, "-alb"), {
      loadBalancerType: 'application',
      subnets: [publicSubnet.id, privateSubnet.id],
      securityGroups: [dbSecurityGroup.id]
    });
  }
}

// Use composed infrastructure in TypeKro
const infrastructure = new CloudInfrastructure('myapp', {
  database: {
    storage: 100,
    instanceClass: 'db.t3.medium',
    name: 'myapp',
    username: 'postgres',
    password: 'secretpassword'
  },
  cache: {
    nodeType: 'cache.t3.micro',
    replicas: 2
  }
});

const enterpriseApp = toResourceGraph(
  { name: 'enterprise-app', schema: { spec: EnterpriseAppSpec } },
  (schema) => ({
    app: simpleDeployment({
      name: schema.spec.name,
      image: schema.spec.image,
      replicas: schema.spec.replicas,
      
      env: {
        DATABASE_URL: Cel.template('postgresql://%s:%s@%s:5432/%s', infrastructure.database.username, infrastructure.database.password, infrastructure.database.endpoint, infrastructure.database.dbName),
        
        REDIS_URL: Cel.template('redis://%s:6379', infrastructure.cache.primaryEndpoint),
        
        LOAD_BALANCER_DNS: infrastructure.loadBalancer.dnsName
      }
    })
  }),
  statusBuilder
);
```

### Environment-Specific Cloud Resources

```typescript
// Environment-specific cloud configuration
const cloudConfigs = {
  development: {
    database: { instanceClass: 'db.t3.micro', storage: 20 },
    cache: { nodeType: 'cache.t3.micro', replicas: 1 },
    monitoring: false
  },
  staging: {
    database: { instanceClass: 'db.t3.small', storage: 50 },
    cache: { nodeType: 'cache.t3.small', replicas: 2 },
    monitoring: true
  },
  production: {
    database: { instanceClass: 'db.r5.large', storage: 500 },
    cache: { nodeType: 'cache.r5.large', replicas: 3 },
    monitoring: true
  }
};

function createCloudInfrastructure(environment: string) {
  const config = cloudConfigs[environment];
  
  const database = new aws.rds.Instance(Cel.expr(environment, "-database"), {
    instanceClass: config.database.instanceClass,
    allocatedStorage: config.database.storage,
    // ... other configuration
  });
  
  const cache = new aws.elasticache.ReplicationGroup(Cel.expr(environment, "-cache"), {
    nodeType: config.cache.nodeType,
    numCacheClusters: config.cache.replicas,
    // ... other configuration
  });
  
  // Optional monitoring
  const monitoring = config.monitoring ? new aws.cloudwatch.Dashboard(Cel.expr(environment, "-dashboard"), {
    dashboardBody: JSON.stringify({
      widgets: [
        {
          type: 'metric',
          properties: {
            metrics: [
              ['AWS/RDS', 'CPUUtilization', 'DBInstanceIdentifier', database.id],
              ['AWS/ElastiCache', 'CPUUtilization', 'CacheClusterId', cache.id]
            ]
          }
        }
      ]
    })
  }) : null;
  
  return { database, cache, monitoring };
}
```

### Cross-Cloud Disaster Recovery

```typescript
// Primary region (AWS)
const primaryInfra = new CloudInfrastructure('primary', primaryConfig);

// Disaster recovery region (GCP)
const drDatabase = new gcp.sql.DatabaseInstance('dr-database', {
  name: 'myapp-dr',
  databaseVersion: 'POSTGRES_15',
  tier: 'db-f1-micro',
  region: 'us-central1'
});

const drApp = toResourceGraph(
  { name: 'dr-app', schema: { spec: DrAppSpec } },
  (schema) => ({
    app: simpleDeployment({
      name: Cel.expr(schema.spec.name, "-dr"),
      image: schema.spec.image,
      replicas: 1,  // Minimal replicas for DR
      
      env: {
        // Primary database (normal operation)
        PRIMARY_DATABASE_URL: Cel.template('postgresql://user:pass@%s:5432/myapp', primaryInfra.database.endpoint),
        
        // DR database (failover)
        DR_DATABASE_URL: Cel.template('postgresql://user:pass@%s:5432/myapp', drDatabase.connectionName),
        
        // Failover configuration
        FAILOVER_MODE: schema.spec.failoverMode,
        HEALTH_CHECK_URL: schema.spec.primaryHealthCheck
      }
    })
  }),
  (schema, resources) => ({
    drReady: Cel.expr(resources.app.status.readyReplicas, '> 0'),
    
    failoverActive: schema.spec.failoverMode === 'active',
    
    primaryHealthy: Cel.expr(
      Cel.template('http_get("%s").status == 200', schema.spec.primaryHealthCheck)
    )
  })
);
```

## Alchemy Deployment Workflows

### Development Workflow

```typescript
// dev-deploy.ts
import { deployCloudInfrastructure, deployKubernetesApp } from './deploy.js';

async function deployDevelopment() {
  const environment = 'development';
  
  // Deploy cloud resources with Alchemy
  const cloudResources = await deployCloudInfrastructure(environment);
  
  // Deploy Kubernetes app with TypeKro
  const k8sFactory = app.factory('direct', {
    namespace: environment
  });
  
  await k8sFactory.deploy({
    name: Cel.expr("myapp-", environment),
    image: 'myapp:latest',
    replicas: 1,
    cloudConfig: {
      databaseUrl: cloudResources.database.connectionString,
      cacheUrl: cloudResources.cache.endpoint
    }
  });
  
  console.log(Cel.template("✅ Deployed to %s", environment));
}
```

### Production Workflow

```typescript
// prod-deploy.ts
async function deployProduction() {
  const environment = 'production';
  
  // Deploy with high availability
  const cloudResources = await deployCloudInfrastructure(environment);
  
  // Deploy to multiple regions
  const regions = ['us-west-2', 'us-east-1'];
  
  await Promise.all(regions.map(async (region) => {
    const k8sFactory = app.factory('kro', {
      namespace: Cel.template("%s-%s", environment, region),
      context: Cel.template("%s-%s", environment, region)
    });
    
    return k8sFactory.deploy({
      name: Cel.template("myapp-%s-%s", environment, region),
      image: 'myapp:v1.0.0',
      replicas: 5,
      region,
      cloudConfig: {
        databaseUrl: cloudResources.database.connectionString,
        cacheUrl: cloudResources.cache.endpoint
      }
    });
  }));
}
```

## Monitoring and Observability

### Cloud + Kubernetes Monitoring

```typescript
// Monitoring stack with cloud and k8s metrics
const monitoringStack = toResourceGraph(
  { name: 'monitoring', schema: { spec: MonitoringSpec } },
  (schema) => ({
    // Prometheus for Kubernetes metrics
    prometheus: simpleDeployment({
      name: 'prometheus',
      image: 'prom/prometheus:latest',
      ports: [{ containerPort: 9090 }],
      
      volumeMounts: [{
        name: 'config',
        mountPath: '/etc/prometheus'
      }],
      
      volumes: [{
        name: 'config',
        configMap: { name: 'prometheus-config' }
      }]
    }),
    
    // Grafana for visualization
    grafana: simpleDeployment({
      name: 'grafana',
      image: 'grafana/grafana:latest',
      ports: [{ containerPort: 3000 }],
      
      env: {
        // Connect to cloud monitoring APIs
        AWS_CLOUDWATCH_REGION: 'us-west-2',
        GCP_MONITORING_PROJECT: 'my-project-id'
      }
    })
  }),
  (schema, resources) => ({
    prometheusReady: Cel.expr(resources.prometheus.status.readyReplicas, '> 0'),
    grafanaReady: Cel.expr(resources.grafana.status.readyReplicas, '> 0'),
    
    monitoringUrl: Cel.template(
      'http://%s:3000',
      resources.grafana.status.podIP
    )
  })
);

// Cloud monitoring configuration
const cloudWatchDashboard = new aws.cloudwatch.Dashboard('app-dashboard', {
  dashboardBody: JSON.stringify({
    widgets: [
      {
        type: 'metric',
        properties: {
          metrics: [
            ['AWS/RDS', 'DatabaseConnections', 'DBInstanceIdentifier', database.id],
            ['AWS/ApplicationELB', 'RequestCount', 'LoadBalancer', loadBalancer.arnSuffix]
          ],
          period: 300,
          stat: 'Average',
          region: 'us-west-2',
          title: 'Application Metrics'
        }
      }
    ]
  })
});
```

## Security and Compliance

### Secrets Management

```typescript
// AWS Secrets Manager integration
const dbSecret = new aws.secretsmanager.Secret('db-credentials', {
  description: 'Database credentials for MyApp'
});

const dbSecretVersion = new aws.secretsmanager.SecretVersion('db-credentials-version', {
  secretId: dbSecret.id,
  secretString: JSON.stringify({
    username: 'postgres',
    password: 'generated-secure-password'
  })
});

const secureApp = toResourceGraph(
  { name: 'secure-app', schema: { spec: SecureAppSpec } },
  (schema) => ({
    // Secret sync from cloud to k8s
    dbSecret: simpleSecret({
      name: 'db-credentials',
      stringData: {
        username: 'postgres',  // This would be populated by external-secrets operator
        password: 'placeholder'  // Replaced by actual secret
      },
      annotations: {
        'external-secrets.io/backend': 'secretsManager',
        'external-secrets.io/key': dbSecret.name
      }
    }),
    
    app: simpleDeployment({
      name: schema.spec.name,
      image: schema.spec.image,
      
      env: {
        DATABASE_HOST: database.endpoint,
        DATABASE_PORT: '5432',
        DATABASE_NAME: 'myapp'
      },
      
      envFrom: [{
        secretRef: { name: 'db-credentials' }
      }]
    })
  }),
  statusBuilder
);
```

### Policy as Code

```typescript
// AWS IAM policy for application
const appPolicy = new aws.iam.Policy('app-policy', {
  policy: JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: [
          's3:GetObject',
          's3:PutObject'
        ],
        Resource: Cel.template("%s/*", bucket.arn)
      },
      {
        Effect: 'Allow',
        Action: [
          'secretsmanager:GetSecretValue'
        ],
        Resource: dbSecret.arn
      }
    ]
  })
});

// Kubernetes ServiceAccount with IAM role
const serviceAccount = simpleServiceAccount({
  name: 'myapp-service-account',
  annotations: {
    'eks.amazonaws.com/role-arn': appRole.arn
  }
});
```

## Testing and Validation

### Integration Testing

```typescript
// integration-test.ts
import { deployTestEnvironment, runTests, cleanupTestEnvironment } from './test-utils.js';

async function runIntegrationTests() {
  let testEnv;
  
  try {
    // Deploy test environment
    testEnv = await deployTestEnvironment();
    
    // Wait for services to be ready
    await testEnv.waitForReady();
    
    // Run integration tests
    const testResults = await runTests({
      databaseUrl: testEnv.cloudResources.database.connectionString,
      appUrl: testEnv.k8sResources.service.url,
      cacheUrl: testEnv.cloudResources.cache.endpoint
    });
    
    console.log('Integration tests:', testResults);
    
  } finally {
    // Always cleanup
    if (testEnv) {
      await cleanupTestEnvironment(testEnv);
    }
  }
}
```

## Best Practices

### 1. Resource Naming Consistency

```typescript
// ✅ Consistent naming across cloud and k8s
const prefix = Cel.template("%s-%s", environment, appName);

const cloudDatabase = new aws.rds.Instance(Cel.expr(prefix, "-database"), {
  // ... configuration
});

const k8sApp = simpleDeployment({
  name: Cel.expr(prefix, "-app"),
  // ... configuration
});
```

### 2. Environment Separation

```typescript
// ✅ Separate cloud resources by environment
const environments = ['dev', 'staging', 'prod'];

environments.forEach(env => {
  const cloudStack = new CloudStack(Cel.expr(env, "-stack"), {
    environment: env,
    region: env === 'prod' ? 'us-west-2' : 'us-east-1'
  });
});
```

### 3. Cost Optimization

```typescript
// ✅ Environment-appropriate resource sizing
const getInstanceSize = (environment: string) => {
  switch (environment) {
    case 'production': return 'db.r5.xlarge';
    case 'staging': return 'db.t3.medium';
    case 'development': return 'db.t3.micro';
    default: return 'db.t3.micro';
  }
};
```

### 4. Error Handling

```typescript
// ✅ Robust error handling for cloud resources
try {
  const factory = app.factory('direct');
  await factory.deploy(spec);
} catch (error) {
  if (error.code === 'ResourceNotFound') {
    console.log('Cloud resource not ready, retrying...');
    await new Promise(resolve => setTimeout(resolve, 30000));
    // Retry logic
  } else {
    throw error;
  }
}
```

## Troubleshooting

### Common Issues

**Cloud resource not accessible from Kubernetes:**
- Check security groups and network configuration
- Verify DNS resolution
- Test connectivity from a debug pod

**Alchemy state conflicts:**
- Use `alchemy refresh` to sync state
- Check for resource naming conflicts
- Verify Alchemy backend configuration

**Cross-cloud networking issues:**
- Configure VPC peering or VPN connections
- Check firewall rules
- Verify service mesh configuration

## Next Steps

- **[GitOps Workflows](./gitops.md)** - Deploy Alchemy + TypeKro with GitOps
- **[Performance](../performance.md)** - Optimize multi-cloud deployments
- **[Troubleshooting](../troubleshooting.md)** - Debug cloud integration issues
- **[Examples](../../examples/)** - See real-world Alchemy + TypeKro applications