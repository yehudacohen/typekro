---
title: Karpenter
description: Install Karpenter on EKS with Flux and declare typed NodePools and EC2NodeClasses
---

# Karpenter

`typekro/karpenter` installs the [Karpenter](https://karpenter.sh/) controller on Amazon EKS
through Flux and gives you typed factories for its two APIs:

- `nodePool` — `karpenter.sh/v1` `NodePool`, what Karpenter may launch and when it may remove it
- `ec2NodeClass` — `karpenter.k8s.aws/v1` `EC2NodeClass`, how the EC2 instances are built

Verified against the official `karpenter` and `karpenter-crd` charts **1.14.1**
(`oci://public.ecr.aws/karpenter`). TypeKro creates no AWS resources: see
[AWS prerequisites](#aws-prerequisites).

## Import

```typescript
import { ec2NodeClass, karpenterBootstrap, nodePool } from 'typekro/karpenter';
```

`typekro/karpenter` is a subpath export only; it is not re-exported from `typekro`.

## Quick example

```typescript
import { karpenterBootstrap } from 'typekro/karpenter';

const factory = karpenterBootstrap.factory('direct', {
  namespace: 'flux-system',
  waitForReady: true,
});

await factory.deploy({
  name: 'karpenter',
  clusterName: 'my-cluster',
  interruptionQueue: 'my-cluster',
  // IRSA. With EKS Pod Identity leave this out (see below).
  serviceAccount: {
    annotations: {
      'eks.amazonaws.com/role-arn': 'arn:aws:iam::111122223333:role/KarpenterController-my-cluster',
    },
  },
  resources: { requests: { cpu: '1', memory: '1Gi' }, limits: { memory: '1Gi' } },
});
```

`'direct'` applies the resources immediately. `'kro'` emits a ResourceGraphDefinition and
lets KRO reconcile it. Both produce the same `HelmRelease`s.

## Available factories

| Export | Kind | Scope | Description |
|---|---|---|---|
| `karpenterBootstrap` | Composition | Cluster | CRDs plus controller, with the defaults below |
| `makeKarpenterBootstrap(options)` | Composition | Cluster | The same, with build-time options |
| `karpenterHelmRepositoryBootstrap` | Composition | Singleton | Shared OCI `HelmRepository` owner |
| `nodePool` | NodePool | Cluster | Typed `karpenter.sh/v1` NodePool |
| `ec2NodeClass` | EC2NodeClass | Cluster | Typed `karpenter.k8s.aws/v1` EC2NodeClass |
| `karpenterReady(...resources)` | Status helper | — | `true` once every resource is `Ready` for its current generation |
| `karpenterHelmRepository`, `karpenterCrdHelmRelease`, `karpenterHelmRelease` | Flux | Namespace | The Helm resources the bootstrap uses |
| `validateNodePoolSpec`, `validateEC2NodeClassSpec`, `validateKarpenterBootstrapConfig` | Validators | — | Common-mistake checks (below) |

## Bootstrap composition

### CRDs

Upstream recommends the separate `karpenter-crd` chart for CRDs, because Helm never upgrades
the `crds/` directory of the controller chart
([CRD upgrades](https://karpenter.sh/docs/upgrading/upgrade-guide/#crd-upgrades)). The bootstrap
follows that:

1. `<name>-crd` installs `karpenter-crd`, whose templates carry the CRDs, so they upgrade with
   the release.
2. `<name>` installs `karpenter` with `install.crds` and `upgrade.crds` set to `Skip`. Its
   Flux `spec.dependsOn` names `<name>-crd`, so Flux holds every install and upgrade of the
   controller until the CRD release is Ready at its current generation. That ordering holds in
   KRO mode too, where both `HelmRelease`s are created at once.

Both charts use the same `version`. The CRDs carry `helm.sh/resource-policy: keep`, so
uninstalling the bootstrap does not delete them, and with them every NodePool and NodeClaim.
Pass `keepCrdsOnUninstall: false` to change that, or `crds: 'external'` if something else
manages the CRDs.

### Runtime spec

| Field | Chart value | Default |
|---|---|---|
| `name` | release name, `fullnameOverride` | required |
| `namespace` | install namespace | `kube-system` |
| `version` | both chart versions | `1.14.1` |
| `clusterName` | `settings.clusterName` | required |
| `clusterEndpoint` | `settings.clusterEndpoint` | discovered from EKS |
| `interruptionQueue` | `settings.interruptionQueue` | disabled |
| `replicas` | `replicas` | `2` |
| `logLevel` | `logLevel` (`debug`, `info`, `error`) | `info` |
| `dnsPolicy` | `dnsPolicy` | `ClusterFirst` |
| `serviceAccount.name` / `.annotations` | `serviceAccount.*` | the release name / none |
| `podDisruptionBudget.maxUnavailable` | `podDisruptionBudget.maxUnavailable` | `1` (the PDB is always named `karpenter`) |
| `nodeSelector`, `affinity` | merged by Helm with the chart defaults | chart defaults |
| `topologySpreadConstraints`, `tolerations` | replace the chart's lists | the chart's lists |
| `resources` | `controller.resources` | requests 1 CPU / 1Gi, limit 1Gi memory; `{}` sets none |

The resource default is deliberate: a BestEffort controller is the first pod starved under
pressure, and it cannot reschedule onto nodes it launches itself. The chart names its
PodDisruptionBudget `karpenter` whatever the release is called, so install one bootstrap per
namespace.

The chart's default affinity keeps the controller off nodes Karpenter launched
(`karpenter.sh/nodepool DoesNotExist`). Run it on a managed node group or Fargate, using
`nodeSelector` for example. If you override `affinity`, keep that rule;
`validateKarpenterBootstrapConfig` warns when it is missing.

`dnsPolicy: 'Default'` resolves through the node rather than cluster DNS. Use it when CoreDNS
itself runs on Karpenter nodes, so the controller can start before DNS is up. Karpenter 1.1+
has no webhooks, so there are no webhook settings to configure.

### Build-time options

| Option | Default | Effect |
|---|---|---|
| `crds` | `'karpenter-crd'` | `'external'` installs only the controller |
| `keepCrdsOnUninstall` | `true` | Annotate the CRDs with `helm.sh/resource-policy: keep` |
| `namespaceOwnership` | `'external'` | `'external'` lets Flux create a missing namespace (`install.createNamespace`); `'owned'` makes it part of the graph (not for `kube-system`) |
| `values` | none | Raw chart values, deep-merged last (objects merge, lists replace) |
| `name`, `kind` | `karpenter-bootstrap`, `KarpenterBootstrap` | RGD name and kind |

Alpha feature gates (`nodeRepair`, `spotToSpotConsolidation`, `staticCapacity`, ...) are not
typed; set them through `values`:

```typescript
import { makeKarpenterBootstrap } from 'typekro/karpenter';

const karpenter = makeKarpenterBootstrap({
  values: { settings: { featureGates: { spotToSpotConsolidation: true } } },
});
```

### Status

| Field | Source |
|---|---|
| `ready` | Both `HelmRelease`s `Ready=True` for their current generation |
| `failed` | Either release `Ready=False` for its current generation |
| `phase` | `Ready`, `Installing` or `Failed` |
| `version` | Controller chart version Flux installed (`status.history`), `''` until then |

## NodePool

```typescript
import { KARPENTER_LABELS, nodePool } from 'typekro/karpenter';

const spot = nodePool({
  name: 'spot-batch',
  spec: {
    template: {
      metadata: { labels: { workload: 'batch' } },
      spec: {
        nodeClassRef: { name: 'default' }, // group/kind default to EC2NodeClass
        requirements: [
          { key: KARPENTER_LABELS.capacityType, operator: 'In', values: ['spot'] },
          { key: KARPENTER_LABELS.instanceCategory, operator: 'In', values: ['c', 'm', 'r'] },
          { key: KARPENTER_LABELS.instanceGeneration, operator: 'Gt', values: ['5'] },
          { key: KARPENTER_LABELS.instanceFamily, operator: 'Exists', minValues: 5 },
        ],
        taints: [{ key: 'workload', value: 'batch', effect: 'NoSchedule' }],
        expireAfter: '168h',
      },
    },
    disruption: {
      consolidationPolicy: 'WhenEmptyOrUnderutilized',
      consolidateAfter: '1m',
      budgets: [
        { nodes: '20%' },
        { nodes: '0', schedule: '0 8 * * mon-fri', duration: '10h', reasons: ['Underutilized'] },
      ],
    },
    limits: { cpu: '400', memory: '1600Gi' },
    weight: 10,
  },
  id: 'spotPool',
});
```

`KARPENTER_LABELS` lists the well-known requirement keys: `capacityType`, `instanceType`,
`instanceCategory`, `instanceFamily`, `instanceGeneration`, `instanceSize`, `instanceCpu`,
`instanceMemory`, `zone`, `arch` and `os`. Operators are `In`, `NotIn`, `Exists`,
`DoesNotExist`, `Gt`, `Lt`, `Gte` and `Lte`.
See [NodePools](https://karpenter.sh/docs/concepts/nodepools/) and
[scheduling](https://karpenter.sh/docs/concepts/scheduling/).

## EC2NodeClass

```typescript
import { ec2NodeClass } from 'typekro/karpenter';

const nodeClass = ec2NodeClass({
  name: 'default',
  spec: {
    role: 'KarpenterNodeRole-my-cluster', // or instanceProfile, never both
    amiSelectorTerms: [{ alias: 'al2023@latest' }],
    subnetSelectorTerms: [{ tags: { 'karpenter.sh/discovery': 'my-cluster' } }],
    securityGroupSelectorTerms: [{ tags: { 'karpenter.sh/discovery': 'my-cluster' } }],
    blockDeviceMappings: [
      { deviceName: '/dev/xvda', rootVolume: true, ebs: { volumeSize: '50Gi', volumeType: 'gp3', encrypted: true } },
    ],
    metadataOptions: { httpTokens: 'required', httpPutResponseHopLimit: 1 },
    kubelet: { maxPods: 110, systemReserved: { cpu: '100m', memory: '100Mi' } },
    tags: { team: 'platform' },
  },
  id: 'defaultNodeClass',
});
```

Also typed: `capacityReservationSelectorTerms`, `placementGroupSelector`, `networkInterfaces`
(EFA), `ipPrefixCount`, `cpuOptions`, `connectionTracking`, `context`, `instanceStorePolicy`,
`detailedMonitoring` and `associatePublicIPAddress`; status adds `capacityReservations`.

When `metadataOptions` is omitted the CRD defaults to IMDSv2 only with a hop limit of 1.
See [NodeClasses](https://karpenter.sh/docs/concepts/nodeclasses/).

## Readiness and status

Both factories are ready when the `Ready` condition is `True` and its `observedGeneration` is
not behind `metadata.generation`, so a spec update is not ready until Karpenter has evaluated
it.

| State | Ready | Reason |
|---|---|---|
| No conditions yet | no | `StatusMissing` |
| No `Ready` condition | no | `ReadyConditionMissing` |
| `Ready=True` from an older generation | no | `StaleCondition` |
| `Ready=True` | yes | `Ready` |
| `Ready=False` | no | the condition's reason, e.g. `NodeClassNotReady` |

In a composition's status, use `karpenterReady(...)` rather than joining checks with `&&`.
`NodePool` also reports `status.nodes` and `status.resources`:

```typescript
return { ready: karpenterReady(nodeClass, spot), spotNodes: spot.status.nodes };
```

## Validation

`nodePool` and `ec2NodeClass` throw on mistakes the API server would reject. They and the
bootstrap log warnings for legal but risky settings. The validators return both. Values only known at
reconcile time are skipped.

| Check | Severity |
|---|---|
| NodePool without `nodeClassRef` | error |
| `In`/`Gt`/`Lt`/`Gte`/`Lte` with missing or empty values; `Gt` etc. without exactly one integer; `minValues` outside 1-50 or above the number of values | error |
| `disruption` without `consolidateAfter` (the CRD requires it once `disruption` is set) | error |
| Requirement or template label on `karpenter.sh/nodepool`, `kubernetes.io/hostname`, or a key in the `karpenter.sh` or `karpenter.k8s.aws` domains outside the CRD's allowlist of well-known labels | error |
| A NodePool or EC2NodeClass name over 63 characters (Karpenter puts it in a label value on every NodeClaim and Node) | error |
| `expireAfter`, `terminationGracePeriod`, `consolidateAfter`, budget `nodes` or `duration` not matching the CRD pattern; a static NodePool (`replicas` set) with `weight` or limits other than `nodes` | error |
| Budget `schedule` without `duration`, or the reverse; `weight` outside 1-100 | error |
| NodePool with empty `requirements` | warning |
| NodePool without `limits` | warning |
| EC2NodeClass with both or neither of `role` and `instanceProfile`, or an empty one; empty or reserved `spec.tags` keys (`eks:eks-cluster-name`, `kubernetes.io/cluster/*`, `karpenter.sh/nodepool`, `karpenter.sh/nodeclaim`, `karpenter.k8s.aws/ec2nodeclass`) | error |
| Empty or field-less AMI, subnet or security group selectors; `alias` mixed with other terms; `alias`, `id` or `ssmParameter` combined with another field in the same term (Karpenter would ignore the others); a subnet or security group term whose `id` (or security group `name`) is combined with another field, which Karpenter would ignore; more than 30 AMI terms or 20 tags in a term, empty selector tag keys or values, a malformed AMI, subnet or security group `id`; no `amiFamily` without an alias; two root volumes | error |
| Alias not `<family>@<version>`, an unknown family, a Windows alias other than `@latest`, or an `amiFamily` other than the alias's family or `Custom` | error |
| EBS mapping with neither `volumeSize` nor `snapshotID` | error |
| `metadataOptions.httpTokens: 'optional'` (IMDSv1) | warning |
| Bootstrap without `interruptionQueue`, with one replica, with `resources` but no requests, or with an affinity that allows Karpenter nodes | warning |

## AWS prerequisites

Create these outside TypeKro, for example with the upstream
[CloudFormation template for 1.14.1](https://raw.githubusercontent.com/aws/karpenter-provider-aws/v1.14.1/website/content/en/docs/getting-started/getting-started-with-karpenter/cloudformation.yaml)
([explained](https://karpenter.sh/docs/reference/cloudformation/)), Terraform or eksctl:

1. **Controller IAM role and policy.** Bound to the `karpenter` ServiceAccount in the install
   namespace, either with [IRSA](https://docs.aws.amazon.com/eks/latest/userguide/iam-roles-for-service-accounts.html)
   (set `serviceAccount.annotations['eks.amazonaws.com/role-arn']`) or an
   [EKS Pod Identity](https://docs.aws.amazon.com/eks/latest/userguide/pod-identities.html)
   association (no annotation). The policy must allow `iam:PassRole` on the node role.
2. **Node IAM role and instance profile.** Pass the role name as `role` and Karpenter
   manages the instance profile, or create the profile yourself and pass `instanceProfile`.
3. **SQS interruption queue and EventBridge rules.** A queue (pass its name as
   `interruptionQueue`) whose policy allows `sqs:SendMessage` from `events.amazonaws.com` and
   `sqs.amazonaws.com`, and five rules targeting it: `AWS Health Event` (`aws.health`),
   `EC2 Spot Instance Interruption Warning`, `EC2 Instance Rebalance Recommendation`,
   `EC2 Instance State-change Notification` and
   `EC2 Capacity Reservation Instance Interruption Warning` (`aws.ec2`).
   See [interruption](https://karpenter.sh/docs/concepts/disruption/#interruption).
4. **Discovery tags.** Tag the subnets and security groups the nodes should use, e.g.
   `karpenter.sh/discovery: <cluster-name>`, and select them by that tag.
5. **Cluster access for the node role.** An
   [EKS access entry](https://docs.aws.amazon.com/eks/latest/userguide/access-entries.html)
   of type `EC2_LINUX` for the node role, or a `system:bootstrappers` / `system:nodes`
   mapping in the `aws-auth` ConfigMap.

The [getting-started guide](https://karpenter.sh/docs/getting-started/getting-started-with-karpenter/)
walks through all five.

## Teardown

Delete your NodePools and EC2NodeClasses **before** removing the bootstrap. The controller
holds finalizers on them and on every NodeClaim, and it is the only thing that terminates the
EC2 instances behind them. Remove it first and those objects stay stuck in deletion, while the
instances keep running and billing. The CRDs survive an uninstall by default
(`keepCrdsOnUninstall`).

## Example

[`examples/karpenter-node-pools.ts`](https://github.com/yehudacohen/typekro/blob/master/examples/karpenter-node-pools.ts)
installs the controller and declares one EC2NodeClass with two NodePools: a tainted spot pool
for batch and dev work, and an on-demand pool for everything else.

## See also

- [Karpenter documentation](https://karpenter.sh/docs/)
- [Settings reference](https://karpenter.sh/docs/reference/settings/)
- [Upgrade guide](https://karpenter.sh/docs/upgrading/upgrade-guide/)
