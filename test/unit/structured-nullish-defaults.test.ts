import { describe, expect, it } from 'bun:test';
import type { V1ResourceRequirements } from '@kubernetes/client-node';
import { type } from 'arktype';
import { kubernetesComposition } from '../../src/core/composition/imperative.js';
import { Deployment } from '../../src/factories/simple/index.js';

const ResourceRequirementsSchema = type({
  'requests?': {
    'cpu?': 'string',
    'memory?': 'string',
  },
  'limits?': {
    'cpu?': 'string',
    'memory?': 'string',
  },
});

const StructuredDefaultsSpecSchema = type({
  name: 'string',
  'resources?': {
    'osd?': ResourceRequirementsSchema,
    'mon?': ResourceRequirementsSchema,
  },
});

type StructuredDefaultsSpec = typeof StructuredDefaultsSpecSchema.infer;

const defaultOsdResources = {
  requests: { cpu: '250m', memory: '1Gi' },
  limits: { memory: '2Gi' },
} satisfies V1ResourceRequirements;

const defaultMonResources = {
  requests: { cpu: '100m', memory: '256Mi' },
  limits: { memory: '1Gi' },
} satisfies V1ResourceRequirements;

function resolveDaemonResources(spec: StructuredDefaultsSpec) {
  return {
    osd: spec.resources?.osd ?? defaultOsdResources,
    mon: spec.resources?.mon ?? defaultMonResources,
  };
}

const structuredDefaultsComposition = kubernetesComposition(
  {
    name: 'structured-nullish-defaults',
    kind: 'StructuredNullishDefaults',
    spec: StructuredDefaultsSpecSchema,
    status: type({ ready: 'boolean' }),
  },
  (spec: StructuredDefaultsSpec) => {
    const resources = resolveDaemonResources(spec);
    Deployment({
      name: `${spec.name}-osd`,
      image: 'nginx:1.29',
      resources: resources.osd,
      id: 'osd',
    });
    Deployment({
      name: `${spec.name}-mon`,
      image: 'nginx:1.29',
      resources: resources.mon,
      id: 'mon',
    });
    return { ready: true };
  }
);

function deploymentSection(yaml: string, name: string): string {
  const start = yaml.indexOf(`name: ${name}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const nextDocument = yaml.indexOf('\n---', start);
  return yaml.slice(start, nextDocument === -1 ? undefined : nextDocument);
}

describe('structured nullish defaults', () => {
  it('lowers helper-returned object fallbacks into guarded KRO expressions', () => {
    const yaml = structuredDefaultsComposition.factory('kro').toYaml();
    const compact = yaml.replaceAll(' ', '');

    expect(compact).toContain(
      'has(schema.spec.resources)&&has(schema.spec.resources.osd)?schema.spec.resources.osd:({"requests":{"cpu":"250m","memory":"1Gi"},"limits":{"memory":"2Gi"}})'
    );
    expect(compact).toContain(
      'has(schema.spec.resources)&&has(schema.spec.resources.mon)?schema.spec.resources.mon:({"requests":{"cpu":"100m","memory":"256Mi"},"limits":{"memory":"1Gi"}})'
    );
  });

  it('keeps direct-mode JavaScript defaults when the optional parent is omitted', () => {
    const yaml = structuredDefaultsComposition.factory('direct').toYaml({ name: 'omitted-parent' });

    const osd = deploymentSection(yaml, 'omitted-parent-osd');
    expect(osd).toContain('cpu: 250m');
    expect(osd).toContain('memory: 2Gi');

    const mon = deploymentSection(yaml, 'omitted-parent-mon');
    expect(mon).toContain('cpu: 100m');
    expect(mon).toContain('memory: 256Mi');
  });

  it('defaults untouched siblings while replacing a supplied object completely', () => {
    const yaml = structuredDefaultsComposition.factory('direct').toYaml({
      name: 'partial-parent',
      resources: {
        osd: {
          limits: { memory: '4Gi' },
        },
      },
    });

    const osd = deploymentSection(yaml, 'partial-parent-osd');
    expect(osd).toContain('memory: 4Gi');
    expect(osd).not.toContain('cpu: 250m');
    expect(osd).not.toContain('memory: 1Gi');

    const mon = deploymentSection(yaml, 'partial-parent-mon');
    expect(mon).toContain('cpu: 100m');
    expect(mon).toContain('memory: 256Mi');
  });

  it('keeps KRO instance input partial and delegates default selection to the RGD', () => {
    const yaml = structuredDefaultsComposition.factory('kro').toYaml({
      name: 'partial-parent',
      resources: {
        osd: {
          limits: { memory: '4Gi' },
        },
      },
    });

    expect(yaml).toContain('memory: 4Gi');
    expect(yaml).not.toContain('cpu: 250m');
    expect(yaml).not.toContain('cpu: 100m');
  });
});
