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

const ConditionalResourcesSpecSchema = type({
  name: 'string',
  'enabled?': 'boolean',
  'resources?': ResourceRequirementsSchema,
});

type ConditionalResourcesSpec = typeof ConditionalResourcesSpecSchema.infer;

const StructuredChainSpecSchema = type({
  name: 'string',
  'primary?': ResourceRequirementsSchema,
  'secondary?': ResourceRequirementsSchema,
});

type StructuredChainSpec = typeof StructuredChainSpecSchema.infer;

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

function resolveConditionalResources(spec: ConditionalResourcesSpec) {
  return spec.enabled ? spec.resources : defaultOsdResources;
}

const conditionalResourcesComposition = kubernetesComposition(
  {
    name: 'conditional-structured-resources',
    kind: 'ConditionalStructuredResources',
    spec: ConditionalResourcesSpecSchema,
    status: type({ ready: 'boolean' }),
  },
  (spec: ConditionalResourcesSpec) => {
    Deployment({
      name: spec.name,
      image: 'nginx:1.29',
      resources: resolveConditionalResources(spec),
      id: 'workload',
    });
    return { ready: true };
  }
);

function resolveStructuredChain(spec: StructuredChainSpec) {
  return spec.primary ?? spec.secondary ?? defaultOsdResources;
}

const structuredChainComposition = kubernetesComposition(
  {
    name: 'structured-coalesce-chain',
    kind: 'StructuredCoalesceChain',
    spec: StructuredChainSpecSchema,
    status: type({ ready: 'boolean' }),
  },
  (spec: StructuredChainSpec) => {
    Deployment({
      name: spec.name,
      image: 'nginx:1.29',
      resources: resolveStructuredChain(spec),
      id: 'workload',
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

  it('does not infer a nullish fallback from an unrelated conditional', () => {
    const yaml = conditionalResourcesComposition.factory('kro').toYaml();
    const compact = yaml.replaceAll(' ', '');

    expect(compact).not.toContain(
      'has(schema.spec.resources)?schema.spec.resources:({"requests":{"cpu":"250m","memory":"1Gi"},"limits":{"memory":"2Gi"}})'
    );
  });

  it('preserves a structured terminal fallback in a cross-field chain', () => {
    const yaml = structuredChainComposition.factory('kro').toYaml();
    const compact = yaml.replaceAll(' ', '');

    expect(compact).toContain(
      'has(schema.spec.primary)?schema.spec.primary:(has(schema.spec.secondary)?schema.spec.secondary:({"requests":{"cpu":"250m","memory":"1Gi"},"limits":{"memory":"2Gi"}}))'
    );
  });

  it('keeps direct-mode replacement order for a structured cross-field chain', () => {
    const fallbackYaml = structuredChainComposition.factory('direct').toYaml({ name: 'fallback' });
    expect(deploymentSection(fallbackYaml, 'fallback')).toContain('memory: 2Gi');

    const secondaryYaml = structuredChainComposition.factory('direct').toYaml({
      name: 'secondary',
      secondary: { limits: { memory: '3Gi' } },
    });
    const secondary = deploymentSection(secondaryYaml, 'secondary');
    expect(secondary).toContain('memory: 3Gi');
    expect(secondary).not.toContain('memory: 2Gi');

    const primaryYaml = structuredChainComposition.factory('direct').toYaml({
      name: 'primary',
      primary: { limits: { memory: '4Gi' } },
      secondary: { limits: { memory: '3Gi' } },
    });
    const primary = deploymentSection(primaryYaml, 'primary');
    expect(primary).toContain('memory: 4Gi');
    expect(primary).not.toContain('memory: 3Gi');
  });
});
