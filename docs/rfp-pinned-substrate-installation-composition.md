# RFP: Pinned Agent Substrate installation composition

Status: installation composition candidate. Runtime and cluster qualification are separate.

TypeKro composes a pinned Kubernetes installation of Agent Substrate v1.0.0
at commit `b34fbee742906494b5eb4f1f36987176bf8770a4`. It owns installation dependency
order and Kubernetes readiness only. The consuming application framework owns
logical actor admission, lease epochs, receipts, cancellation/finalization and
client handles; the consuming service owns destination policy/evidence. None of
these authorities is delegated to Substrate snapshots.

## Exact object boundary

The `typekro/agent-substrate` composition accepts the reviewed release's rendered Kubernetes bundle, with digest-pinned images, an explicit namespace, a WorkerPool, and references to the selected PostgreSQL and private snapshot store. The installation applies actual Kubernetes CRDs `WorkerPool` (namespaced, with
`status.replicas`, `status.readyReplicas` and selector) and cluster-scoped
`SandboxConfig` (content-addressed assets, no status subresource). It can include the release's `CSIDriverConfig` definition. The bundle contains the API
server/PostgreSQL migration, controller, `atelet` DaemonSet, router/egress,
RBAC, network and snapshot-storage resources. `ActorTemplate`, `Actor` and
`Worker` are instead `ateapi.Control` gRPC proto resources: they are not CRDs
and must never be represented as Kubernetes manifests.

Readiness checks both CRD conditions, matching rollout generations, WorkerPool counts and resolved sandbox configuration. The API Deployment must carry the release `/readyz` probe. That probe becomes available after PostgreSQL connects and schema migration finishes. SandboxConfig readiness checks the active version's digest pins. The worker verifies the actual assets when it starts. The runtime proof must exercise that step.

TypeKro follows the installation graph in reverse for uninstall. Cluster-scoped resources have an explicit deletion scope. The database, snapshot store and existing Secrets stay under their own lifecycle. Upgrades and cleanup require application-owned actor drain and finalization before changing the installation.

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
