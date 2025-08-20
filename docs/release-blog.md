# Introducing TypeKro
## *Declarative Orchestration of Kubernetes Resources with TypeScript instead of YAML*

I've never met a developer who likes YAML very much. Nonetheless, I keep running into Kubernetes engineers who will spend hours debugging YAML indentation errors. It is striking to me that despite tools like Pulumi and cdk8s which provide statically typed language support for Kubernetes, YAML has become so endemic within Kubernetes circles despite its lack of support for autocomplete, static linting, type-hinting, and modern development tooling.

I think it is worthwhile noting that hardcore Kubernetes enthusiasts end up (almost universally) enduring the pain of YAML configuration, electing to write Helm charts or Kustomizations to manage their infrastructure rather than adopting tools that let them define their infrastructure in expressive, modern, statically typed programming languages. This stands in stark contrast to AWS engineers, who have long since abandoned the pain of writing CloudFormation templates in favor of Pulumi or Terraform or the AWS CDK.

This blog post has two  objectives:

1. To explain why I think Pulumi and cdk8s have not succeeded in gaining traction in the Kubernetes ecosystem.
2. To introduce you to TypeKro, a new Kubernetes SDK that I have been working on with the goal of bringing Kubernetes development into the 2020s, and enable engineers to achieve a seamless development experience that benefits from the expressiveness and tooling of modern programming languages. All while using primitives they are familiar with, and without the pain points of cdk8s or Pulumi.

### The Shortcomings of Pulumi and cdk8s and the existing Kubernetes eco-system

Pulumi and cdk8s are the two primary options available to Kubernetes engineers if they want to define their infrastructure using modern programming languages rather than YAML.

Both of these approaches have impedance mismatches with the natural declarative paradigm adopted by the Kubernetes CI/CD ecosystem. You see, unlike the RESTful APIs that are provided by many SaaS, PaaS, or IaaS vendors, the Kubernetes control plane doesn't really succeed or fail at a single resource.

Kubernetes has no care for dependencies. Instead of applying resources one at a time to the Kubernetes cluster, you blast all your YAML configuration at the cluster, and let it try and try and try again to reconcile the state until Kubernetes' reconciliation loop successfully aligns your cluster's actual runtime configuration with the desired state as declared in your YAML configuration.

### Why not Pulumi?

This impedance mismatch between the operational model of Pulumi and the operational model of the Kubernetes control plane renders Pulumi non-ideal for Kubernetes development. Because orchestrating Kubernetes resources in topological order as dictated by a dependency graph generated before deployment is inconsistent with the Kubernetes declarative and eventually consistency philosophy. 

Why should Kubernetes infrastructure be held back by the need to define a dependency graph up front, and why should we wait for a resource to become ready prior to deploying its dependencies. 

But directed acyclic graphs and dependency ordering are fundamental to Pulumi’s deployment model, and if Pulumi were to deploy dependencies without waiting for the parent resources to become ready, Pulumi users would forever remain ignorant of whether their deployment succeeded.

### Why not cdk8s?

The approach cdk8s takes is closer to the operational model of Kubernetes. Rather than waiting to deploy each Kubernetes resource and watching the control plane for stability before deploying dependent resources, cdk8s generates YAML that tools like ArgoCD can then deploy and monitor for stability.

This renders cdk8s useful in the generation of YAML, but insufficient to perform safe deployments to your Kubernetes cluster. Instead, you must supplement cdk8s with a second tool like Argo CD to deploy and monitor the YAML it generates.

If a cdk8s deployment fails, an engineer must then correlate the errors reported by Argo with the source CDK code before synthesizing the YAML again.

Because of its operational model, the Kubernetes ecosystem demands deep integration with its native CI/CD tools like Argo and Flux. Kubernetes engineers elect to use YAML with clunky tools like Kustomize and Helm because that is their best approach to reaping the benefits of the Kubernetes ecosystem.

### The Growing Need for Better Kubernetes Orchestration Abstractions

