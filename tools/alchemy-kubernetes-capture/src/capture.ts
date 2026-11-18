// Runs an Alchemy program through Alchemy's own Stack, Plan and Apply engine with capturing
// providers in place of the real ones. Nothing is applied to a cluster: the capturing
// `Kubernetes.Manifest` provider records each resolved manifest, and the `Random` and
// `Rivet.Namespace` providers record what they would have generated or called.
import * as Kubernetes from '@alchemy.run/kubernetes';
import * as Rivet from '@alchemy.run/rivet';
import * as RivetKubernetes from '@alchemy.run/rivet/Kubernetes';
import { AlchemyContextLive } from 'alchemy/AlchemyContext';
import * as Apply from 'alchemy/Apply';
import { provideFreshArtifactStore } from 'alchemy/Artifacts';
import { CredentialsStoreLive } from 'alchemy/Auth/Credentials';
import { ProfileStoreLive } from 'alchemy/Auth/Profile';
import * as Interaction from 'alchemy/Interaction';
import * as Plan from 'alchemy/Plan';
import * as Provider from 'alchemy/Provider';
import { Random } from 'alchemy/Random';
import * as AlchemyStack from 'alchemy/Stack';
import { Stage } from 'alchemy/Stage';
import * as State from 'alchemy/State';
import { PlatformServices } from 'alchemy/Util/PlatformServices';
import * as Effect from 'effect/Effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as Layer from 'effect/Layer';
import * as Logger from 'effect/Logger';
import * as Redacted from 'effect/Redacted';

/** One Kubernetes object the program asked Alchemy to apply. */
export interface CapturedManifest {
  readonly logicalId: string;
  readonly manifest: Record<string, unknown>;
}

/** A value Alchemy would have generated at deploy time (an `Alchemy.Random`). */
export interface CapturedRandom {
  readonly logicalId: string;
  readonly bytes: number;
  /** The placeholder the capture returned in place of the generated text. */
  readonly placeholder: string;
}

/** An imperative call Alchemy would have made to the Rivet engine's API. */
export interface CapturedEngineCall {
  readonly logicalId: string;
  readonly resource: 'Rivet.Namespace';
  readonly props: Record<string, unknown>;
}

/** Everything one run recorded. Arrays are sorted by logical id, so runs are comparable. */
export interface Capture<Output = unknown> {
  readonly manifests: readonly CapturedManifest[];
  readonly randoms: readonly CapturedRandom[];
  readonly engineCalls: readonly CapturedEngineCall[];
  readonly output: Output;
}

/** Prefixes of placeholders standing in for values that only exist after a real apply. */
export const RANDOM_PLACEHOLDER_PREFIX = 'tkcapture-random-';
export const UID_PLACEHOLDER_PREFIX = 'tkcapture-uid-';

/** A connection that names no reachable cluster; the capturing provider never uses it. */
export const captureConnection: Kubernetes.Connection = {
  endpoint: 'https://capture.invalid',
  auth: { kind: 'kubeconfig', path: '/nonexistent/typekro-capture-kubeconfig' },
};

/** Unwrap `Redacted` values and copy into plain JSON-like data. */
export function plain(value: unknown): unknown {
  if (Redacted.isRedacted(value)) return Redacted.value(value);
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]));
  }
  return value;
}

const byLogicalId = <T extends { logicalId: string }>(items: readonly T[]): T[] =>
  [...items].sort((left, right) => left.logicalId.localeCompare(right.logicalId));

/**
 * Run `program` in an in-memory Alchemy stack with Alchemy's real Plan and Apply. Only the
 * providers are substituted, through `Alchemy.Stack`'s `providers` option.
 */
