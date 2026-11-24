/**
 * Integration of the complete pinned bundle with the Kubernetes schemas it is applied against.
 *
 * The installation is rendered with every option set, the way the direct factory applies it.
 * Built-in objects are checked against the Kubernetes v1.36.1 OpenAPI schemas (vendored with the
 * bundle), `ate.dev` objects against the bundle's own CRDs, and the SandboxConfig against the
 * bundle's ValidatingAdmissionPolicy, evaluated with CEL.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { evaluate } from 'cel-js';
import { loadAll } from 'js-yaml';

import { agentSubstrateInstallation } from '../../../src/factories/agent-substrate/index.js';
import { agentSubstrateV1_0_0 as release } from '../../../src/factories/agent-substrate/releases/v1.0.0.js';
import { crdSpecErrors } from '../../utils/crd-schema.js';
import type { OpenApiSchema } from '../../utils/kro-admission.js';
import { kubernetesSchemaErrors, loadKubernetesOpenApi } from '../../utils/kubernetes-openapi.js';

const kubernetes = loadKubernetesOpenApi(
  join(import.meta.dir, '../../fixtures/agent-substrate/kubernetes-v1.36.1-openapi.json')
);

interface Rendered {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string };
  spec?: Record<string, unknown>;
}

const rendered = loadAll(
  agentSubstrateInstallation({
    ingressAllowedSpiffeIds: ['spiffe://cluster.local/ns/app/sa/client'],
    workerPools: [
      {
        namespace: 'agents',
        name: 'pool',
        replicas: 2,
        sandboxConfig: 'gvisor-default',
        nodeSelector: { 'kubernetes.io/os': 'linux' },
        tolerations: [{ key: 'example.test/sandbox', operator: 'Exists', effect: 'NoSchedule' }],
        resources: { requests: { cpu: '2', memory: '4Gi' }, limits: { memory: '8Gi' } },
      },
      { namespace: 'agents', name: 'idle', replicas: 0 },
    ],
  })
    .factory('direct', {})
    .toYaml({})
) as Rendered[];

const crdSchemas = new Map<string, OpenApiSchema>();
for (const { manifest } of release.documents) {
  if (manifest.kind !== 'CustomResourceDefinition') continue;
  const spec = manifest.spec as {
    group: string;
    names: { kind: string };
    versions: { name: string; schema: { openAPIV3Schema: OpenApiSchema } }[];
  };
  for (const version of spec.versions) {
    crdSchemas.set(
      `${spec.group}/${version.name}/${spec.names.kind}`,
      version.schema.openAPIV3Schema
    );
  }
}

describe('the complete Agent Substrate bundle against the Kubernetes schemas', () => {
  test('renders every release object plus the selected WorkerPools and their namespace', () => {
    expect(rendered).toHaveLength(release.documents.length + 3);
    const kinds = new Set(rendered.map(({ kind }) => kind));
    for (const kind of [
      'Deployment',
      'DaemonSet',
      'WorkerPool',
      'SandboxConfig',
      'ValidatingAdmissionPolicy',
    ]) {
      expect(kinds.has(kind)).toBe(true);
    }
  });

  test('every built-in object matches its Kubernetes v1.36.1 schema', () => {
    const builtIn = rendered.filter(({ apiVersion }) => !apiVersion.startsWith('ate.dev/'));
    expect(builtIn.length).toBeGreaterThan(50);
    for (const object of builtIn) {
      expect(
        `${object.kind}/${object.metadata.name}: ${kubernetesSchemaErrors(kubernetes, object).join('; ')}`
      ).toBe(`${object.kind}/${object.metadata.name}: `);
    }
  });

  test('every ate.dev object matches the bundle CRD that serves it', () => {
    const custom = rendered.filter(({ apiVersion }) => apiVersion.startsWith('ate.dev/'));
    expect(custom.map(({ kind }) => kind).sort()).toEqual([
      'SandboxConfig',
      'WorkerPool',
      'WorkerPool',
    ]);
    for (const object of custom) {
      const schema = crdSchemas.get(`${object.apiVersion}/${object.kind}`);
      if (!schema) throw new Error(`No CRD serves ${object.apiVersion}/${object.kind}.`);
      expect(
        `${object.kind}/${object.metadata.name}: ${crdSpecErrors(schema, object.spec).join('; ')}`
      ).toBe(`${object.kind}/${object.metadata.name}: `);
    }
  });

  test('the SandboxConfig passes the bundle admission policy', () => {
    const policy = rendered.find(({ kind }) => kind === 'ValidatingAdmissionPolicy') as unknown as {
      spec: { validations: { expression: string }[] };
    };
    const config = rendered.find(({ kind }) => kind === 'SandboxConfig') as unknown as {
      spec: { sandboxClass: string; versions: { assets: unknown }[] };
    };
    // The rule for the config's own class. The other class's rule starts with
    // `object.spec.sandboxClass != '<class>' ||`, so it admits this config whatever follows.
    const rules = policy.spec.validations.filter(({ expression }) =>
      expression.startsWith(`object.spec.sandboxClass != '${config.spec.sandboxClass}'`)
    );
    expect(rules).toHaveLength(1);
    for (const { expression } of rules) {
      expect(evaluate(expression, { object: config as never })).toBe(true);
      // The rule is not vacuous: a version without its gVisor asset is refused.
      const broken = structuredClone(config);
      for (const version of broken.spec.versions) version.assets = { amd64: {} };
      expect(evaluate(expression, { object: broken as never })).toBe(false);
    }
  });

  test('the checks reject what the API server would reject', () => {
    const deployment = structuredClone(
      rendered.find(({ kind }) => kind === 'Deployment')
    ) as unknown as { spec: { template: { spec: { containers: Record<string, unknown>[] } } } };
    const container = deployment.spec.template.spec.containers[0] as Record<string, unknown>;
    container.imagePullPolicy = 3;
    container.unknownField = true;
    const errors = kubernetesSchemaErrors(kubernetes, deployment as never);
    expect(errors.some((error) => error.includes('imagePullPolicy: expected string'))).toBe(true);
    expect(errors.some((error) => error.includes('unknownField: unknown field'))).toBe(true);
    const pool = structuredClone(rendered.find(({ kind }) => kind === 'WorkerPool')) as Rendered;
    const schema = crdSchemas.get('ate.dev/v1/WorkerPool') as OpenApiSchema;
    expect(
      crdSpecErrors(schema, { ...pool.spec, sandboxClasses: [{ name: 'other' }] }).length
    ).toBeGreaterThan(0);
  });
});