These tooling challenges have become even more pressing as Kubernetes has evolved far beyond its original scope. Since around 2017, the Kubernetes community has extended the platform far beyond its original intent as a container orchestration platform.

With the introduction of Kubernetes operators, the Kubernetes control plane evolved from managing deployments and replica sets to managing everything needed for your Kubernetes workload. From external DNS records with ExternalDNS, to provisioning your AWS dependencies using the AWS Service Operator (and more recently using ACK), to provisioning your Azure resources using the Azure Service Operator, to the Cluster API project that emerged to operate other Kubernetes clusters, to Crossplane that has successfully built a framework to let you orchestrate all of your platform engineering components with the Kubernetes control plane.

It should come as no surprise then that as the Kubernetes control plane has evolved from a container platform to a universal control plane, orchestration primitives have become vital to building complex workloads. After all, the Kubernetes control plane needs to understand the state of resources that operate beyond the Kubernetes boundary. It also needs to be able to consume data about resources that it creates. Take an Amazon RDS database created with a Kubernetes operator, for instance. The deployments that depend on this database must be able to discover its connection string even though it might not be available when the deployment manifest is applied.

The Kubernetes ecosystem has stepped up to address these orchestration challenges, but the solutions reveal both the potential and limitations of current approaches.

### Kubernetes Resource Orchestration with Crossplane 

Perhaps the most well-known approach to orchestrating complex kubernetes dependencies is the one taken by Crossplane.

For the uninitiated, Crossplane extends the Kubernetes API itself with custom resource definitions (CRDs) that represent cloud resources. You define composite resource definitions (XRDs) that describe the schema of your infrastructure abstractions, then create compositions that template the underlying managed resources.

Here's a simplified example of what a Crossplane composition looks like for creating a database with its required networking:
```yaml
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: database-with-vpc
spec:
  compositeTypeRef:
    apiVersion: example.com/v1alpha1
    kind: XDatabase
  resources:
  - name: vpc
    base:
      apiVersion: ec2.aws.crossplane.io/v1beta1
      kind: VPC
      spec:
        forProvider:
          cidrBlock: "10.0.0.0/16"
          region: us-west-2
  - name: subnet
    base:
      apiVersion: ec2.aws.crossplane.io/v1beta1
      kind: Subnet
      spec:
        forProvider:
          availabilityZone: us-west-2a
          cidrBlock: "10.0.1.0/24"
          region: us-west-2
          vpcIdSelector:
            matchControllerRef: true
  - name: rds-instance
    base:
      apiVersion: rds.aws.crossplane.io/v1alpha1
      kind: RDSInstance
      spec:
        forProvider:
          dbInstanceClass: db.t3.micro
          engine: postgres
          dbSubnetGroupNameSelector:
            matchControllerRef: true
```

To understand how this works, you need to grasp Crossplane's approach to dependencies and cloud provider integration. The forProvider field contains the actual configuration that gets passed to the AWS API - essentially a direct mapping of the cloud provider's resource schema. The vpcIdSelector with matchControllerRef: true tells Crossplane to automatically populate the VPC ID field by finding another resource in the same composition that can provide it.

This selector-based dependency model is clever in theory - resources automatically wire themselves together through Kubernetes' controller reference system. But in practice, can result in debugging nightmares when selectors don't match or when the dependency chain breaks.

Firstly, the YAML complexity becomes even more pronounced as you extend the kubernetes YAML DSL with Crossplane’s own DSL. That simple example above already feels unintuitive to me, and real-world compositions often span hundreds of lines with cryptic field paths like spec.forProvider.vpcSecurityGroupIds[0]. Debugging failures requires correlating errors across multiple managed resources, often with minimal context about which part of your composition is actually failing.

Secondly, while Crossplane introduced composition functions to address some of these limitations, these functions are often not sufficient for complex orchestration needs. If, for example, you want to conditionally create resources based on input parameters, you'll need to write a composition function - essentially a containerized program that transforms your composite resource into managed resources. This means your "declarative" infrastructure now includes imperative code running in your cluster.

