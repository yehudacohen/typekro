import type { KubernetesObject, KubernetesObjectApi } from '@kubernetes/client-node';
import { extractTypekroTags } from '../../../core/deployment/resource-tagging.js';
import { isNotFoundError } from '../../../core/kubernetes/errors.js';

const LEGACY_NACK_RELEASE = 'nack';
const LEGACY_NACK_RESOURCE_ID = 'nackHelmRelease';
const NATS_FACTORY_NAME = 'nats-bootstrap';

export interface LegacyNackRetirementOptions {
  readonly namespace: string;
  readonly instanceName: string;
  readonly kubernetesApi: KubernetesObjectApi;
  readonly timeout?: number;
  readonly abortSignal?: AbortSignal;
}

/**
 * Retire the v0.33.5 instance-owned NACK HelmRelease after the replacement
 * singleton is Ready.
 *
 * This is intentionally ownership- and UID-leased. A same-named user release,
 * a release belonging to another TypeKro instance, or a replacement object
 * appearing during deletion is never adopted or deleted.
 */
export async function retireLegacyNackController(
  options: LegacyNackRetirementOptions
): Promise<void> {
  const identity: {
    apiVersion: string;
    kind: string;
    metadata: { name: string; namespace: string };
  } = {
    apiVersion: 'helm.toolkit.fluxcd.io/v2',
    kind: 'HelmRelease',
    metadata: {
      name: LEGACY_NACK_RELEASE,
      namespace: options.namespace,
    },
  };

  let live: KubernetesObject;
  try {
    live = await options.kubernetesApi.read(identity);
  } catch (error: unknown) {
    if (isNotFoundError(error)) return;
    throw error;
  }

  assertLegacyNackOwnership(live, options.instanceName);
  const uid = live.metadata?.uid;
  if (!uid) {
    throw new Error(
      `Refusing to retire legacy NACK HelmRelease ${options.namespace}/${LEGACY_NACK_RELEASE}: ` +
        'metadata.uid is missing.'
    );
  }

  await options.kubernetesApi.delete(
    live,
    undefined,
    undefined,
    undefined,
    undefined,
    'Foreground',
    { preconditions: { uid } }
  );

  const timeout = options.timeout ?? 300_000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    options.abortSignal?.throwIfAborted();
    try {
      const current = await options.kubernetesApi.read(identity);
      if (current.metadata?.uid && current.metadata.uid !== uid) {
        throw new Error(
          `Refusing to continue legacy NACK retirement for ${options.namespace}/${LEGACY_NACK_RELEASE}: ` +
            `UID changed from ${uid} to ${current.metadata.uid}.`
        );
      }
    } catch (error: unknown) {
      if (isNotFoundError(error)) return;
      throw error;
    }
    await abortableDelay(1_000, options.abortSignal);
  }

  throw new Error(
    `Timed out after ${timeout}ms retiring legacy NACK HelmRelease ` +
      `${options.namespace}/${LEGACY_NACK_RELEASE} (uid ${uid}).`
  );
}

function assertLegacyNackOwnership(resource: KubernetesObject, instanceName: string): void {
  const tags = extractTypekroTags(resource);
  const chartName = (
    resource as KubernetesObject & {
      spec?: { chart?: { spec?: { chart?: unknown } } };
    }
  ).spec?.chart?.spec?.chart;
  const problems = [
    ...(tags.factoryName === NATS_FACTORY_NAME
      ? []
      : [`factory=${tags.factoryName ?? '<missing>'}`]),
    ...(tags.instanceName === instanceName ? [] : [`instance=${tags.instanceName ?? '<missing>'}`]),
    ...(tags.resourceId === LEGACY_NACK_RESOURCE_ID
      ? []
      : [`resource-id=${tags.resourceId ?? '<missing>'}`]),
    ...(chartName === 'nack' ? [] : [`chart=${String(chartName ?? '<missing>')}`]),
  ];
  if (problems.length > 0) {
    throw new Error(
      `Refusing to retire HelmRelease ${resource.metadata?.namespace}/${resource.metadata?.name}: ` +
        `it is not the v0.33.5 NACK child owned by ${NATS_FACTORY_NAME}/${instanceName} ` +
        `(${problems.join(', ')}).`
    );
  }
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