export function captureProgram<Output>(
  // The program needs the provider collections; this function supplies them.
  program: Effect.Effect<Output, unknown, unknown>
): Promise<Capture<Output>> {
  const manifests: CapturedManifest[] = [];
  const randoms: CapturedRandom[] = [];
  const engineCalls: CapturedEngineCall[] = [];

  const manifestProvider = Provider.succeed(Kubernetes.Manifest, {
    stables: ['connection', 'apiVersion', 'kind', 'name', 'namespace'],
    list: () => Effect.succeed([]),
    read: ({ output }) => Effect.succeed(output),
    reconcile: ({ id, news }) =>
      Effect.sync(() => {
        const manifest = plain(news.manifest) as Kubernetes.KubernetesManifest;
        manifests.push({ logicalId: id, manifest: manifest as Record<string, unknown> });
        const metadata = manifest.metadata ?? {};
        const ref = {
          apiVersion: manifest.apiVersion,
          kind: manifest.kind,
          name: String(metadata.name),
          namespace: metadata.namespace,
        };
        return {
          connection: captureConnection,
          apiVersion: manifest.apiVersion,
          kind: manifest.kind,
          name: String(metadata.name),
          namespace: metadata.namespace,
          ref,
          uid: `${UID_PLACEHOLDER_PREFIX}${id}`,
        } as Kubernetes.Manifest['Attributes'];
      }),
    delete: () => Effect.void,
  });

  const randomProvider = Provider.succeed(Random, {
    list: () => Effect.succeed([]),
    read: ({ output }) => Effect.succeed(output),
    reconcile: ({ id, news = {} }) =>
      Effect.sync(() => {
        const placeholder = `${RANDOM_PLACEHOLDER_PREFIX}${id}`;
        randoms.push({ logicalId: id, bytes: news.bytes ?? 32, placeholder });
        return { text: Redacted.make(placeholder) };
      }),
    delete: () => Effect.void,
  });

  const namespaceProvider = Provider.succeed(Rivet.Namespace, {
    list: () => Effect.succeed([]),
    read: ({ output }) => Effect.succeed(output),
    reconcile: ({ id, news }) =>
      Effect.sync(() => {
        const recorded = plain(news) as Record<string, unknown>;
        engineCalls.push({ logicalId: id, resource: 'Rivet.Namespace', props: recorded });
        return {
          name: String(recorded.name ?? 'default'),
          endpoint: String(recorded.endpoint),
          createdAt: 0,
        };
      }),
    delete: () => Effect.void,
  });

  const kubernetesProviders = Layer.effect(
    Kubernetes.Providers,
    Provider.collection([Kubernetes.Manifest])
  ).pipe(Layer.provide(manifestProvider));
  const rivetProviders = Layer.effect(
    Rivet.Providers,
    Provider.collection([Rivet.Namespace, Random])
  ).pipe(Layer.provide(Layer.mergeAll(namespaceProvider, randomProvider)));
  const providers = Layer.mergeAll(kubernetesProviders, rivetProviders);

  const stateLayer = Layer.succeed(State.State, State.InMemoryService({}));
  const platform = Layer.mergeAll(
    PlatformServices,
    FetchHttpClient.layer,
    Layer.provide(ProfileStoreLive, PlatformServices),
    Layer.provide(CredentialsStoreLive, PlatformServices)
  );
  const alchemy = Layer.mergeAll(Interaction.layerNonInteractive(), AlchemyContextLive);

  const run = (program as Effect.Effect<Output, unknown, never>).pipe(
    AlchemyStack.make({ name: 'tkcapture', providers, state: stateLayer } as never) as never,
    Effect.flatMap((compiled: never) =>
      Plan.make(compiled, {}).pipe(
        Effect.flatMap((plan) => Apply.apply(plan)),
        Effect.provide((compiled as { services: never }).services)
      )
    ),
    Effect.provideService(Stage, 'capture'),
    provideFreshArtifactStore,
    Effect.provide(Layer.provideMerge(alchemy, platform)),
    Effect.provide(Logger.layer([])),
    Effect.scoped
  ) as unknown as Effect.Effect<unknown, unknown, never>;

  // The program's own value holds unresolved Outputs; the applied plan holds them resolved.
  return Effect.runPromise(run).then((applied) => ({
    manifests: byLogicalId(manifests),
    randoms: byLogicalId(randoms),
    engineCalls: byLogicalId(engineCalls),
    output: plain(applied) as Output,
  }));
}

/** Props accepted by the control-plane capture: Alchemy's own props without the cluster. */
export type ControlPlaneCaptureProps = Omit<
  RivetKubernetes.StatefulSetControlPlaneProps,
  'cluster'
>;

/** The `Rivet.Cluster` service as captured, without the capture-only cluster connection. */
export interface CapturedCluster {
  readonly endpoint: string;
  readonly nodeEndpoint?: string;
  readonly clientEndpoint?: string;
  readonly namespace: string;
  readonly token: string;
}

/** Capture Alchemy's own `RivetKubernetes.StatefulSetControlPlane` layer. */
export async function captureStatefulSetControlPlane(
  props: ControlPlaneCaptureProps
): Promise<Capture<CapturedCluster>> {
  const program = Effect.gen(function* () {
    return yield* Rivet.Cluster;
  }).pipe(
    Effect.provide(
      RivetKubernetes.StatefulSetControlPlane('Rivet', {
        ...props,
        cluster: captureConnection,
      }) as unknown as Layer.Layer<Rivet.Cluster>
    )
  );
  const capture = await captureProgram(
    program as unknown as Effect.Effect<Record<string, unknown>, unknown, never>
  );
  const { endpoint, nodeEndpoint, clientEndpoint, namespace, token } = capture.output as Record<
    string,
    unknown
  >;
  return {
    ...capture,
    output: {
      endpoint: String(endpoint),
      ...(nodeEndpoint === undefined ? {} : { nodeEndpoint: String(nodeEndpoint) }),
      ...(clientEndpoint === undefined ? {} : { clientEndpoint: String(clientEndpoint) }),
      namespace: String(namespace),
      token: String(token),
    },
  };
}