The fundamental issue is that Crossplane has taken the Kubernetes paradigm of "everything is YAML" and applied it to problems that don't naturally fit that model. Complex infrastructure orchestration often requires conditional logic, loops, and data transformations that are painful to express in YAML templating, even with composition functions.

### Kubernetes Resource Orchestration with KRO

In December of 2024, however, Amazon released KRO, a decoupled resource orchestrator for Kubernetes. 

While KRO does not yet have a stable release and it has only been available for a short while, the KRO project marks a rare collaboration between the cloud giants, with its recent backing from Azure and GCP, all of whom seem to have bought into its philosophy. Its simplicity seems to have really hit home, and not just with me, but with Kubernetes engineers everywhere.

This orchestrator allows users to register ResourceGraphDefinitions with the Kubernetes control plane. These RGDs are essentially factories that describe the schema of the composition, and the relationships between the resources within the composition.

A simple example (taken from the KRO docs) is the following DeploymentService definition:

```yaml
apiVersion: kro.run/v1alpha1
kind: ResourceGraphDefinition
metadata:
  name: deploymentservice
spec:
  schema:
    apiVersion: v1alpha1
    kind: DeploymentService
    spec:
      name: string
  resources:
    - id: deployment
      template:
        apiVersion: apps/v1
        kind: Deployment
        metadata:
          name: ${schema.spec.name}
        spec:
          replicas: 1
          selector:
            matchLabels:
              app: deployment
          template:
            metadata:
              labels:
                app: deployment
            spec:
              containers:
                - name: ${schema.spec.name}-deployment
                  image: nginx
                  ports:
                    - containerPort: 80
    - id: service
      template:
        apiVersion: v1
        kind: Service
        metadata:
          name: ${schema.spec.name}
        spec:
          selector:
            app: deployment
          ports:
            - protocol: TCP
              port: 80
              targetPort: 80
```
With the above RGD registered with KRO, it becomes possible to create DeploymentService instances as follows:
```yaml
apiVersion: v1alpha1
kind: DeploymentService
metadata:
  name: my-app
spec:
  name: web-app
```

Upon the successful registration of the my-app DeploymentService instance, the KRO operator will watch for changes to the placeholder fields and dynamically ensure that the service and deployment resources remain synchronized.

Yet even KRO, promising as it is, still requires engineers to write and maintain YAML configurations. Additionally, like Crossplane, it does not natively support complex control flow constructs like loops. The fundamental question remains: how can we bring the benefits of modern programming languages to Kubernetes development while preserving the declarative, GitOps-friendly workflows that make the ecosystem so powerful?

### Enter TypeKro

I’ve pondered the Kubernetes developer experience for a while now, and the problem of Kubernetes runtime dependency graph resolution. As such when I first discovered KRO I became very excited. You see, KRO represented a stateful API I could submit my resource dependency graph to, and it would take care of the continuous reconciliation of that resource graph’s dependencies. To solve Kubernetes YAML hell, I could build an expressive SDK to allow engineers to define their resource graphs as traditional software factories, using static types and typescript generics. Engineers can then use these factories to provision instances, passing statically typed input variables to these factories. The factories compile to KRO Resource Graphs, and the instances compile to KRO instance CRDs.

This is not a small undertaking, and while I’ve been mulling over this idea for a while, I never had the time to put fingers to keys and hammer out a good solution.

Until the Kiro hackathon, that is. With Kiro’s release, I found a reason to execute this vision, and a workflow that would let me build something substantial and high quality provided I did the right work up front. Let me show you what I have been doing before and after work leading to many a late night and very little sleep.

#### A Quick Intro

