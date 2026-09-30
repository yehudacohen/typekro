import { type } from 'arktype';

import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { Cel } from '../../../core/references/cel.js';
import { observedResource } from '../../../core/references/external-refs.js';
import type { CallableComposition } from '../../../core/types/deployment.js';
import { secret } from '../../kubernetes/config/secret.js';
import { harborRookS3SecretData } from '../provider/rook-s3-binding.js';

/** The OBC credential remains externally owned; this graph owns only its Harbor projection. */
export const HarborRookS3CredentialsConfigSchema = type({
  name: 'string > 0',
  namespace: 'string > 0',
  source: { namespace: 'string > 0', claimName: 'string > 0' },
}).narrow((config, ctx) =>
  config.namespace !== config.source.namespace || config.name !== config.source.claimName
    ? true
    : ctx.mustBe('a target Secret identity distinct from the Rook OBC credential Secret')
);

export type HarborRookS3CredentialsConfig = typeof HarborRookS3CredentialsConfigSchema.infer;

/**
 * Reconcile a plan-visible Harbor S3 Secret from an existing Rook OBC Secret.
 * Only references enter the plan; encoded bytes are resolved at Kubernetes
 * reconciliation without decoding, logging or returning credential values.
 */
export const harborRookS3Credentials: CallableComposition<
  typeof HarborRookS3CredentialsConfigSchema.infer,
  { ready: boolean; secretName: string }
> = kubernetesComposition(
  {
    name: 'harbor-rook-s3-credentials',
    kind: 'HarborRookS3Credentials',
    spec: HarborRookS3CredentialsConfigSchema,
    status: type({ ready: 'boolean', secretName: 'string' }),
  },
  (spec: HarborRookS3CredentialsConfig) => {
    const credentials = observedResource<Record<string, never>, Record<string, never>>({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: spec.source.claimName, namespace: spec.source.namespace },
      id: 'rookCredentials',
    });
    const projected = secret({
      id: 'harborStorageCredentials',
      metadata: {
        name: spec.name,
        namespace: spec.namespace,
        labels: {
          'app.kubernetes.io/name': 'harbor',
          'app.kubernetes.io/component': 'registry-storage',
          'app.kubernetes.io/managed-by': 'typekro',
          'typekro.dev/source-obc': spec.source.claimName,
        },
      },
      type: 'Opaque',
      data: harborRookS3SecretData({ data: credentials.data }),
    });
    projected.dependsOn(credentials);
    // Raw KRO instances can bypass author-side ArkType narrowing. Keep the
    // source identity fenced in the reconciled graph as well.
    projected.withIncludeWhen(
      Cel.expr<boolean>(
        'schema.spec.namespace != schema.spec.source.namespace || schema.spec.name != schema.spec.source.claimName'
      )
    );
    return {
      ready: projected.metadata.name !== '',
      secretName: projected.metadata.name,
    };
  }
);
