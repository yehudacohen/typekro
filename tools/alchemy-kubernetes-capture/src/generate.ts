// Captures Alchemy's Rivet control-plane layer, symbolizes it, lowers it and emits TypeScript.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { captureStatefulSetControlPlane } from './capture.ts';
import { emitControlPlane } from './emit.ts';
import { type GeneratedComposition, lowerControlPlane, type SpecField } from './lower.ts';
import { type Param, symbolize } from './symbolize.ts';

/** Import specifier the emitted module uses for TypeKro, relative to `generated/`. */
export const TYPEKRO_IMPORT = '../../../src/index.js';

/** Props of `StatefulSetControlPlane` that become RGD spec fields, plus props probed for findings. */
export const CONTROL_PLANE_PARAMS: readonly Param[] = [
  { name: 'name', kind: 'string', sentinel: 'tkpqnm', alternate: 'tkpqnmalt' },
  { name: 'namespace', kind: 'string', sentinel: 'tkpqns', alternate: 'tkpqnsalt' },
  { name: 'image', kind: 'string', sentinel: 'tkpqimg', alternate: 'tkpqimgalt' },
  { name: 'diskSize', kind: 'string', sentinel: 'tkpqdisk', alternate: 'tkpqdiskalt' },
  { name: 'endpoint', kind: 'string', sentinel: 'tkpqep', alternate: 'tkpqepalt' },
  // One engine keeps data on its own volume; a second engine needs objectStorage, so Alchemy
  // refuses the alternate. The symbolizer reports it instead of binding `replicas`.
  { name: 'instances', kind: 'number', base: 1, alternate: 2, third: 0 },
];

const SPEC_FIELDS: readonly SpecField[] = [
  { name: 'name', kind: 'string', origin: 'StatefulSetControlPlaneProps.name' },
  {
    name: 'namespace',
    kind: 'string',
    origin: 'StatefulSetControlPlaneProps.namespace',
    default: 'default',
  },
  {
    name: 'image',
    kind: 'string',
    origin: 'StatefulSetControlPlaneProps.image',
    // Alchemy's DEFAULT_ENGINE_IMAGE, pinned to the multi-arch index digest resolved from
    // Docker Hub on 2026-11-18.
    default:
      'rivetdev/engine:3.0.0@sha256:5ae3c24275eeff87ad1962f4d66fcdb85786fc1397feeeb55afc2ca1f7ccf6f2',
  },
  {
    name: 'diskSize',
    kind: 'string',
    origin: 'StatefulSetControlPlaneProps.diskSize',
    default: '10Gi',
  },
];

const PACKAGES = ['alchemy', '@alchemy.run/kubernetes', '@alchemy.run/rivet', 'effect'] as const;

function installedVersions(): Record<string, string> {
  const require = createRequire(import.meta.url);
  const versions: Record<string, string> = {};
  for (const name of PACKAGES) {
    const manifest = JSON.parse(readFileSync(require.resolve(`${name}/package.json`), 'utf8')) as {
      version: string;
    };
    versions[name] = manifest.version;
  }
  return versions;
}

/** Run the real layer with the given values; this is what the symbolizer calls. */
export function captureControlPlaneValues(values: Readonly<Record<string, unknown>>) {
  return captureStatefulSetControlPlane({
    name: String(values.name),
    namespace: String(values.namespace),
    image: String(values.image),
    diskSize: String(values.diskSize),
    instances: Number(values.instances),
    expose: { type: 'ClusterIP', endpoint: String(values.endpoint) },
  });
}

const TYPEKRO_ROOT = join(import.meta.dir, '..', '..', '..');

/** Format emitted code with TypeKro's own Biome and config, so the output passes its lint. */
function formatWithTypeKroBiome(source: string, fileName: string): string {
  const result = spawnSync(
    join(TYPEKRO_ROOT, 'node_modules', '.bin', 'biome'),
    ['format', '--stdin-file-path', `tools/alchemy-kubernetes-capture/generated/${fileName}`],
    { cwd: TYPEKRO_ROOT, input: source, encoding: 'utf8' }
  );
  if (result.status !== 0) {
    throw new Error(`Biome could not format ${fileName}: ${result.stderr || result.error}`);
  }
  return result.stdout;
}

export interface Generated {
  readonly composition: GeneratedComposition;
  readonly json: string;
  readonly typescript: string;
}

export async function generateControlPlane(): Promise<Generated> {
  const { value, findings } = await symbolize(CONTROL_PLANE_PARAMS, captureControlPlaneValues);
  const composition = lowerControlPlane({
    symbolized: value,
    findings,
    packages: installedVersions(),
    specFields: SPEC_FIELDS,
  });
  return {
    composition,
    json: formatWithTypeKroBiome(JSON.stringify(composition), 'rivet-control-plane.capture.json'),
    typescript: formatWithTypeKroBiome(
      emitControlPlane(composition, TYPEKRO_IMPORT),
      'rivet-control-plane.ts'
    ),
  };
}
