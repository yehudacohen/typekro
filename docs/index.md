---
layout: home

hero:
  image: /typekro-logo.svg
  name: 'Kubernetes with TypeScript instead of YAML'
  text: ""
  tagline: "Build Kubernetes infrastructure with runtime dependencies in clean TypeScript that compiles to Kubernetes Resource Orchestrator (KRO) YAML."
  actions:
    - theme: brand
      text: Get Started
      link: "#getting-started"
    - theme: alt
      text: View Examples
      link: /examples/
    - theme: alt
      text: ⭐ Star on GitHub
      link: https://github.com/yehudacohen/typekro

features:
  - icon: 🔒
    title: Full Type Safety
    details: Catch infrastructure errors at compile time with TypeScript's powerful type system. Get IDE autocomplete for all Kubernetes resources.
  
  - icon: 🔄
    title: Runtime Dependencies
    details: Built on Kubernetes Resource Orchestrator (KRO), cross-resource references and CEL expressions evaluate at runtime, enabling dynamic infrastructure that adapts to cluster state.
  
  - icon: 📦
    title: KRO-Native YAML
    details: Compiles to KRO ResourceGraphDefinitions with deterministic YAML output. No external state backends or custom orchestration layers needed.
  
  - icon: 🚀
    title: Deployment Modes
    details: Choose direct deployment for rapid feedback, KRO mode for advanced orchestration, or YAML generation for GitOps workflows.
  
  - icon: 🔗
    title: Ecosystem Integration
    details: Seamlessly integrate with Alchemy for multi-cloud infrastructure (AWS, GCP, Azure) and GitOps workflows (ArgoCD, Flux). Unified TypeScript experience across your entire stack.
  
  - icon: ⚡
    title: Developer Experience
    details: Write infrastructure in pure TypeScript with full IDE support. Refactor safely with compile-time validation and modern tooling.
---

<div class="beta-badge">⚠️ BETA - Not for production</div>

<div id="getting-started">
<TutorialCarousel />
</div>




<div class="home-section">

## Why TypeKro?

Because nobody likes YAML and Kubernetes dependencies are hard. TypeKro provides **runtime intelligence** through Kubernetes Resource Orchestrator (KRO), enabling resources to reference each other's live cluster state with CEL expressions. Here's what you get compared to other tools:

| Feature | TypeKro | Pulumi | CDK8s | Helm | Kustomize | Crossplane |
|---------|---------|---------|--------|------|-----------|------------|
| **Type Safety** | ✅ Full TypeScript | ✅ Multi-language | ✅ TypeScript | ❌ Templates | ❌ YAML | ❌ YAML |
| **GitOps Ready** | ✅ Deterministic YAML | ❌ State backend | ✅ YAML output | ✅ Charts | ✅ YAML | ✅ YAML |
| **Runtime Dependencies** | ✅ KRO + CEL expressions | ❌ Deploy-time only | ❌ Static | ❌ Templates | ❌ Static | ✅ Compositions |
| **IDE Support** | ✅ Full autocomplete | ✅ Language support | ✅ TypeScript | ❌ Limited | ❌ Limited | ❌ Limited |
| **Learning Curve** | 🟢 Just TypeScript | 🔴 New concepts | 🟡 TypeScript + K8s | 🔴 Templates | 🔴 YAML hell | 🔴 Complex |
| **Kubernetes Native** | ✅ Pure K8s resources | ❌ Abstraction layer | ✅ Pure K8s | ✅ K8s resources | ✅ K8s resources | ✅ K8s + CRDs |
| **Cross-Resource Refs** | ✅ Runtime resolution | ❌ Deploy-time | ❌ Manual | ❌ Manual | ❌ Manual | ✅ Built-in |
| **Multi-Cloud** | 🟡 Via Alchemy | ✅ Native | ❌ K8s only | ❌ K8s only | ❌ K8s only | ✅ Native |
| **State Management** | ✅ Stateless | ❌ State backend | ✅ Stateless | ✅ Stateless | ✅ Stateless | ✅ Controller |

</div>

<div class="home-section">

## What is KRO?

**Kubernetes Resource Orchestrator (KRO)** is an open-source project by AWS Labs, with contributions from Google, Microsoft, and the broader Kubernetes community. KRO enables advanced resource orchestration with runtime dependencies and CEL expressions. TypeKro builds on KRO to provide:

- **🔄 Runtime Intelligence**: Resources can reference each other's runtime state (like IP addresses, status conditions)
- **📋 Custom Resource Types**: Define your own Kubernetes resource types with TypeScript schemas
- **🎯 CEL Expressions**: Use Google's Common Expression Language for dynamic resource configuration
- **🔧 GitOps Native**: Generates standard Kubernetes YAML that works with any GitOps workflow

TypeKro works in **Direct Mode** (no KRO required) for simple deployments, or **KRO Mode** for advanced orchestration with runtime dependencies.

**Learn more:** [KRO Documentation →](https://kro.run/)

</div>



<div class="home-section">

## Ready to Get Started?

<div style="text-align: center; margin: 24px 0;">
  <a href="/guide/getting-started" class="vp-button vp-button-brand vp-button-medium">Install TypeKro</a>
  <a href="/examples/" class="vp-button vp-button-alt vp-button-medium" style="margin-left: 16px;">View Examples</a>
</div>

</div>