At a high level, TypeKro allows you to build resource graphs, create factories from these resource graphs, and use these factories to deploy instances by passing in statically typed input. Using magical proxies, TypeKro lets you access fields on other kubernetes resources that haven’t been created yet as though they already exist, providing a seamless developer experience. Behind the scenes, the library replaces these simple types with reference types that are resolved at runtime.

Resource graphs provide two factories that users can choose from if they want to deploy instances:

Users can use a kro factory, which deploys a KRO ResourceGraphDefinition during it’s instantiation. This approach is the recommended approach for deploying production workloads. In this deployment model the Kubernetes control plane is responsible for orchestrating the deployment of the Kubernetes resources that are created with this factory.

The same resource graphs are also deployable using a direct factory. This factory mode lets you deploy to kubernetes clusters where the KRO operator is not installed. It works similarly to Pulumi’s model and resolves dependencies within the javascript runtime. This mode is usable if you need to quickly test resource graphs and don’t have access to a cluster with KRO installed. It is also necessary if you want to use this framework to deploy the KRO controller itself.

#### The TypeKro Magic Proxy Experience

At the heart of TypeKro’s developer experience is what I call the magic proxy. It is this ES6 proxy that allows you to access fields which will only exist after deployment as though they are already available, enabling the declarative Kuberetes user experience like yaml with the added static type checking performed by the TypeScript compiler.

You can access properties on typescript objects and have it just work, even though the deployment object hasn't been created in a Kubernetes cluster yet. So, how does this magic work without breaking TypeScript's static type safety?

When you define a resource using a TypeKro factory, you aren't getting a plain JavaScript object back. Instead, you receive a special proxy object that wraps your resource definition. This proxy looks and feels exactly like the real resource to TypeScript and your editor, so you get all the benefits of autocomplete and type-checking.

However, when you access a property on this proxy, something special happens. For example, when your code accesses deployment.metadata.labels, the proxy intercepts this request. Instead of returning a value of type `T` (which at deployment time has not been resolved by the Kubernetes control plane yet), it generates a special reference object, a `KubernetesRef<T>`. This object is essentially a structured piece of data that says, "I am a reference to the field that Kubernetes will reesolve in the future".

This unified way of defining resource relationships makes TypeKro so expressive and versatile, because this abstract graph of references that just looks like a plain javascript object during development time can be interpreted in two different ways depending on your chosen deployment strategy.

##### For the 'kro' Factory:

When you choose to leverage the 'kro' factory type, your graph of resources and its KubernetesRef objects are serialized into a KRO ResourceGraphDefinition manifest. The TypeKro engine processes every reference, converting an object like `deployment.metadata.labels` into a Common Expression Language (CEL) string: `${deployment.metadata.labels}`. This YAML is then applied to the cluster, and the in-cluster KRO operator becomes responsible for resolving these expressions at runtime and reconciling the resources.

You can optionally elect to wait for Kubernetes reconciliation and obtain the Kubernetes values in response to a simple javascript Promise when it becomes available.

##### For the 'direct' Factory:

When you use the 'direct' factory for local development, that same graph is interpreted differently. Instead of generating CEL expressions to be processed in the cluster, the `DirectDeploymentEngine` uses a `DependencyResolver` to inspect the very same KubernetesRef objects. It generates a directed acyclic graph using these reference objects, and deployes them to the cluster, waiting for the unresolved values to be hydrated upon Kubernetes processing the resources. 

This graph is then topologically sorted to produce a step-by-step deployment plan, ensuring the independent resources are processed before dependent resources.

#### An Example to Showcase the Developer Experience

“Show me the code!” I hear you demand. Well, okay then:

First, we define our component's interface using ArkType schemas. This provides both compile-time TypeScript validation and runtime schema validation:

```typescript
import { toResourceGraph, simpleDeployment, simpleService, type, Cel } from 'typekro';

const webServiceSpec = type({
  name: 'string',
  image: 'string',
  port: 'number',
  replicas: 'number | 1', // defaults to 1
});

const webServiceStatus = type({
  url: 'string',
  readyReplicas: 'number',
  phase: '"pending" | "running" | "failed"',
});
```

