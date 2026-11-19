// Lowers a symbolized capture of `RivetKubernetes.StatefulSetControlPlane` into a description of
// a TypeKro composition. Everything here is data: the emitter turns it into TypeScript.
//
// What kro can hold is copied from the capture unchanged. What it cannot hold is lowered by an
// explicit rule, and each rule is recorded in `lowerings` so the output says what it replaced:
// - `Alchemy.Random` (the admin token) becomes a Secret created outside the RGD, because TypeKro
//   keeps credential bytes out of KRO specs; the RGD only names it.
// - `Rivet.Namespace` (an engine API call) is replaced by the engine's `default` namespace.
// - The node pool that `Rivet.Pool` would configure becomes a Kubernetes Job inside the RGD.
// - Order-only dependencies that Alchemy expressed through `uid` outputs become `dependsOn`.
import { createHash } from 'node:crypto';
import { checkGeneratedNames, DNS1035_LABEL, DNS1123_LABEL, type NameParam } from './names.ts';
import type { Finding, ParamRef, Symbolic, Template } from './symbolize.ts';

export interface SpecField {
  readonly name: string;
  readonly kind: 'string' | 'number' | 'boolean';
  /** Where the field came from: an Alchemy prop, or a lowering rule. */
  readonly origin: string;
  readonly default?: string | number | boolean;
  /** For a field interpolated into Kubernetes names: the pattern its value must match. */
  readonly pattern?: string;
  /** For a field interpolated into Kubernetes names: its maximum length. */
  readonly maxLength?: number;
}

export type Readiness = 'statefulset-replicas' | 'job-succeeded';

export interface GraphResource {
  /** TypeKro resource id. */
  readonly id: string;
  /** Alchemy logical id, or the lowering rule that produced the object. */
  readonly origin: string;
  readonly object: Symbolic;
  readonly readiness?: Readiness;
  readonly dependsOn: readonly string[];
}

export interface Lowering {
  readonly alchemy: string;
  readonly to: string;
  readonly reason: string;
}

export interface GeneratedComposition {
  readonly source: {
    readonly layer: string;
    readonly packages: Readonly<Record<string, string>>;
    readonly variant: string;
  };
  readonly graph: {
    readonly name: string;
    readonly kind: string;
    readonly apiVersion: string;
    readonly spec: readonly SpecField[];
    readonly resources: readonly GraphResource[];
    /** `nodeEndpoint` projects from the API Service so kro can populate it. */
    readonly status: { readonly nodeEndpoint: Symbolic };
  };
  readonly outsideGraph: {
    readonly name: string;
    readonly kind: string;
    readonly apiVersion: string;
    readonly spec: readonly SpecField[];
    readonly resources: readonly GraphResource[];
  };
  readonly lowerings: readonly Lowering[];
  readonly findings: readonly Finding[];
}

interface CapturedShape {
  readonly manifests: ReadonlyArray<{
    readonly logicalId: string;
    readonly manifest: Record<string, unknown>;
  }>;
  readonly randoms: ReadonlyArray<{
    readonly logicalId: string;
    readonly bytes: number;
    readonly placeholder: string;
  }>;
  readonly engineCalls: ReadonlyArray<{
    readonly logicalId: string;
    readonly resource: string;
    readonly props: Record<string, unknown>;
  }>;
  readonly output: Record<string, Symbolic>;
}

/** Alchemy logical id → TypeKro resource id. A capture with any other object fails closed. */
const RESOURCE_IDS: Readonly<Record<string, string>> = {
  RivetTokenSecret: 'adminToken',
  RivetPeerService: 'peers',
  RivetEngines: 'engines',
  RivetApiService: 'api',
};

/**
 * Image the pool-configuration Job runs, pinned to the multi-arch index digest resolved from
 * Docker Hub on 2026-11-18 (`docker buildx imagetools inspect curlimages/curl:8.11.1`).
 */
export const POOL_JOB_IMAGE =
  'curlimages/curl:8.11.1@sha256:c1fe1679c34d9784c1b0d1e5f62ac0a79fca01fb6377cdd33e90473c6f9f9a69';

/** RivetKit nodes join a pool the engine already knows, configured with `PUT /pools/:pool`. */
/** Tries before the pool Job gives up, waiting min(try, 10) seconds between tries (about 4 min). */
export const POOL_JOB_TRIES = 30;

// The engine answers /health before its storage accepts commands, so the PUT is retried with a
// bounded, growing wait. The script avoids `${`, which kro would read as a CEL expression.
const POOL_SCRIPT = [
  'try=0',
  'until curl -fsS -o /dev/null -X PUT -H "authorization: Bearer $RIVET_TOKEN"' +
    ' -H "content-type: application/json" --data \'{"drain_on_version_upgrade":true}\'' +
    ' "$RIVET_ENDPOINT/pools/$RIVET_POOL?namespace=default"; do',
  '  try=$((try + 1))',
  `  if [ "$try" -ge ${POOL_JOB_TRIES} ]; then echo "rivet pool $RIVET_POOL was not configured after $try tries" >&2; exit 1; fi`,
  '  sleep $((try < 10 ? try : 10))',
  'done',
  'echo "rivet pool $RIVET_POOL configured after $((try + 1)) tries"',
].join('\n');

