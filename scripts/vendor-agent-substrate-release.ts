/**
 * Renders the pinned Agent Substrate v1.0.0 installation bundle from upstream and writes
 * `src/factories/agent-substrate/releases/v1.0.0.ts` and the Kubernetes schema fixture
 * `test/fixtures/agent-substrate/kubernetes-v1.36.1-openapi.json`.
 *
 * Usage:
 *   bun run scripts/vendor-agent-substrate-release.ts           # write both files
 *   bun run scripts/vendor-agent-substrate-release.ts --check   # re-render and compare
 *
 * Everything is fetched by immutable identity and checked before use:
 * - the release tag must name commit SOURCE_COMMIT (GitHub API);
 * - each manifest is read from raw.githubusercontent.com at SOURCE_COMMIT, and its git blob id is
 *   recorded so it can be compared with `git ls-tree SOURCE_COMMIT`;
 * - each image is the index the release tag names on ghcr.io, and every platform image in it must
 *   carry `org.opencontainers.image.revision` = SOURCE_COMMIT and
 *   `org.opencontainers.image.version` = VERSION;
 * - the built-in Kubernetes scopes and schemas come from the OpenAPI v3 files of
 *   kubernetes/kubernetes at KUBERNETES_VERSION.
 *
 * YAML is parsed as data with js-yaml's JSON schema; nothing in it is evaluated. The render applies
 * exactly what `ate-setup deploy ate-system` (cmd/ate-setup at SOURCE_COMMIT) applies for a
 * canonical `ate-system` install from published images with no preview gates, the Envoy
 * dataplane, the default footprint and egress credential injection off:
 * 1. `ko://go.ate.dev/substrate/cmd/<image>` and `${ENVOY_DATAPLANE_IMAGE}` become the release
 *    image pinned by digest (images.Prebuilt.Pin).
 * 2. Every substrate container gets `--preview=` (steps.injectPreviewArg).
 * 3. ate-idp-server gets `--issuer=https://idp.ate-system.svc` (steps.setIDPServerIssuer with
 *    installdefaults.ActorJWTIssuer).
 * 4. The `#ATE_EGRESS_INJECT_FLAGS` marker is a YAML comment, so parsing removes it
 *    (steps.patchAtenetEgressInject with no providers).
 * 5. ate-controller.yaml's unlabeled `Namespace/ate-system` is dropped in favour of
 *    ate-system-namespace.yaml, which ate-setup applies first (steps.EnsureAteSystemNamespace).
 * Files ate-setup renders from runtime state (CA pools, JWT pools, the API server's ConfigMaps
 * and env Secrets) are not in the bundle; see src/factories/agent-substrate/README.md.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { JSON_SCHEMA, loadAll } from 'js-yaml';

import {
  type AgentSubstrateManifest,
  type AgentSubstrateRelease,
  type AgentSubstrateReleaseDocument,
  agentSubstrateReleaseSha256,
} from '../src/factories/agent-substrate/release.js';

const VERSION = 'v1.0.0';
const SOURCE_COMMIT = 'b34fbee742906494b5eb4f1f36987176bf8770a4';
const REPOSITORY = 'agent-substrate/substrate';
const IMAGE_REPOSITORY = 'agent-substrate/substrate';
const KUBERNETES_VERSION = 'v1.36.1';

/** Applied in this order, as ate-setup applies them. */
const SOURCE_FILES = [
  'manifests/ate-install/ate-system-namespace.yaml',
  'manifests/ate-install/generated/ate.dev_csidriverconfigs.yaml',
  'manifests/ate-install/generated/ate.dev_sandboxconfigs.yaml',
  'manifests/ate-install/generated/ate.dev_workerpools.yaml',
  'manifests/ate-install/generated/role.yaml',
  'manifests/ate-install/sandboxconfig-validation.yaml',
  'manifests/ate-install/sandboxconfig-gvisor.yaml',
  'manifests/ate-install/pod-certificate-controller.yaml',
  'manifests/ate-install/ate-otel-config.yaml',
  'manifests/ate-install/ate-api-server.yaml',
  'manifests/ate-install/ate-idp-server.yaml',
  'manifests/ate-install/ate-controller.yaml',
  'manifests/ate-install/atelet.yaml',
  'manifests/ate-install/atenet-router.yaml',
  'manifests/ate-install/ate-system-networkpolicies.yaml',
  'manifests/ate-install/atenet-egress.yaml',
] as const;

