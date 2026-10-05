---
title: AWS Load Balancer Controller
description: Install the AWS Load Balancer Controller through Flux, and manage TargetGroupBinding and IngressClassParams resources
---

# AWS Load Balancer Controller

::: warning Experimental
These factories are experimental. The API may change in future releases.
:::

Install the [AWS Load Balancer Controller](https://kubernetes-sigs.github.io/aws-load-balancer-controller/)
on an EKS cluster through a Flux `HelmRepository` and `HelmRelease`, with a typed
spec and a status contract. Typed factories cover the controller's
`TargetGroupBinding` and `IngressClassParams` resources.

Verified against the `aws-load-balancer-controller` chart **3.5.0** (controller
`v3.5.0`) from `https://aws.github.io/eks-charts`.

TypeKro creates no AWS resources. The IAM role and policy, and the subnet tags,
are [prerequisites](#prerequisites).

## Installation

```typescript
import {
  awsLoadBalancerControllerBootstrap,
  ingressClassParams,
  targetGroupBinding,
} from 'typekro/aws-load-balancer-controller';
```

The integration is a subpath export only. The root `typekro` entry does not
re-export it.

## Quick example

```typescript
import { awsLoadBalancerControllerBootstrap } from 'typekro/aws-load-balancer-controller';

const factory = awsLoadBalancerControllerBootstrap.factory('kro', { namespace: 'platform' });

await factory.deploy({
  name: 'aws-load-balancer-controller',
  clusterName: 'prod',
  region: 'us-east-1',
  vpcId: 'vpc-0123456789abcdef0',
  serviceAccount: {
    annotations: {
      'eks.amazonaws.com/role-arn': 'arn:aws:iam::111122223333:role/aws-load-balancer-controller',
    },
  },
});
```

The same spec works with `factory('direct', ...)`. Both modes render the same
chart values; a unit test checks this.

## Available factories

| Export | Description |
|---|---|
| `awsLoadBalancerControllerBootstrap` | Bootstrap composition with the default build-time options |
| `makeAwsLoadBalancerControllerBootstrap(options)` | Build the bootstrap with a custom install/upgrade/CRD policy or raw chart values |
| `awsLoadBalancerControllerHelmRepository` | The eks-charts `HelmRepository` |
| `awsLoadBalancerControllerHelmRelease` | The controller `HelmRelease` |
| `mapAwsLoadBalancerControllerConfigToHelmValues` | Map a bootstrap spec to chart values |
| `targetGroupBinding` | `elbv2.k8s.aws/v1beta1` `TargetGroupBinding` |
| `ingressClassParams` | `elbv2.k8s.aws/v1beta1` `IngressClassParams` (cluster-scoped) |

## Bootstrap composition

The composition owns the controller `HelmRelease`, in `flux-system`, and installs
the chart into `spec.namespace`. The eks-charts `HelmRepository` is a shared
singleton, so removing one install does not remove the chart source another
release uses. The composition creates no Namespace. The default, `kube-system`,
always exists, and Flux creates any other one (`install.createNamespace`).

### Runtime spec

| Field | Default | Notes |
|---|---|---|
| `name` | required | Helm release name |
| `clusterName` | required | EKS cluster name |
| `namespace` | `kube-system` | Install namespace |
| `chartVersion` | `3.5.0` | |
| `region`, `vpcId` | discovered | Set them when the pods cannot reach the instance metadata service |
| `replicaCount` | `2` (chart) | |
| `image` | chart | `repository`, `tag`, `pullPolicy`. For example, a regional or private ECR mirror |
| `serviceAccount.create` | `true` | |
| `serviceAccount.name` | `aws-load-balancer-controller` | Pinned, so an IRSA trust policy or a Pod Identity association can name it |
| `serviceAccount.annotations` | none | `eks.amazonaws.com/role-arn` for IRSA |
| `podDisruptionBudget` | `{ maxUnavailable: 1 }` | `minAvailable` or `maxUnavailable`, integers. The chart renders it only above 1 replica. `{}` disables it |
| `topologySpreadConstraints` | none | Passed to the chart unchanged. The pods carry `app.kubernetes.io/name: aws-load-balancer-controller` |
| `enableServiceMutatorWebhook` | `false` | When `true`, the controller claims every new `type: LoadBalancer` Service. It stays off so that Services another controller handles are not taken over. See [Services](#services-of-type-loadbalancer) |
| `createIngressClassResource` | `true` (chart) | Creates the `alb` IngressClass and its IngressClassParams |
| `ingressClass` | `alb` (chart) | |
| `defaultTargetType` | `ip` | `ip` targets pods directly and needs pod IPs the VPC can route to: the Amazon VPC CNI, or Cilium in ENI mode. With an overlay CNI (Cilium in VXLAN or Geneve mode, Calico VXLAN/IPIP), set `instance`, which goes through NodePorts and is the chart's default |
| `resources` | none (chart) | `requests` / `limits` |
| `nodeSelector`, `tolerations` | none (chart) | |
| `logLevel` | `info` (chart) | `info` or `debug` |

### Build-time options

`makeAwsLoadBalancerControllerBootstrap(options)` takes options that must be
concrete values:

| Option | Default | Notes |
|---|---|---|
| `install`, `upgrade`, `driftDetection` | see below | The Flux lifecycle options every TypeKro HelmRelease factory takes. See [Install, upgrade and CRD policy](/api/flux/#install-upgrade-and-crd-policy) |
| `values` | none | Raw chart values for settings the spec does not map. Setting one the spec maps throws a `ValidationError`; see below |
| `name`, `kind` | `aws-load-balancer-controller-bootstrap`, `AwsLoadBalancerControllerBootstrap` | The composition's name and custom resource kind |

```typescript
import { makeAwsLoadBalancerControllerBootstrap } from 'typekro/aws-load-balancer-controller';

const lbc = makeAwsLoadBalancerControllerBootstrap({
  upgrade: { timeout: '20m' },
  values: { enableShield: false, podDisruptionBudget: { maxUnavailable: '50%' } },
});
```

Raw `values` are build-time because a KRO instance cannot carry an arbitrary
values tree into individual chart fields. Use them for chart settings the spec
does not model. They cannot set a chart value the spec maps (`clusterName`,
`region`, `vpcId`, `replicaCount`, `image`, `serviceAccount.create`,
`serviceAccount.name`, `serviceAccount.annotations`, `topologySpreadConstraints`,
`enableServiceMutatorWebhook`, `createIngressClassResource`, `ingressClass`,
`defaultTargetType`, `resources`, `nodeSelector`, `tolerations`, `logLevel`),
at any depth: the factory throws a `ValidationError` naming the spec field to
use. Build-time values cannot merge with a KRO instance's spec, so replacing a
mapped value would silently drop what the instance sets. Two cases matter most:

- **IRSA.** Put the role annotation in `spec.serviceAccount.annotations`, together
  with any other service-account annotations. `values.serviceAccount` may only
  add fields the spec does not map, such as `automountServiceAccountToken`.
- **Image.** Set the registry mirror and tag in `spec.image`
  (`{ repository, tag }`). Do not split them between `values.image` and the spec.

`podDisruptionBudget` is the exception, because the spec field takes integers
only: a build-time `podDisruptionBudget` (for example `{ maxUnavailable: '50%' }`)
replaces the default `{ maxUnavailable: 1 }`, and an instance's own
`spec.podDisruptionBudget` replaces either one as a whole, so `minAvailable` and
`maxUnavailable` never end up together.

The chart's `keepTLSSecret` is set to `true`, so an upgrade keeps the webhook
certificate the chart generated instead of minting a new one. A new
certificate would leave the webhooks failing until the CA bundle catches up.
Override it with build-time `values`.

### Services of type LoadBalancer

With `enableServiceMutatorWebhook: false` (the default), the controller handles
a `type: LoadBalancer` Service only when the Service opts in. Without that, the
in-tree legacy cloud provider handles the Service and creates a Classic Load
Balancer. Opt in with either:

- `spec.loadBalancerClass: service.k8s.aws/nlb`, or
- the annotation `service.beta.kubernetes.io/aws-load-balancer-type: external`
  (with `service.beta.kubernetes.io/aws-load-balancer-nlb-target-type: ip` or
  `instance`).

`loadBalancerClass` is immutable, so set it when you create the Service.

### CRD lifecycle

The chart ships its CRDs (`TargetGroupBinding`, `IngressClassParams`, and the
`gateway.k8s.aws` and `aga.k8s.aws` kinds) in its `crds/` directory. Flux skips
`crds/` on upgrade by default, so a chart bump would keep the CRDs of the first
install. The release therefore defaults to `install.crds` and `upgrade.crds` of
`CreateReplace`. Other defaults: 10m timeouts, 3 remediation retries, and
rollback when an upgrade fails. Override any of them with the build-time
`install` / `upgrade` options, or on `awsLoadBalancerControllerHelmRelease`.

### Status contract

| Field | Source |
|---|---|
| `ready` | The HelmRelease's `Ready` condition is `True` for the current generation |
| `failed` | The HelmRelease's `Ready` condition is `False` for the current generation |
| `phase` | `Ready`, `Failed` or `Installing` |
| `version` | The chart version Flux installed, from the HelmRelease history (`''` before the first install) |

## TargetGroupBinding

Register a Service's endpoints with a target group that exists outside the
cluster, for example one created by Terraform or CloudFormation.

```typescript
import { targetGroupBinding } from 'typekro/aws-load-balancer-controller';

targetGroupBinding({
  name: 'web',
  namespace: 'apps',
  spec: {
    serviceRef: { name: 'web', port: 80 },
    targetGroupARN:
      'arn:aws:elasticloadbalancing:us-east-1:111122223333:targetgroup/web/0123456789abcdef',
    targetType: 'ip',
    networking: {
      ingress: [{ from: [{ securityGroup: { groupID: 'sg-0123456789abcdef0' } }], ports: [{ port: 8080 }] }],
    },
  },
  id: 'webTargets',
});
```

Name the target group by `targetGroupARN`, by `targetGroupName` (the controller
looks the ARN up), or both; with both set, the controller uses the ARN. The type
requires at least one, and the factory throws a `ValidationError` when both are
missing or empty, because the controller's webhook rejects such a binding. A
schema reference counts as set, since its value is only known per instance.

The factory also rejects, on concrete values, what the controller's webhook
rejects without looking at AWS: `nodeSelector` with `targetType: 'ip'`,
`iamRoleArnToAssume` or a `QUIC` / `TCP_QUIC` `targetGroupProtocol` with
`targetType: 'instance'`, and a `vpcID` that is not `vpc-` followed by 8, 17 or
32 lowercase hex characters.

`targetGroupARN`, `targetType`, `ipAddressType` and `vpcID` cannot change after
the binding is created; to change one, create a new binding. On create, the
controller's mutating webhook fills in whichever of them you leave unset (the
ARN from `targetGroupName`, the others from the target group). A later apply
that omits a field the webhook filled in can then be rejected as a change to
an immutable field. Set `targetType` explicitly, and set `ipAddressType` and
`vpcID` too when you know them.

Readiness: ready once `status.observedGeneration` has reached
`metadata.generation` and no condition is `False`.

## IngressClassParams

Settings applied to every Ingress of an IngressClass. The resource is
cluster-scoped and is ready as soon as it exists.

```typescript
import { ingressClassParams } from 'typekro/aws-load-balancer-controller';

ingressClassParams({
  name: 'internal',
  spec: { scheme: 'internal', group: { name: 'internal' }, targetType: 'ip' },
});
```

Point an `IngressClass` at it with
`parameters: { apiGroup: 'elbv2.k8s.aws', kind: 'IngressClassParams', name: 'internal' }`
and `controller: 'ingress.k8s.aws/alb'`.

## Prerequisites

### IAM

The controller calls the EC2, ELBv2, ACM, WAF, Shield and Cognito APIs. Its role
needs the upstream IAM policy for the pinned controller version:

- [`iam_policy.json` for v3.5.0](https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/v3.5.0/docs/install/iam_policy.json)
  (exported as `AWS_LBC_IAM_POLICY_URL`)
- [`iam_policy_us-gov.json`](https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/v3.5.0/docs/install/iam_policy_us-gov.json)
  for AWS GovCloud (US)

Use the policy from the same tag as the controller you run. Bind the role in one
of two ways:

- **IRSA:** a role whose trust policy allows
  `system:serviceaccount:<namespace>:aws-load-balancer-controller` through the
  cluster's OIDC provider. Set `serviceAccount.annotations` to
  `{ 'eks.amazonaws.com/role-arn': '<role ARN>' }`.
- **EKS Pod Identity:** create a Pod Identity association for the service
  account `aws-load-balancer-controller` in the install namespace. No annotation
  is needed.

### Subnet discovery tags

Without explicit subnets, the controller picks load balancer subnets by tag:

| Tag | Value | Subnets |
|---|---|---|
| `kubernetes.io/role/elb` | `1` | Public subnets, for internet-facing load balancers |
| `kubernetes.io/role/internal-elb` | `1` | Private subnets, for internal load balancers |

`kubernetes.io/cluster/<cluster-name>` (`owned` or `shared`) is optional. When
several clusters share a VPC, it limits a subnet to the clusters that carry it.
See [subnet discovery](https://kubernetes-sigs.github.io/aws-load-balancer-controller/latest/deploy/subnet_discovery/).
Alternatively, set the subnets per Ingress, per Service, or with
`IngressClassParams.spec.subnets`.

### Cluster

Flux must be installed. The controller's webhooks use the self-signed
certificate the chart generates unless you set `enableCertManager` through
`values`.

## See also

- [Flux: install, upgrade and CRD policy](/api/flux/#install-upgrade-and-crd-policy)
- [AWS Load Balancer Controller documentation](https://kubernetes-sigs.github.io/aws-load-balancer-controller/)
- [Controller release v3.5.0](https://github.com/kubernetes-sigs/aws-load-balancer-controller/releases/tag/v3.5.0)