/**
 * Spec fields that reach Kubernetes names, with the pattern and length each may take. `name` is
 * a Service name, so it starts with a letter. The lengths keep the longest generated name, the
 * pool Job's `<name>-pool-<pool>-<hash>`, within 63 characters; `checkGeneratedNames` proves
 * every generated name fits.
 */
export const NAME_PARAMS: Readonly<Record<string, NameParam>> = {
  name: { pattern: DNS1035_LABEL, maxLength: 32 },
  namespace: { pattern: DNS1123_LABEL, maxLength: 63 },
  pool: { pattern: DNS1123_LABEL, maxLength: 16 },
};

/** `field` with the name constraint of {@link NAME_PARAMS}, when it has one. */
function withNameConstraint(
  field: SpecField,
  params: Readonly<Record<string, NameParam>>
): SpecField {
  const param = params[field.name];
  return param === undefined
    ? field
    : { ...field, pattern: param.pattern.source, maxLength: param.maxLength };
}

export class LoweringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoweringError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function find<T>(items: readonly T[], predicate: (item: T) => boolean, what: string): T {
  const found = items.find(predicate);
  if (found === undefined) throw new LoweringError(`The capture has no ${what}.`);
  return found;
}

/** True when any string leaf equals `needle`. */
function contains(value: unknown, needle: string): boolean {
  if (value === needle) return true;
  if (Array.isArray(value)) return value.some((item) => contains(item, needle));
  if (isRecord(value)) return Object.values(value).some((item) => contains(item, needle));
  return false;
}

