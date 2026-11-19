/**
 * The composition generated from Alchemy's `RivetKubernetes.StatefulSetControlPlane` must
 * serialize to a valid kro ResourceGraphDefinition with TypeKro's own serializer and validation,
 * without a cluster. The generator lives in tools/alchemy-kubernetes-capture.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import {
  rivetControlPlane,
  rivetControlPlaneAdminToken,
} from '../../../tools/alchemy-kubernetes-capture/generated/rivet-control-plane.js';
import { admissionErrors } from '../../utils/kro-admission.js';

interface ParsedRgdResource {
  id: string;
  template: Record<string, unknown> & {
    kind: string;
    metadata: { name: string; namespace: string; annotations?: Record<string, string> };
  };
  readyWhen?: string[];
}

interface ParsedRgd {
  apiVersion: string;
  kind: string;
  metadata: { name: string };
  spec: {
    schema: { kind: string; spec: Record<string, string>; status: Record<string, string> };
    resources: ParsedRgdResource[];
  };
}

const generatedPath = join(
  import.meta.dir,
  '../../../tools/alchemy-kubernetes-capture/generated/rivet-control-plane.ts'
);

function parsed(): ParsedRgd {
  const docs = yaml.loadAll(rivetControlPlane.toYaml()) as ParsedRgd[];
  expect(docs).toHaveLength(1);
  return docs[0] as ParsedRgd;
}

function resource(rgd: ParsedRgd, id: string): ParsedRgdResource {
  const found = rgd.spec.resources.find((entry) => entry.id === id);
  if (!found) throw new Error(`RGD has no resource ${id}`);
  return found;
}

describe('generated Rivet control plane RGD', () => {
  it('imports no Alchemy code and carries no capture sentinels', () => {
    const source = readFileSync(generatedPath, 'utf8');
    expect(source).not.toMatch(/from ['"](alchemy|@alchemy\.run\/|effect)/);
    const yamlText = rivetControlPlane.toYaml();
    expect(yamlText).not.toContain('tkpq');
    expect(yamlText).not.toContain('tkcapture');
  });

  it('serializes to one ResourceGraphDefinition with the expected objects', () => {
    const rgd = parsed();
    expect(rgd.apiVersion).toBe('kro.run/v1alpha1');
    expect(rgd.kind).toBe('ResourceGraphDefinition');
    expect(rgd.spec.schema.kind).toBe('RivetControlPlane');
    // `typekroArtifactBindings` is TypeKro's reserved root field for provider bindings.
    expect(Object.keys(rgd.spec.schema.spec).sort()).toEqual([
      'diskSize',
      'image',
      'name',
      'namespace',
      'pool',
      'typekroArtifactBindings',
    ]);
    expect(rgd.spec.resources.map((entry) => `${entry.id}:${entry.template.kind}`).sort()).toEqual([
      'api:Service',
      'engines:StatefulSet',
      'peers:Service',
      'pool:Job',
    ]);
  });

  it('binds captured values to the schema and keeps Alchemy constants', () => {
    const rgd = parsed();
    const engines = resource(rgd, 'engines').template as unknown as {
      metadata: { name: string };
      spec: {
        replicas: number;
        serviceName: string;
        template: { spec: { containers: Array<{ image: string; env: unknown[] }> } };
        volumeClaimTemplates: Array<{ spec: { resources: { requests: { storage: string } } } }>;
      };
    };
    expect(engines.metadata.name).toBe('${schema.spec.name}');
    expect(engines.spec.replicas).toBe(1);
    expect(engines.spec.serviceName).toBe('${schema.spec.name}-peers');
    expect(engines.spec.template.spec.containers[0]?.image).toBe('${schema.spec.image}');
    expect(engines.spec.volumeClaimTemplates[0]?.spec.resources.requests.storage).toBe(
      '${schema.spec.diskSize}'
    );
    expect(JSON.stringify(engines.spec.template.spec.containers[0]?.env)).toContain(
      '"name":"${schema.spec.name}-token"'
    );
  });

  it('declares readiness and the pool Job dependency', () => {
    const rgd = parsed();
    expect(resource(rgd, 'engines').readyWhen?.[0]).toContain('engines.status.readyReplicas');
    expect(resource(rgd, 'pool').readyWhen?.[0]).toBe(
      '${has(pool.status.succeeded) && pool.status.succeeded > 0}'
    );
    // A changed template or pool gets a new Job name, because a Job's template is immutable.
    expect(resource(rgd, 'pool').template.metadata.name).toMatch(
      /^\$\{schema\.spec\.name\}-pool-\$\{schema\.spec\.pool\}-[0-9a-f]{8}$/
    );
    const annotations = resource(rgd, 'pool').template.metadata.annotations ?? {};
    expect(Object.keys(annotations).sort()).toEqual([
      'typekro.dev/depends-on-api',
      'typekro.dev/depends-on-engines',
    ]);
  });

  it('projects status from resources, as kro requires', () => {
    const status = parsed().spec.schema.status;
    expect(status.nodeEndpoint).toBe(
      'http://${api.metadata.name}.${api.metadata.namespace}.svc.cluster.local:6420'
    );
    expect(status.ready).toContain('engines.status.readyReplicas');
  });

  it('renders the out-of-graph admin-token Secret in direct mode', async () => {
    const factory = await rivetControlPlaneAdminToken.factory('direct', { namespace: 'rivet' });
    const manifests = yaml.loadAll(
      // TypeKro refuses to print a Secret's value unless the caller opts in.
      factory.toYaml(
        { name: 'engine', namespace: 'rivet', token: 'not-a-real-token' },
        { allowSensitiveMaterialization: true }
      )
    ) as Array<{ kind: string; metadata: { name: string }; stringData: Record<string, string> }>;
    expect(manifests.map((manifest) => manifest.kind)).toEqual(['Secret']);
    expect(manifests[0]?.metadata.name).toBe('engine-token');
    expect(manifests[0]?.stringData.token).toBe('not-a-real-token');
  });

  describe('names built from the spec', () => {
    const instance = {
      name: 'engine',
      namespace: 'rivet',
      image: 'rivetdev/engine:3.0.0',
      diskSize: '10Gi',
      pool: 'default',
    };

    it('admits a valid instance', () => {
      expect(admissionErrors(rivetControlPlane.toYaml(), 'RivetControlPlane', instance)).toEqual(
        []
      );
    });

    it('refuses names Kubernetes would refuse, at admission', () => {
      const yamlText = rivetControlPlane.toYaml();
      for (const [field, value] of [
        // 33 characters: the pool Job name would be 64.
        ['name', 'e'.repeat(33)],
        // A Service name must start with a letter.
        ['name', '1engine'],
        ['name', 'Engine'],
        ['namespace', 'rivet_system'],
        ['pool', 'p'.repeat(17)],
        ['pool', 'Default'],
      ] as const) {
        const errors = admissionErrors(yamlText, 'RivetControlPlane', {
          ...instance,
          [field]: value,
        });
        expect(errors).toHaveLength(1);
        expect(errors[0]).toStartWith(`spec.${field}: `);
      }
    });

    it('refuses them in direct mode too', async () => {
      const factory = await rivetControlPlane.factory('direct', { namespace: 'rivet' });
      expect(() => factory.toYaml({ ...instance, name: 'e'.repeat(33) })).toThrow(
        'name must be at most length 32 (was 33)'
      );
      expect(() => factory.toYaml({ ...instance, pool: 'Default' })).toThrow(
        'pool must be matched by'
      );
      expect(() => factory.toYaml(instance)).not.toThrow();
    });
  });
});
