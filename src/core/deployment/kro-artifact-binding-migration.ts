import type { KubeConfig, KubernetesObject } from '@kubernetes/client-node';
import { ensureError } from '../errors.js';
import { createBunCompatibleKubernetesObjectApi } from '../kubernetes/index.js';
import { KRO_ARTIFACT_BINDINGS_SPEC_FIELD } from '../planning/values.js';

const STABLE_BINDING_SCHEMA = 'map[string]map[string]string';
const MAX_CRD_PATCH_ATTEMPTS = 5;
type MigrationApi = Pick<
  ReturnType<typeof createBunCompatibleKubernetesObjectApi>,
  'read' | 'list' | 'patch'
>;

interface ResourceGraphDefinition extends KubernetesObject {
  spec?: {
    schema?: {
      apiVersion?: string;
      group?: string;
      kind?: string;
      spec?: Record<string, unknown>;
    };
  };
  status?: {
    conditions?: Array<{
      type?: string;
      status?: string;
      observedGeneration?: number;
    }>;
  };
}

interface CustomResourceDefinition extends KubernetesObject {
  spec?: {
    group?: string;
    names?: { kind?: string };
    versions?: Array<{
      name?: string;
      schema?: {
        openAPIV3Schema?: {
          properties?: Record<string, unknown>;
        };
      };
      [key: string]: unknown;
    }>;
  };
}

function statusCode(error: unknown): number | undefined {
  const candidate = error as {
    statusCode?: number;
    code?: number;
    body?: { code?: number };
  };
  return candidate.statusCode ?? candidate.code ?? candidate.body?.code;
}

async function findGeneratedCrd(
  api: MigrationApi,
  group: string,
  kind: string
): Promise<CustomResourceDefinition | undefined> {
  const listed = (await api.list(
    'apiextensions.k8s.io/v1',
    'CustomResourceDefinition'
  )) as unknown as { items?: CustomResourceDefinition[] };
  return listed.items?.find(
    (candidate) => candidate.spec?.group === group && candidate.spec?.names?.kind === kind
  );
}

type CustomResourceDefinitionVersion = NonNullable<
  NonNullable<CustomResourceDefinition['spec']>['versions']
>[number];

function propertySchema(
  version: CustomResourceDefinitionVersion
): Record<string, unknown> | undefined {
  const root = version.schema?.openAPIV3Schema?.properties;
  const spec = root?.spec;
  if (!spec || typeof spec !== 'object') return undefined;
  const properties = Reflect.get(spec, 'properties');
  if (!properties || typeof properties !== 'object') return undefined;
  const bindings = Reflect.get(properties, KRO_ARTIFACT_BINDINGS_SPEC_FIELD);
  return bindings && typeof bindings === 'object'
    ? (bindings as Record<string, unknown>)
    : undefined;
}

function nestedStringMapSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: {
      type: 'object',
      additionalProperties: { type: 'string' },
    },
  };
}

function isNestedStringMap(schema: Record<string, unknown>): boolean {
  const outer = schema.additionalProperties;
  if (!outer || typeof outer !== 'object') return false;
  const inner = Reflect.get(outer, 'additionalProperties');
  return (
    schema.type === 'object' &&
    Reflect.get(outer, 'type') === 'object' &&
    Boolean(inner && typeof inner === 'object' && Reflect.get(inner, 'type') === 'string')
  );
}

function isLegacyArtifactBindingSchema(schema: Record<string, unknown>): boolean {
  if (schema.type !== 'object' || schema.additionalProperties !== undefined) return false;
  const requirements = schema.properties;
  if (!requirements || typeof requirements !== 'object') return false;
  return Object.values(requirements).every((requirement) => {
    if (!requirement || typeof requirement !== 'object') return false;
    if (Reflect.get(requirement, 'type') !== 'object') return false;
    const outputs = Reflect.get(requirement, 'properties');
    return (
      outputs !== undefined &&
      typeof outputs === 'object' &&
      Object.values(outputs).every(
        (output) =>
          output !== null && typeof output === 'object' && Reflect.get(output, 'type') === 'string'
      )
    );
  });
}

function needsRgdReconcileRetry(rgd: ResourceGraphDefinition): boolean {
  const generation = rgd.metadata?.generation;
  return (
    typeof generation === 'number' &&
    rgd.status?.conditions?.some(
      (condition) =>
        condition.type === 'KindReady' &&
        condition.status === 'False' &&
        condition.observedGeneration === generation
    ) === true
  );
}

async function requestRgdReconcile(api: MigrationApi, rgdName: string): Promise<void> {
  await api.patch(
    {
      apiVersion: 'kro.run/v1alpha1',
      kind: 'ResourceGraphDefinition',
      metadata: {
        name: rgdName,
        annotations: {
          'typekro.io/artifact-binding-migration-retry': new Date().toISOString(),
        },
      },
    },
    undefined,
    undefined,
    undefined,
    undefined,
    'application/merge-patch+json'
  );
}

/**
 * Broadens the generated CRD's released v0.32 artifact-binding schema before
 * KRO sees the topology-independent RGD. KRO rejects a direct fixed-object →
 * map transition as a property removal even though every existing value is
 * valid under the map. Updating the CRD first is non-destructive: it only
 * broadens validation and preserves the persisted nested key/value shape.
 */