export function lowerControlPlane(options: {
  readonly symbolized: Symbolic;
  readonly findings: readonly Finding[];
  readonly packages: Readonly<Record<string, string>>;
  readonly specFields: readonly SpecField[];
  /** Name constraints of the spec fields. @default NAME_PARAMS */
  readonly nameParams?: Readonly<Record<string, NameParam>>;
}): GeneratedComposition {
  const nameParams = options.nameParams ?? NAME_PARAMS;
  const capture = options.symbolized as CapturedShape;
  const lowerings: Lowering[] = [];

  for (const { logicalId } of capture.manifests) {
    if (!(logicalId in RESOURCE_IDS))
      throw new LoweringError(`No lowering rule for captured object ${logicalId}.`);
  }

  const random = find(capture.randoms, () => true, 'Alchemy.Random');
  if (capture.randoms.length !== 1) throw new LoweringError('Expected exactly one Alchemy.Random.');
  const tokenSecret = find(
    capture.manifests,
    (item) => item.manifest.kind === 'Secret' && contains(item.manifest, random.placeholder),
    'Secret holding the generated token'
  );
  const tokenSecretObject = JSON.parse(JSON.stringify(tokenSecret.manifest)) as Record<
    string,
    unknown
  >;
  const stringData = tokenSecretObject.stringData as Record<string, unknown>;
  const tokenKey = Object.keys(stringData).find((key) => stringData[key] === random.placeholder);
  if (tokenKey === undefined)
    throw new LoweringError('The token Secret does not hold the token in stringData.');
  stringData[tokenKey] = { $param: 'token' } satisfies ParamRef;
  lowerings.push({
    alchemy: `Alchemy.Random ${random.logicalId} (${random.bytes} bytes) and Kubernetes.Manifest ${tokenSecret.logicalId}`,
    to: 'the Secret in the separate RivetControlPlaneAdminToken composition, outside the RGD',
    reason:
      'kro cannot generate values, and TypeKro keeps credential bytes out of KRO specs; the RGD only names the Secret',
  });

  for (const call of capture.engineCalls) {
    if (call.resource !== 'Rivet.Namespace')
      throw new LoweringError(`No lowering rule for engine call ${call.resource}.`);
    if (call.props.name !== undefined) {
      throw new LoweringError(
        'The capture names a Rivet namespace; only the default namespace is lowered so far.'
      );
    }
    lowerings.push({
      alchemy: `Rivet.Namespace ${call.logicalId} (a call to the engine API)`,
      to: "the engine's built-in default namespace",
      reason:
        "Alchemy creates a stage namespace through the API; the RGD uses 'default', which the engine provides without an API call",
    });
  }

  const engines = find(
    capture.manifests,
    (item) => item.logicalId === 'RivetEngines',
    'engine StatefulSet'
  );
  const api = find(
    capture.manifests,
    (item) => item.logicalId === 'RivetApiService',
    'API Service'
  );
  const engineSpec = (engines.manifest.spec as Record<string, unknown>).template as Record<
    string,
    unknown
  >;
  const engineContainer = (
    (engineSpec.spec as Record<string, unknown>).containers as Record<string, unknown>[]
  )[0];
  const tokenEnv = find(
    (engineContainer?.env ?? []) as Record<string, unknown>[],
    (entry) => entry.name === 'RIVET__AUTH__ADMIN_TOKEN',
    'admin-token env entry on the engine'
  );
  const metadata = api.manifest.metadata as Record<string, unknown>;
  const nodeEndpoint = capture.output.nodeEndpoint;
  if (nodeEndpoint === undefined)
    throw new LoweringError('The captured cluster has no nodeEndpoint.');

  const poolJobSpec = {
    // The script retries itself; a failed pod means it ran out of tries, so the Job fails cleanly.
    backoffLimit: 0,
    template: {
      metadata: { labels: metadata.labels },
      spec: {
        restartPolicy: 'Never',
        containers: [
          {
            name: 'configure-pool',
            image: POOL_JOB_IMAGE,
            env: [
              { name: 'RIVET_ENDPOINT', value: nodeEndpoint },
              { name: 'RIVET_POOL', value: { $param: 'pool' } satisfies ParamRef },
              { name: 'RIVET_TOKEN', valueFrom: tokenEnv.valueFrom },
            ],
            command: ['sh', '-c', POOL_SCRIPT],
          },
        ],
      },
    },
  };
  // A Job's pod template is immutable. The name carries a hash of the generated template and the
  // pool it configures, so a changed template or pool creates a new Job instead of an update.
  const templateHash = createHash('sha256')
    .update(JSON.stringify(poolJobSpec))
    .digest('hex')
    .slice(0, 8);
  const poolJob = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: {
        $template: [{ $param: 'name' }, '-pool-', { $param: 'pool' }, `-${templateHash}`],
      } satisfies Template,
      namespace: metadata.namespace,
      labels: metadata.labels,
    },
    spec: poolJobSpec,
  };
  lowerings.push({
    alchemy: 'Rivet.Pool (declared by RivetKubernetes pools, not by the control plane)',
    to: `Job "pool" running ${POOL_JOB_IMAGE}: PUT /pools/<pool>?namespace=default, retried up to ${POOL_JOB_TRIES} times`,
    reason:
      'RivetKit nodes join a pool the engine already knows; kro has no API-call node, so a Job makes the call',
  });
  lowerings.push({
    alchemy: 'Output.all(engines.uid, api.uid) ordering the engine API call',
    to: 'pool.dependsOn(engines, api)',
    reason:
      'the capturing provider sees resolved values only, so order-only edges are invisible to it and are declared by this rule',
  });

  const resources: GraphResource[] = capture.manifests
    .filter((item) => item.logicalId !== tokenSecret.logicalId)
    .map((item) => ({
      id: RESOURCE_IDS[item.logicalId] as string,
      origin: `Kubernetes.Manifest ${item.logicalId}`,
      object: item.manifest,
      ...(item.manifest.kind === 'StatefulSet'
        ? { readiness: 'statefulset-replicas' as const }
        : {}),
      dependsOn: [],
    }));
  resources.push({
    id: 'pool',
    origin: 'lowering of Rivet.Pool',
    object: poolJob,
    readiness: 'job-succeeded',
    dependsOn: ['engines', 'api'],
  });
  resources.sort((left, right) => left.id.localeCompare(right.id));

  const specFields = [
    ...options.specFields,
    { name: 'pool', kind: 'string' as const, origin: 'lowering of Rivet.Pool', default: 'default' },
  ].map((field) => withNameConstraint(field, nameParams));
  const tokenSpecFields: SpecField[] = [
    ...options.specFields.filter((field) => field.name === 'name' || field.name === 'namespace'),
    {
      name: 'token',
      kind: 'string' as const,
      origin: `lowering of Alchemy.Random ${random.logicalId}`,
    },
  ].map((field) => withNameConstraint(field, nameParams));
  const tokenResources: GraphResource[] = [
    {
      id: RESOURCE_IDS[tokenSecret.logicalId] as string,
      origin: `Kubernetes.Manifest ${tokenSecret.logicalId}`,
      object: tokenSecretObject,
      dependsOn: [],
    },
  ];
  // Fails generation if a value the spec admits could produce an invalid or overlong name.
  checkGeneratedNames([...resources, ...tokenResources], nameParams);

  return {
    source: {
      layer: 'RivetKubernetes.StatefulSetControlPlane',
      packages: options.packages,
      variant: 'expose ClusterIP, one engine, file-system object storage, default StorageClass',
    },
    graph: {
      name: 'rivet-control-plane',
      kind: 'RivetControlPlane',
      apiVersion: 'v1alpha1',
      spec: specFields,
      resources,
      status: { nodeEndpoint },
    },
    outsideGraph: {
      name: 'rivet-control-plane-admin-token',
      kind: 'RivetControlPlaneAdminToken',
      apiVersion: 'v1alpha1',
      spec: tokenSpecFields,
      resources: tokenResources,
    },
    lowerings,
    findings: options.findings,
  };
}
