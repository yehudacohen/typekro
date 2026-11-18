# typekro-alchemy-kubernetes

This package turns an Alchemy Kubernetes layer into a TypeKro composition that kro deploys as one
ResourceGraphDefinition. The first layer it supports is Alchemy's
`RivetKubernetes.StatefulSetControlPlane`, the Rivet engine. Kubernetes objects stay owned by
TypeKro and kro, and the definitions come from Alchemy's own code instead of a hand port.

It is a separate package, with its own `package.json` and `bun.lock`, because it needs
`alchemy` 2.0.0-beta.87 and `effect` 4.1.4. TypeKro itself pins `alchemy` 2.0.0-beta.74. The
generated composition imports only TypeKro, so none of these versions reach TypeKro or its users.

## How it works

1. **Capture.** `src/capture.ts` runs the layer through Alchemy's own `Stack`, `Plan` and `Apply`,
   with an in-memory state store. Capturing providers stand in for `Kubernetes.Manifest`,
   `Alchemy.Random` and `Rivet.Namespace`. They are supplied through the stack's `providers`
   option, so Alchemy is not forked. Nothing is applied and no network is used: `test:offline`
   runs everything under the macOS sandbox with outbound networking denied.
2. **Symbolize.** Providers only see resolved values, so `src/symbolize.ts` runs the capture more
   than once and compares the results:
   - String props get unique sentinel tokens. Every string that contains a token becomes a
     template over the prop.
   - Number props are probed at a base, an alternate and a third value (an edge such as 0). A
     value is bound to the prop only if it follows the prop at all three. Two points cannot tell
     `Math.max(n, 1)` from `n`.
   - Boolean props are probed at both values.
   - A change of shape (keys, list lengths) is a **branch** and is reported, never bound.
     Optional props are branches too: present versus absent.
   - A changed value that is not exactly the prop, or its string form, is reported as
     **derived**. That covers embedded values (`--port=:8080`) and arithmetic.
3. **Lower.** `src/lower.ts` copies what kro can hold and replaces the rest by explicit rules.
   Each rule is recorded in `generated/*.capture.json`:
   - `Alchemy.Random` (generated secrets) becomes a Secret applied in direct mode, outside the
     RGD. kro cannot generate values, and TypeKro keeps credential bytes out of KRO specs.
   - Calls to an engine's API (`Rivet.Namespace`, and the pool `Rivet.Pool` configures) become
     the engine's `default` namespace and a Job. The Job retries the pool PUT up to 30 times
     with growing waits, then fails cleanly. Its name carries a hash of its template, because a
     Job's template is immutable.
   - Order-only dependencies, which Alchemy expresses through `uid` outputs that providers never
     see, become `dependsOn`.
   - Readiness comes per kind (`readyWhen` for StatefulSet and Job). Status projects from
     resources, as kro requires.
   - LoadBalancer exposure is not captured. Alchemy polls the cluster directly for the address,
     outside any provider, so that variant keeps the address outside the RGD.
4. **Emit.** `src/emit.ts` writes TypeScript that uses TypeKro's typed factories (`service`,
   `statefulSet`, `job`, `secret`), formatted with TypeKro's own Biome.

## Files

- `generated/rivet-control-plane.ts`: the composition (`rivetControlPlane`, plus the
  out-of-graph `rivetControlPlaneAdminToken`). Do not edit it by hand.
- `generated/rivet-control-plane.capture.json`: the symbolized capture, its lowerings and its
  findings.
- `cluster/`: an end-to-end journey on a local cluster (`run.sh`). It deploys the RGD through kro, runs a RivetKit node and a wrong-token node as pods, deletes the instance and cleans up. Its receipts stay local (git-ignored).
- `../../test/unit/alchemy-kubernetes-capture/`: TypeKro serializes the output to a valid RGD.

## Commands

```sh
bun install                  # in this directory only
bun run generate             # capture, then rewrite generated/
bun run test                 # offline, symbolizer, pool Job script and drift tests
bun run test:offline         # the same, with the network denied by the OS sandbox
bun run typecheck
```

**Drift test.** `test/drift.test.ts` captures Alchemy again and fails if the checked-in files
differ by a byte. After an Alchemy upgrade, run `bun run generate`, review the diff, and commit.

## Adding an Alchemy layer

1. Add a `capture<Layer>` function in `src/capture.ts` that provides the layer with
   `captureConnection` as its cluster. If the layer uses a resource type with no capturing
   provider yet, add one; unknown resource types fail closed.
2. List its props as `Param`s, with a sentinel and alternate for strings and three probe values
   for numbers. Capture each branch you need as its own variant.
3. Write a lowering for anything kro cannot hold, and map each captured object to a TypeKro id.
4. Map any new kinds to TypeKro factories in `src/emit.ts`, generate, and add an RGD test.

## Limits

Each variant is captured separately (for example ClusterIP with one engine, versus S3 with
several), so props that select structure cannot vary inside one RGD. Derived values need a
lowering by hand. The capture runs one fixed layer per run. It is a generator, not an
in-process integration, until TypeKro itself depends on an Alchemy version that ships
`@alchemy.run/kubernetes`.
