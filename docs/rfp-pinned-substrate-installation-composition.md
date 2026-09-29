# RFP: Pinned Agent Substrate installation composition

Status: proposed documentation contract; no implementation, cluster action, or provider qualification.

TypeKro may compose a pinned Kubernetes installation of Agent Substrate commit
`0ab30264bcac18b312ed49222e40d7ea42a0aa6b` / tree
`69455ba85bf45a7160a38585ae899686c33c60bb`. It owns installation dependency
order and Kubernetes readiness only. The consuming application framework owns
logical actor admission, lease epochs, receipts, cancellation/finalization and
client handles; the consuming service owns destination policy/evidence. None of
these authorities is delegated to Substrate snapshots.

## Exact object boundary

The installation applies actual Kubernetes CRDs `WorkerPool` (namespaced, with
`status.replicas`, `status.readyReplicas` and selector) and cluster-scoped
`SandboxConfig` (content-addressed assets, no status subresource), plus API
server/PostgreSQL migration, controller, `atelet` DaemonSet, router/egress,
RBAC, network and snapshot-storage resources. `ActorTemplate`, `Actor` and
`Worker` are instead `ateapi.Control` gRPC proto resources: they are not CRDs
and must never be represented as Kubernetes manifests.

`customResource()` is insufficient: its always-ready evaluator proves only a
live object. This composition needs dedicated evaluators for CRD Established /
NamesAccepted; API authenticated health plus database migration; controller and
atelet rollout; WorkerPool `readyReplicas == spec.replicas` with exact
version/node selector; SandboxConfig asset integrity on eligible nodes; and
router/gateway health. Failed, draining and version-skew states are explicit
non-ready states. A pinned upgrade drains/fences workers before changing
version; rollback preserves and observes retained actor/workspace/snapshot
state, never calling a snapshot a completed remote effect.

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
