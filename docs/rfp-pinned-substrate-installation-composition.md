# RFP: Pinned Agent Substrate installation composition

Status: installation composition candidate. Runtime and cluster qualification are separate.

TypeKro composes a pinned Kubernetes installation of Agent Substrate v1.0.0
at commit `b34fbee742906494b5eb4f1f36987176bf8770a4`. It owns installation dependency
order and Kubernetes readiness only. The consuming application framework owns
logical actor admission, lease epochs, receipts, cancellation/finalization and
client handles; the consuming service owns destination policy/evidence. None of
these authorities is delegated to Substrate snapshots.

## Exact object boundary

`typekro/agent-substrate` installs the release bundle vendored in
`src/factories/agent-substrate/releases/v1.0.0.ts`, rendered from the tagged commit with the
release's digest-pinned images and checked against its reviewed sha256 (see the factory's
README). It is the control plane `ate-setup deploy ate-system` installs in the canonical
`ate-system` namespace: the `WorkerPool`, `SandboxConfig` and `CSIDriverConfig` CRDs, RBAC, the
SandboxConfig admission policy, the gVisor class-default SandboxConfig, the pod certificate
controller, the API, IdP and controller Deployments, the `atelet` DaemonSet, the router and egress
gateway, and the network policies. Callers add only gVisor WorkerPools and the router's ingress
SPIFFE allowlist. PostgreSQL, the snapshot store, and the CA, JWT and configuration objects
`ate-setup` generates stay with their own owners and are referenced by name. `ActorTemplate`,
`Actor` and `Worker` are `ateapi.Control` gRPC resources, not CRDs, and are never Kubernetes
manifests.

Readiness is one CEL predicate per kind, run by the resource evaluators and conjoined for the root
status: CRD conditions, current-generation rollouts with no older pods, and WorkerPools whose
classes resolved the current generation with no pending config switch. The API server's `/readyz`
probe, part of the release, passes only after PostgreSQL connects and migrations finish. The
worker verifies SandboxConfig assets when it starts; the runtime proof must exercise that step.

TypeKro follows the installation graph in reverse for uninstall. Cluster-scoped resources have an
explicit deletion scope. Upgrades and cleanup require application-owned actor drain and
finalization before changing the installation.

## Focused external registration seam

`KroResource` remains Kubernetes-only and cannot register gRPC/Redis objects.
Any future Alchemy resource is limited to immutable, pinned-proto
`Create/Get/DeleteActorTemplate` or AX `Update/Get/DeleteWorkspace`, `Gateway`
or `Model`: canonical bytes/digest, stable owner marker, exact proto identity,
observe/apply/delete idempotency, foreign-owner conflict, explicit readiness,
rollback and ownership-scoped teardown. It must not create Actors/Tasks/Workers
or become a high-churn scheduler/store. Teardown revokes protocol, egress and
Secret access; deletes only owned registration records and never shared storage,
golden snapshots or foreign actors.

## Eligibility and tests

The registration and install paths need neutral tests for foreign owner,
digest/proto mismatch, partial install, failed node/assets, drain/version skew,
rollback and scoped cleanup. No direct provider is eligible until the selected
application binding supplies one logical actor/pool/finalization frontier and its
own protocol/egress/Secret tests. Consumer milestones and combined acceptance
campaigns remain in the consuming projects and their coordination workspace.