/** images.ReleaseComponents plus the Dockerfile image envoy-dataplane, at SOURCE_COMMIT. */
const RELEASE_IMAGES = [
  'ate-idp-server',
  'ateapi',
  'atecontroller',
  'atelet',
  'atenet',
  'ateworker-gvisor',
  'ateworker-microvm',
  'envoy-dataplane',
  'kubernetes-secrets',
  'objectstore-plugin',
  'podcertcontroller',
] as const;

const OPENAPI_GROUPS = [
  'api__v1',
  'apis__admissionregistration.k8s.io__v1',
  'apis__apiextensions.k8s.io__v1',
  'apis__apps__v1',
  'apis__networking.k8s.io__v1',
  'apis__policy__v1',
  'apis__rbac.authorization.k8s.io__v1',
] as const;

const KO_PREFIX = 'ko://go.ate.dev/substrate/cmd/';
// biome-ignore lint/suspicious/noTemplateCurlyInString: the upstream manifests' literal placeholder.
const ENVOY_PLACEHOLDER = '${ENVOY_DATAPLANE_IMAGE}';
const IDP_ISSUER = 'https://idp.ate-system.svc';

const root = join(import.meta.dir, '..');
const releaseOut = join(root, 'src', 'factories', 'agent-substrate', 'releases', `${VERSION}.ts`);
const fixtureOut = join(
  root,
  'test',
  'fixtures',
  'agent-substrate',
  `kubernetes-${KUBERNETES_VERSION}-openapi.json`
);

async function fetchOk(url: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response;
}

async function verifyTag(): Promise<void> {
  const ref = (await (
    await fetchOk(`https://api.github.com/repos/${REPOSITORY}/git/ref/tags/${VERSION}`)
  ).json()) as { object: { type: string; sha: string } };
  let commit = ref.object.sha;
  if (ref.object.type === 'tag') {
    const tag = (await (
      await fetchOk(`https://api.github.com/repos/${REPOSITORY}/git/tags/${ref.object.sha}`)
    ).json()) as { object: { sha: string } };
    commit = tag.object.sha;
  }
  if (commit !== SOURCE_COMMIT) {
    throw new Error(`${REPOSITORY} ${VERSION} names ${commit}, not ${SOURCE_COMMIT}.`);
  }
}

function gitBlob(bytes: Uint8Array): string {
  return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
}

async function readSource(path: string): Promise<{ gitBlob: string; text: string }> {
  const bytes = new Uint8Array(
    await (
      await fetchOk(`https://raw.githubusercontent.com/${REPOSITORY}/${SOURCE_COMMIT}/${path}`)
    ).arrayBuffer()
  );
  return { gitBlob: gitBlob(bytes), text: new TextDecoder().decode(bytes) };
}