Next, we create the resource graph using TypeKro's three-parameter API. The first describes the resource graph and its input and output types:

```typescript
const WebService = toResourceGraph(
  {
    name: 'WebService',
    apiVersion: 'example.com/v1alpha1',
    kind: 'WebService',
    spec: webServiceSpec,
    status: webServiceStatus,
  },
  // ResourceBuilder: Define the underlying Kubernetes resources
  (schema) => {
    const deployment = simpleDeployment({
      name: schema.spec.name,
      image: schema.spec.image,
      replicas: schema.spec.replicas,
      ports: [{ containerPort: schema.spec.port }],
    });

    const service = simpleService({
      name: schema.spec.name,
      selector: { app: schema.spec.name },
      ports: [{ port: 80, targetPort: schema.spec.port }],
    });

    return { deployment, service };
  },
  // StatusBuilder: Map resource status to component status using CEL expressions
  (schema, resources) => ({
    url: Cel.template('http://%s', schema.spec.name),
    readyReplicas: resources.deployment?.status.readyReplicas || 0,
    phase: Cel.expr<'pending' | 'running' | 'failed'>(
      resources.deployment?.status.readyReplicas, ' > 0 ? "running" : "pending"'
    ),
  })
);
```

Because TypeKro wants to provide you versatility in your workflow, the same resource graph can be deployed using completely different strategies.

**Direct Deployment** provides immediate, client-side deployment similar to tools like Pulumi:

```typescript
const directFactory = await WebService.factory('direct');
await directFactory.deploy({
  name: 'dev-app',
  image: 'nginx:latest',
  port: 80,
  replicas: 2,
});
```

**KRO Deployment** leverages the Kubernetes Resource Orchestrator for kubernetes-control plane managed dependency resolution and runtime intelligence:

```typescript
const kroFactory = await WebService.factory('kro');
await kroFactory.deploy({
  name: 'prod-app',
  image: 'nginx:1.21',
  port: 80,
  replicas: 3,
});
```

**YAML Generation** produces deterministic output yaml that can be used in GitOps workflows:

```typescript
const yaml = kroFactory.toYaml();
console.log('Generated ResourceGraphDefinition:', yaml);
```

### How TypeKro works: RefOrValue Type Architecture

The entire TypeKro architecture rests on this type union:

```typescript
type RefOrValue<T> = T | KubernetesRef<T> | CelExpression<T>
```

The `RefOrValue<T>` type union is the foundational contract that enables every composition function in TypeKro to work seamlessly with static values, schema references, and complex expressions without the developer needing to think about the distinction.

Every parameter in every TypeKro factory function accepts `RefOrValue<T>`. Whether you're passing a static string like `"my-app"`, a schema reference like `schema.spec.name`, or a CEL expression like `Cel.template("prefix-%s", schema.spec.name)`, the composition function handles it transparently.

We tell the compiler to view any `RefOrValue<T>` as its base type `T`, so that the static type system sees the natural types developers expect (`string`, `number`, etc.), while the runtime system can handle the complexity of reference resolution and expression evaluation. This enables the seamless developer experience while preserving the power of declarative resource orchestration.

The implications of this design become apparent when you consider how it enables TypeKro's versatility. The same function call that accepts `schema.spec.name` generates a CEL expression `${schema.spec.name}` for KRO deployment but resolves as an actual string value for direct deployment without changing user code.

### The `$` Prefix: Known vs Unknown Value Resolution

TypeKro's design philosophy is straightforward: known values should resolve statically, unknown values should resolve to references.

**Known values** resolve statically because TypeKro can determine them at execution time:

```typescript
const deployment = simpleDeployment({
  name: 'my-app',           // Known: literal string
  replicas: 3,              // Known: literal number
  image: 'nginx:latest'     // Known: literal string
});
```

**Unknown values** become references because they won't exist until runtime:

```typescript
const deployment = simpleDeployment({
  name: schema.spec.name,   // Unknown: becomes KubernetesRef<string>
  replicas: schema.spec.replicas,  // Unknown: becomes KubernetesRef<number>
});

// Status fields are always unknown - they don't exist until after deployment
const statusUrl = deployment.status.loadBalancer.ingress[0].ip; // Unknown: becomes KubernetesRef<string>
```

Notice how schema and status references don't require optional chaining (`?.`) - TypeKro's enhanced type system treats these as non-optional within the builders since they're guaranteed to be references that will resolve at runtime.

This works perfectly for schema references and status fields - they're clearly unknown values that must become references.

**The challenge** arises when you want to reference a field on a resource you just defined:

```typescript
const configMap = simpleConfigMap({
  data: { apiUrl: 'https://api.example.com' }
});

const deployment = simpleDeployment({
  env: {
    API_URL: configMap.data.apiUrl,     // Known: 'https://api.example.com'
    API_URL: configMap.data.$apiUrl,    // Unknown: whatever's in the cluster
  }
});
```

The `$` prefix is how you explicitly opt out of static resolution for values that TypeKro could otherwise resolve immediately. It forces "unknown" semantics on values that would otherwise be treated as "known."

### Deployment Strategy Architecture

When I first started building TypeKro, I just built the KRO deployment mode. KRO was the whole point.

But there was an obvious chicken-and-egg problem: how do you deploy KRO itself with a tool that requires KRO to be installed? So I built direct deployment mode to bootstrap KRO clusters.

Once I had direct deployment working, I kept finding other legitimate use cases. Teams that wanted GitOps workflows. Local development where spinning up KRO was overkill. Testing scenarios where I needed immediate feedback. Teams that wanted to mix TypeKro resources with existing YAML files using `yamlFile()` and `yamlDirectory()` factories. Teams that needed Helm chart integration with `helmRelease()` factories to consume third-party applications.

The bootstrap composition became particularly useful: you can deploy a complete runtime environment with Flux CD and KRO using direct mode, then switch to KRO mode for your application workloads, and use helm factories to consume entire third-party ecosystems like monitoring stacks or databases alongside your custom resources.

So now the same resource graph works across deployment modes - direct for bootstrapping and development, KRO for production orchestration, YAML generation for GitOps workflows. Each mode optimized for its use case instead of forcing everyone into the same pattern.

#### CRD Bootstrap Timing Intelligence

One pain point I kept hitting was CRD timing errors. You deploy a custom resource and get "CRD not found" because the CustomResourceDefinition hasn't been established yet. Most tools make you manually sequence CRD deployment or add retry logic.

I built automatic CRD establishment detection into the direct deployment engine. When TypeKro encounters a custom resource, it checks if it's a built-in Kubernetes resource. If not, it finds the corresponding CRD and waits for `Established: True` before deploying the instance.

This happens transparently. Your deployments work without "CRD not found" errors, even when deploying CRDs and their instances in the same resource graph.

### Raw Kubernetes Client Integration

TypeKro uses raw `@kubernetes/client-node` types to ensure full compatibility with the Kubernetes ecosystem. No custom abstractions or simplified wrappers that break integration with existing tooling.

But raw Kubernetes types are verbose and complex. So TypeKro wraps them in simple factory functions like `simpleDeployment()` and `simpleService()` that expose the most common configuration patterns while preserving access to the full API surface underneath.

This approach gives you both accessibility for common use cases and full power when you need it, without sacrificing compatibility with kubectl, client-go, or other Kubernetes tools.

### Status Builder Architecture and Resource Hydration

Status builders exist to enable resource hydration. They define how your component's status gets populated from the actual state of underlying Kubernetes resources.

When you create a resource graph, the status builder maps resource status fields to your component's status schema:

```typescript
// StatusBuilder maps from resource status to component status
(schema, resources) => ({
  readyReplicas: resources.deployment.status.readyReplicas,
  ready: Cel.expr<boolean>(resources.deployment.status.readyReplicas, ' > 0'),
  url: Cel.template('https://%s/api', schema.spec.hostname),
})
```

Status builders can only use patterns that serialize to Common Expression Language (CEL). This constraint enables hydration from values evaluated by the kro controller.

**Supported patterns:**
```typescript
// Direct field references
readyReplicas: resources.deployment.status.readyReplicas,

// CEL expressions for logic
ready: Cel.expr<boolean>(resources.deployment.status.readyReplicas, ' > 0'),

// CEL templates for string construction  
url: Cel.template('https://%s/api', schema.spec.hostname),
```

**Unsupported patterns:**
```typescript
// JavaScript fallbacks don't serialize to CEL
readyReplicas: resources.deployment.status.readyReplicas || 0,
url: `https://${schema.spec.hostname}/api`,
```

Status builders must work in both deployment modes. In KRO mode, they serialize to CEL expressions that the cluster evaluates. In direct mode, the same status mappings get hydrated by polling resource status and evaluating the expressions in the JavaScript runtime.

The hydration system uses readiness evaluators for different resource types. Deployments wait for `readyReplicas` to match `spec.replicas`. Jobs wait for completion conditions. HelmReleases check for `Ready` phase status. Each evaluator knows how to determine when its resource type is actually ready, not just created.

Once resources reach readiness, TypeKro extracts their status fields and evaluates your status builder mappings. The CEL constraint ensures your status logic works identically whether evaluated in-cluster by KRO or client-side during direct deployment.

#### State Management in TypeKro

TypeKro is not responsible for state management. But not being responsible for state management does not equate to not supporting state management. I wanted TypeKro to seamlessly work with any infrastructure-as-code tool that you already use and so it is extensible. 

I have been really enjoying Sam Goodwin's alchemy lightweight infrastructure-as-code library for TypeScript, a new lightweight Infrastructure-as-Code library for TypeScript that focuses on simplicity and a direct-to-API approach. 

I built an integration so I could manage kubernetes resources as part of my alchemy stacks. When you pass an alchemy Scope into your kro factory constructor options, it will register your KRO resource graph definition and instances as alchemy resources within the provided scope. 

If you pass an alchemy Scope to your direct factory options, each kubernetes resource created with your factory will be individually registered with that alchemy scope.

Passing an alchemyScope as an input will also allow you to consume fields on other alchemy resources in your scope and enable other alchemy resources to depend upon the properties of the Kubernetes resources you are deploying.

### So long and thanks for all the fish

This has been a long ride through the technical architecture of TypeKro, so congratulations if you made it this far.

If you're someone who likes Kubernetes but dislikes YAML, I do think TypeKro provides a differentiated experience that you
won't get anywhere else. But this is just the beginning.

The real challenge lies ahead: extending TypeKro to handle the complex dependency workflows that current tooling struggles
with. Crossplane resources with their intricate composition dependencies. Cloud controllers that need to coordinate AWS,
Azure, and GCP resources with Kubernetes workloads. Multi-cluster deployments where resources span infrastructure boundaries.

These scenarios break most existing tools because they require dependency graphs that cross platform boundaries, runtime
state coordination between different control planes, and orchestration patterns that go beyond simple resource creation. The type system and deployment architecture we've built positions TypeKro to tackle these problems.

The Kubernetes ecosystem is vast, and it has a large surface area. While I've spent time covering support for many commonly
used Kubernetes tools, I cannot cover the whole surface area of the ecosystem myself. I'm releasing TypeKro as an Apache 2.0 licensed open-source project, so I hope you'll come build with me.

The future of infrastructure orchestration isn't just about replacing YAML with TypeScript. It's about building systems that can handle the complexity of modern multi-cloud, multi-cluster deployments while preserving the developer experience that
makes you productive. That's the challenge I'm excited to tackle next.

Please give it a try and share your thoughts!