export async function migrateLegacyKroArtifactBindingCrd(
  kubeConfig: KubeConfig,
  desiredResource: KubernetesObject,
  dependencies: { readonly api?: MigrationApi } = {}
): Promise<void> {
  const desiredRgd = desiredResource as ResourceGraphDefinition;
  if (desiredRgd.spec?.schema?.spec?.[KRO_ARTIFACT_BINDINGS_SPEC_FIELD] !== STABLE_BINDING_SCHEMA) {
    return;
  }
  const rgdName = desiredRgd.metadata?.name;
  const apiVersion = desiredRgd.spec.schema.apiVersion;
  const kind = desiredRgd.spec.schema.kind;
  if (!rgdName || !apiVersion || !kind) return;

  const api = dependencies.api ?? createBunCompatibleKubernetesObjectApi(kubeConfig);
  let liveRgd: ResourceGraphDefinition;
  try {
    liveRgd = (await api.read({
      apiVersion: 'kro.run/v1alpha1',
      kind: 'ResourceGraphDefinition',
      metadata: { name: rgdName },
    })) as ResourceGraphDefinition;
  } catch (error: unknown) {
    if (statusCode(error) === 404) return;
    throw new Error(
      `Could not inspect ResourceGraphDefinition ${rgdName} before artifact-binding migration: ${ensureError(error).message}`
    );
  }
  const liveBindingSchema = liveRgd.spec?.schema?.spec?.[KRO_ARTIFACT_BINDINGS_SPEC_FIELD];
  if (!liveBindingSchema) return;
  if (
    liveBindingSchema !== STABLE_BINDING_SCHEMA &&
    (typeof liveBindingSchema !== 'object' ||
      !Object.values(liveBindingSchema).every(
        (requirement) => requirement !== null && typeof requirement === 'object'
      ))
  ) {
    throw new Error(
      `Cannot safely migrate ${rgdName}: ${KRO_ARTIFACT_BINDINGS_SPEC_FIELD} is not a recognized v0.32 or stable schema`
    );
  }

  const group =
    desiredRgd.spec.schema.group ??
    (apiVersion.includes('/') ? apiVersion.slice(0, apiVersion.lastIndexOf('/')) : undefined);
  if (!group) {
    throw new Error(
      `Cannot migrate artifact bindings for ${rgdName}: the desired RGD schema has no API group`
    );
  }
  // Put the desired RGD in place before broadening the generated CRD. If the
  // legacy RGD remains live, KRO can immediately reconcile and restore its old
  // topology-shaped schema between this patch and the caller's normal apply.
  // Applying the desired RGD first may briefly produce KindReady=False; the CRD
  // broadening below removes that incompatibility and the normal deployment
  // readiness gate waits for the same generation to become ready.
  await api.patch(
    desiredRgd,
    undefined,
    undefined,
    undefined,
    undefined,
    'application/merge-patch+json'
  );

  for (let attempt = 1; attempt <= MAX_CRD_PATCH_ATTEMPTS; attempt += 1) {
    const crd = await findGeneratedCrd(api, group, kind);
    if (!crd?.metadata?.name || !crd.spec?.versions) {
      throw new Error(
        `Cannot migrate artifact bindings for ${rgdName}: its generated CRD for ${group}/${kind} was not found`
      );
    }

    let changed = false;
    const versions = structuredClone(crd.spec.versions);
    for (const version of versions) {
      const bindings = propertySchema(version);
      if (!bindings || isNestedStringMap(bindings)) continue;
      if (!isLegacyArtifactBindingSchema(bindings)) {
        throw new Error(
          `Cannot safely migrate ${crd.metadata.name}: ${KRO_ARTIFACT_BINDINGS_SPEC_FIELD} is not a recognized v0.32 schema`
        );
      }
      const root = version.schema?.openAPIV3Schema?.properties;
      const spec = root?.spec as { properties?: Record<string, unknown> } | undefined;
      if (!spec?.properties) continue;
      spec.properties[KRO_ARTIFACT_BINDINGS_SPEC_FIELD] = nestedStringMapSchema();
      changed = true;
    }
    if (!changed) {
      if (needsRgdReconcileRetry(liveRgd)) {
        await requestRgdReconcile(api, rgdName);
      }
      return;
    }

    try {
      await api.patch(
        {
          apiVersion: 'apiextensions.k8s.io/v1',
          kind: 'CustomResourceDefinition',
          metadata: {
            name: crd.metadata.name,
            ...(crd.metadata.resourceVersion
              ? { resourceVersion: crd.metadata.resourceVersion }
              : {}),
          },
          spec: { versions },
        },
        undefined,
        undefined,
        undefined,
        undefined,
        'application/merge-patch+json'
      );
      await requestRgdReconcile(api, rgdName);
      return;
    } catch (error: unknown) {
      if (statusCode(error) !== 409 || attempt === MAX_CRD_PATCH_ATTEMPTS) {
        throw new Error(
          `Could not migrate generated CRD ${crd.metadata.name} after ${attempt} attempt${attempt === 1 ? '' : 's'}: ${ensureError(error).message}`
        );
      }
    }
  }
}