const INDEX_TYPES = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
].join(', ');
const MANIFEST_TYPES = [
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

/** The digest the release tag names, after checking every platform image's source labels. */
async function releaseImageDigest(image: string): Promise<string> {
  const repository = `${IMAGE_REPOSITORY}/${image}`;
  const { token } = (await (
    await fetchOk(`https://ghcr.io/token?scope=repository:${repository}:pull`)
  ).json()) as { token: string };
  const registry = `https://ghcr.io/v2/${repository}`;
  const get = (path: string, accept?: string) =>
    fetchOk(`${registry}/${path}`, {
      headers: { authorization: `Bearer ${token}`, ...(accept ? { accept } : {}) },
    });
  const indexBytes = new Uint8Array(
    await (await get(`manifests/${VERSION}`, INDEX_TYPES)).arrayBuffer()
  );
  const digest = `sha256:${createHash('sha256').update(indexBytes).digest('hex')}`;
  const index = JSON.parse(new TextDecoder().decode(indexBytes)) as {
    manifests?: { digest: string; platform?: { os?: string; architecture?: string } }[];
  };
  const platforms = (index.manifests ?? []).filter(
    (entry) => entry.platform?.os && entry.platform.os !== 'unknown'
  );
  if (platforms.length === 0) throw new Error(`${image}:${VERSION} is not a multi-platform index.`);
  for (const platform of platforms) {
    const manifest = (await (await get(`manifests/${platform.digest}`, MANIFEST_TYPES)).json()) as {
      config: { digest: string };
    };
    const config = (await (await get(`blobs/${manifest.config.digest}`)).json()) as {
      config?: { Labels?: Record<string, string> };
    };
    const labels = config.config?.Labels ?? {};
    if (
      labels['org.opencontainers.image.revision'] !== SOURCE_COMMIT ||
      labels['org.opencontainers.image.version'] !== VERSION
    ) {
      throw new Error(
        `${image}@${platform.digest} (${platform.platform?.architecture}) was built from ${labels['org.opencontainers.image.revision']} ${labels['org.opencontainers.image.version']}, not ${SOURCE_COMMIT} ${VERSION}.`
      );
    }
  }
  return digest;
}

type Json = Record<string, unknown>;
interface Container {
  name: string;
  image?: string;
  args?: string[];
}

function containersOf(manifest: Json): Container[] {
  const pod = (manifest.spec as { template?: { spec?: Json } } | undefined)?.template?.spec;
  return [
    ...((pod?.containers as Container[] | undefined) ?? []),
    ...((pod?.initContainers as Container[] | undefined) ?? []),
  ];
}

function render(manifest: Json, images: Readonly<Record<string, string>>): Json {
  for (const container of containersOf(manifest)) {
    const image = container.image ?? '';
    const substrate = image.startsWith(KO_PREFIX);
    if (substrate) {
      const name = image.slice(KO_PREFIX.length).split('/').pop() ?? '';
      const pinned = images[name];
      if (!pinned) throw new Error(`${image} is not a release image.`);
      container.image = pinned;
    } else if (image === ENVOY_PLACEHOLDER) {
      container.image = images['envoy-dataplane'];
    }
    const metadata = manifest.metadata as { name: string };
    if (manifest.kind === 'Deployment' && metadata.name === 'ate-idp-server') {
      if (container.name === 'ate-idp-server') {
        container.args = [
          ...(container.args ?? []).filter((arg) => !arg.startsWith('--issuer=')),
          `--issuer=${IDP_ISSUER}`,
        ];
      }
    }
    if (substrate) {
      container.args = [
        ...(container.args ?? []).filter((arg) => !arg.startsWith('--preview=')),
        '--preview=',
      ];
    }
  }
  return manifest;
}

interface OpenApiFile {
  paths: Record<string, Record<string, { 'x-kubernetes-group-version-kind'?: Gvk }>>;
  components: { schemas: Record<string, Json> };
}
interface Gvk {
  group: string;
  version: string;
  kind: string;
}

function apiVersionOf({ group, version }: Gvk): string {
  return group ? `${group}/${version}` : version;
}

async function kubernetesOpenApi(): Promise<{
  sources: Record<string, string>;
  scopes: Record<string, 'Cluster' | 'Namespaced'>;
  roots: Record<string, string>;
  schemas: Record<string, Json>;
}> {
  const sources: Record<string, string> = {};
  const scopes: Record<string, 'Cluster' | 'Namespaced'> = {};
  const roots: Record<string, string> = {};
  const schemas: Record<string, Json> = {};
  for (const group of OPENAPI_GROUPS) {
    const path = `api/openapi-spec/v3/${group}_openapi.json`;
    const bytes = new Uint8Array(
      await (
        await fetchOk(
          `https://raw.githubusercontent.com/kubernetes/kubernetes/${KUBERNETES_VERSION}/${path}`
        )
      ).arrayBuffer()
    );
    sources[path] = gitBlob(bytes);
    const file = JSON.parse(new TextDecoder().decode(bytes)) as OpenApiFile;
    // A kind is namespaced when it is created under /namespaces/{namespace}/.
    for (const [route, operations] of Object.entries(file.paths)) {
      const gvk = operations.post?.['x-kubernetes-group-version-kind'];
      if (!gvk) continue;
      scopes[`${apiVersionOf(gvk)}/${gvk.kind}`] = route.includes('/namespaces/{namespace}/')
        ? 'Namespaced'
        : 'Cluster';
    }
    for (const [name, schema] of Object.entries(file.components.schemas)) {
      schemas[name] ??= schema;
      for (const gvk of (schema['x-kubernetes-group-version-kind'] as Gvk[] | undefined) ?? []) {
        roots[`${apiVersionOf(gvk)}/${gvk.kind}`] ??= name;
      }
    }
  }
  return { sources, scopes, roots, schemas };
}

/** The schemas reachable from `start`, without their `description` annotations. */
function reachableSchemas(all: Record<string, Json>, start: string[]): Record<string, Json> {
  const out: Record<string, Json> = {};
  const schemaMaps = new Set(['properties', 'patternProperties']);
  const schemaValues = new Set(['items', 'additionalProperties', 'not']);
  const schemaLists = new Set(['allOf', 'anyOf', 'oneOf']);
  const strip = (schema: Json): Json => {
    const copy: Json = {};
    for (const [key, child] of Object.entries(schema)) {
      if (key === 'description') continue;
      if (key === '$ref' && typeof child === 'string') visit(child.split('/').pop() ?? '');
      if (schemaMaps.has(key) && child && typeof child === 'object') {
        copy[key] = Object.fromEntries(
          Object.entries(child as Record<string, Json>).map(([name, value]) => [name, strip(value)])
        );
      } else if (schemaValues.has(key) && child && typeof child === 'object') {
        copy[key] = strip(child as Json);
      } else if (schemaLists.has(key) && Array.isArray(child)) {
        copy[key] = child.map((value) => strip(value as Json));
      } else {
        copy[key] = child;
      }
    }
    return copy;
  };
  const visit = (name: string) => {
    if (name in out) return;
    const schema = all[name];
    if (!schema) throw new Error(`No Kubernetes schema ${name}.`);
    out[name] = {};
    out[name] = strip(schema);
  };
  for (const name of start) visit(name);
  return Object.fromEntries(
    Object.entries(out).sort(([left], [right]) => left.localeCompare(right))
  );
}

async function build(): Promise<{ release: AgentSubstrateRelease; fixture: Json }> {
  await verifyTag();
  const images: Record<string, string> = {};
  for (const image of RELEASE_IMAGES) {
    images[image] =
      `ghcr.io/${IMAGE_REPOSITORY}/${image}:${VERSION}@${await releaseImageDigest(image)}`;
  }
  const openApi = await kubernetesOpenApi();

  const sourceFiles: { path: string; gitBlob: string }[] = [];
  const parsed: { source: string; manifest: Json }[] = [];
  for (const path of SOURCE_FILES) {
    const { gitBlob: blob, text } = await readSource(path);
    sourceFiles.push({ path, gitBlob: blob });
    for (const document of loadAll(text, undefined, { schema: JSON_SCHEMA })) {
      if (document === null || document === undefined) continue;
      const manifest = document as Json;
      const metadata = manifest.metadata as { name: string };
      if (
        path.endsWith('/ate-controller.yaml') &&
        manifest.kind === 'Namespace' &&
        metadata.name === 'ate-system'
      ) {
        continue;
      }
      parsed.push({ source: path, manifest: render(manifest, images) });
    }
  }

  const crdScopes = new Map<string, 'Cluster' | 'Namespaced'>();
  for (const { manifest } of parsed) {
    if (manifest.kind !== 'CustomResourceDefinition') continue;
    const spec = manifest.spec as {
      group: string;
      scope: 'Cluster' | 'Namespaced';
      names: { kind: string };
      versions: { name: string }[];
    };
    for (const version of spec.versions) {
      crdScopes.set(`${spec.group}/${version.name}/${spec.names.kind}`, spec.scope);
    }
  }

  const seen = new Set<string>();
  const documents: AgentSubstrateReleaseDocument[] = parsed.map(({ source, manifest }) => {
    const key = `${manifest.apiVersion}/${manifest.kind}`;
    const scope = crdScopes.get(key) ?? openApi.scopes[key];
    if (!scope)
      throw new Error(
        `${key} is neither a bundle CRD nor a Kubernetes ${KUBERNETES_VERSION} kind.`
      );
    const metadata = manifest.metadata as { name: string; namespace?: string };
    if ((scope === 'Cluster') !== (metadata.namespace === undefined)) {
      throw new Error(
        `${key} ${metadata.name} in ${source} has the wrong namespace for ${scope} scope.`
      );
    }
    const identity = `${key}/${metadata.namespace ?? ''}/${metadata.name}`;
    if (seen.has(identity)) throw new Error(`${identity} appears twice.`);
    seen.add(identity);
    return { source, scope, manifest: manifest as unknown as AgentSubstrateManifest };
  });

  const usedKinds = [
    ...new Set(documents.map(({ manifest }) => `${manifest.apiVersion}/${manifest.kind}`)),
  ]
    .filter((key) => !crdScopes.has(key))
    .sort();
  const fixture: Json = {
    kubernetesVersion: KUBERNETES_VERSION,
    sources: openApi.sources,
    scopes: Object.fromEntries(usedKinds.map((key) => [key, openApi.scopes[key]])),
    roots: Object.fromEntries(usedKinds.map((key) => [key, openApi.roots[key]])),
    schemas: reachableSchemas(
      openApi.schemas,
      usedKinds.map((key) => {
        const name = openApi.roots[key];
        if (!name) throw new Error(`No Kubernetes schema for ${key}.`);
        return name;
      })
    ),
  };
  return {
    release: {
      version: VERSION,
      sourceCommit: SOURCE_COMMIT,
      kubernetesVersion: KUBERNETES_VERSION,
      sourceFiles,
      images,
      documents,
    },
    fixture,
  };
}

const { release, fixture } = await build();
const sha256 = agentSubstrateReleaseSha256(release);

if (process.argv.includes('--check')) {
  const vendored = (await import(releaseOut)).agentSubstrateV1_0_0 as AgentSubstrateRelease;
  const vendoredFixture = JSON.parse(await Bun.file(fixtureOut).text());
  const releaseMatches = isDeepStrictEqual(JSON.parse(JSON.stringify(vendored)), release);
  const fixtureMatches = isDeepStrictEqual(vendoredFixture, fixture);
  console.log(
    `Upstream render sha256 ${sha256}; vendored ${agentSubstrateReleaseSha256(vendored)}.`
  );
  if (!releaseMatches || !fixtureMatches) {
    console.error(
      `${releaseMatches ? '' : `${releaseOut} differs from upstream. `}${fixtureMatches ? '' : `${fixtureOut} differs from upstream.`}`
    );
    process.exit(1);
  }
  console.log('The vendored bundle and schema fixture match upstream.');
} else {
  const source = `/**
 * Agent Substrate ${VERSION} installation bundle, rendered from
 * https://github.com/${REPOSITORY}/tree/${SOURCE_COMMIT}
 * (canonical sha256 ${sha256}).
 *
 * Generated by scripts/vendor-agent-substrate-release.ts. Do not edit by hand.
 */
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: upstream CRD descriptions quote \${...} literally.
import type { AgentSubstrateRelease } from '../release.js';

export const agentSubstrateV1_0_0: AgentSubstrateRelease = ${JSON.stringify(release, null, 2)};
`;
  mkdirSync(dirname(releaseOut), { recursive: true });
  writeFileSync(releaseOut, source);
  mkdirSync(dirname(fixtureOut), { recursive: true });
  writeFileSync(fixtureOut, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(
    `Wrote ${release.documents.length} objects (sha256 ${sha256}) and ${Object.keys(fixture.schemas as Json).length} Kubernetes schemas.`
  );
}
