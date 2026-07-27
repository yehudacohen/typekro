import { describe, expect, it } from 'bun:test';
import type { V1ResourceRequirements } from '@kubernetes/client-node';
import { type } from 'arktype';
import { mergeValuesExpression } from '../../src/core/aspects/values-merge.js';
import { kubernetesComposition } from '../../src/core/composition/imperative.js';
import { Cel } from '../../src/core/references/cel.js';
import { helmRelease } from '../../src/factories/helm/helm-release.js';
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
  enabled: 'boolean',
  'resources?': ResourceRequirementsSchema,
});

type ConditionalResourcesSpec = typeof ConditionalResourcesSpecSchema.infer;

const ScalarConditionalResourcesSpecSchema = type({
  name: 'string',
  mode: 'string',
  'resources?': ResourceRequirementsSchema,
});

type ScalarConditionalResourcesSpec = typeof ScalarConditionalResourcesSpecSchema.infer;

const StructuredChainSpecSchema = type({
  name: 'string',
  'primary?': ResourceRequirementsSchema,
  'secondary?': ResourceRequirementsSchema,
});

type StructuredChainSpec = typeof StructuredChainSpecSchema.infer;

const GuardedResourcesSpecSchema = type({
  name: 'string',
  'enabled?': 'boolean',
  'resources?': ResourceRequirementsSchema,
});

type GuardedResourcesSpec = typeof GuardedResourcesSpecSchema.infer;

const UnionSettingsSchema = type({
  mode: "'standard'",
  'resources?': ResourceRequirementsSchema,
}).or({
  mode: "'intensive'",
  'resources?': ResourceRequirementsSchema,
});

const UnionSettingsSpecSchema = type({
  name: 'string',
  settings: UnionSettingsSchema,
});

type UnionSettingsSpec = typeof UnionSettingsSpecSchema.infer;

const RequiredNullableResourcesSpecSchema = type({
  name: 'string',
  resources: ResourceRequirementsSchema.or('null'),
});

type RequiredNullableResourcesSpec = typeof RequiredNullableResourcesSpecSchema.infer;

const OptionalNullableResourcesSpecSchema = type({
  name: 'string',
  'resources?': ResourceRequirementsSchema.or('null'),
});

type OptionalNullableResourcesSpec = typeof OptionalNullableResourcesSpecSchema.infer;

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
    osd: Cel.default(spec.resources?.osd, defaultOsdResources),
    mon: Cel.default(spec.resources?.mon, defaultMonResources),
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
  return spec.enabled && spec.resources ? spec.resources : defaultOsdResources;
}

const conditionalResourcesComposition = kubernetesComposition(
  {
    name: 'conditional-structured-resources',
    kind: 'ConditionalStructuredResources',
    spec: ConditionalResourcesSpecSchema,
    status: type({ ready: 'boolean' }),
  },
  (spec: ConditionalResourcesSpec) => {
    const resources = resolveConditionalResources(spec);
    Deployment({
      name: spec.name,
      image: 'nginx:1.29',
      ...(resources === undefined ? {} : { resources }),
      id: 'workload',
    });
    return { ready: true };
  }
);

function resolveScalarConditionalResources(spec: ScalarConditionalResourcesSpec) {
  return spec.mode !== 'disabled' && spec.resources ? spec.resources : defaultOsdResources;
}

const scalarConditionalResourcesComposition = kubernetesComposition(
  {
    name: 'scalar-conditional-structured-resources',
    kind: 'ScalarConditionalStructuredResources',
    spec: ScalarConditionalResourcesSpecSchema,
    status: type({ ready: 'boolean' }),
  },
  (spec: ScalarConditionalResourcesSpec) => {
    const resources = resolveScalarConditionalResources(spec);
    Deployment({
      name: spec.name,
      image: 'nginx:1.29',
      ...(resources === undefined ? {} : { resources }),
      id: 'workload',
    });
    return { ready: true };
  }
);

function resolveStructuredChain(spec: StructuredChainSpec) {
  return Cel.default(spec.primary, Cel.default(spec.secondary, defaultOsdResources));
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

const guardedNativeFallbackComposition = kubernetesComposition(
  {
    name: 'guarded-native-structured-fallback',
    kind: 'GuardedNativeStructuredFallback',
    spec: GuardedResourcesSpecSchema,
    status: type({ ready: 'boolean' }),
  },
  (spec: GuardedResourcesSpec) => {
    if (spec.enabled) {
      Deployment({
        name: spec.name,
        image: 'nginx:1.29',
        resources: spec.resources ?? defaultOsdResources,
        id: 'workload',
      });
    }
    return { ready: true };
  }
);

const guardedExplicitFallbackComposition = kubernetesComposition(
  {
    name: 'guarded-explicit-structured-fallback',
    kind: 'GuardedExplicitStructuredFallback',
    spec: GuardedResourcesSpecSchema,
    status: type({ ready: 'boolean' }),
  },
  (spec: GuardedResourcesSpec) => {
    if (spec.enabled) {
      Deployment({
        name: spec.name,
        image: 'nginx:1.29',
        resources: Cel.default(spec.resources, defaultOsdResources),
        id: 'workload',
      });
    }
    return { ready: true };
  }
);

const guardedOptionalPassthroughComposition = kubernetesComposition(
  {
    name: 'guarded-optional-structured-passthrough',
    kind: 'GuardedOptionalStructuredPassthrough',
    spec: GuardedResourcesSpecSchema,
    status: type({ ready: 'boolean' }),
  },
  (spec: GuardedResourcesSpec) => {
    if (spec.enabled) {
      Deployment({
        name: spec.name,
        image: 'nginx:1.29',
        ...(spec.resources === undefined ? {} : { resources: spec.resources }),
        id: 'workload',
      });
    }
    return { ready: true };
  }
);

const mergedNativeFallbackComposition = kubernetesComposition(
  {
    name: 'merged-native-structured-fallback',
    kind: 'MergedNativeStructuredFallback',
    spec: GuardedResourcesSpecSchema,
    status: type({ ready: 'boolean' }),
  },
  (spec: GuardedResourcesSpec) => {
    helmRelease({
      name: spec.name,
      chart: { repository: 'https://example.com/charts', name: 'example' },
      values: mergeValuesExpression(spec.resources ?? defaultOsdResources, {
        replicaCount: 1,
      }),
      id: 'workload',
    });
    return { ready: true };
  }
);

const mergedExplicitFallbackComposition = kubernetesComposition(
  {
    name: 'merged-explicit-structured-fallback',
    kind: 'MergedExplicitStructuredFallback',
    spec: GuardedResourcesSpecSchema,
    status: type({ ready: 'boolean' }),
  },
  (spec: GuardedResourcesSpec) => {
    helmRelease({
      name: spec.name,
      chart: { repository: 'https://example.com/charts', name: 'example' },
      values: mergeValuesExpression(Cel.default(spec.resources, defaultOsdResources), {
        replicaCount: 1,
      }),
      id: 'workload',
    });
    return { ready: true };
  }
);

const mergedOverlayNativeFallbackComposition = kubernetesComposition(
  {
    name: 'merged-overlay-native-structured-fallback',
    kind: 'MergedOverlayNativeStructuredFallback',
    spec: GuardedResourcesSpecSchema,
    status: type({ ready: 'boolean' }),
  },
  (spec: GuardedResourcesSpec) => {
    helmRelease({
      name: spec.name,
      chart: { repository: 'https://example.com/charts', name: 'example' },
      values: mergeValuesExpression({ replicaCount: 1 }, spec.resources ?? defaultOsdResources),
      id: 'workload',
    });
    return { ready: true };
  }
);

function mergeOptionalValues(base: unknown, overlay: Record<string, unknown>) {
  return base === undefined ? overlay : mergeValuesExpression(base, overlay);
}

const normalizedValuesMergeComposition = kubernetesComposition(
  {
    name: 'normalized-values-merge',
    kind: 'NormalizedValuesMerge',
    spec: GuardedResourcesSpecSchema,
    status: type({ ready: 'boolean' }),
  },
  (spec: GuardedResourcesSpec) => {
    helmRelease({
      name: spec.name,
      chart: { repository: 'https://example.com/charts', name: 'example' },
      values: mergeOptionalValues(spec.resources, { replicaCount: 1 }),
      id: 'workload',
    });
    return { ready: true };
  }
);

function conditionallyMergeResourceDefaults(spec: GuardedResourcesSpec) {
  return spec.resources
    ? mergeValuesExpression({ replicaCount: 1 }, { resources: spec.resources })
    : {
        replicaCount: 1,
        resources: defaultOsdResources,
      };
}

const conditionalMergeFallbackComposition = kubernetesComposition(
  {
    name: 'conditional-values-merge-fallback',
    kind: 'ConditionalValuesMergeFallback',
    spec: GuardedResourcesSpecSchema,
    status: type({ ready: 'boolean' }),
  },
  (spec: GuardedResourcesSpec) => {
    helmRelease({
      name: spec.name,
      chart: { repository: 'https://example.com/charts', name: 'example' },
      values: conditionallyMergeResourceDefaults(spec),
      id: 'workload',
    });
    return { ready: true };
  }
);

const unionBranchNativeFallbackComposition = kubernetesComposition(
  {
    name: 'union-branch-native-structured-fallback',
    kind: 'UnionBranchNativeStructuredFallback',
    spec: UnionSettingsSpecSchema,
    status: type({ ready: 'boolean' }),
  },
  (spec: UnionSettingsSpec) => {
    Deployment({
      name: spec.name,
      image: 'nginx:1.29',
      resources: spec.settings.resources ?? {
        requests: { cpu: '250m' },
      },
      id: 'workload',
    });
    return { ready: true };
  }
);

const requiredNullableNativeFallbackComposition = kubernetesComposition(
  {
    name: 'required-nullable-native-structured-fallback',
    kind: 'RequiredNullableNativeStructuredFallback',
    spec: RequiredNullableResourcesSpecSchema,
    status: type({ ready: 'boolean' }),
  },
  (spec: RequiredNullableResourcesSpec) => {
    Deployment({
      name: spec.name,
      image: 'nginx:1.29',
      resources: spec.resources ?? defaultOsdResources,
      id: 'workload',
    });
    return { ready: true };
  }
);

const requiredNullableExplicitFallbackComposition = kubernetesComposition(
  {
    name: 'required-nullable-explicit-structured-fallback',
    kind: 'RequiredNullableExplicitStructuredFallback',
    spec: RequiredNullableResourcesSpecSchema,
    status: type({ ready: 'boolean' }),
  },
  (spec: RequiredNullableResourcesSpec) => {
    Deployment({
      name: spec.name,
      image: 'nginx:1.29',
      resources: Cel.default(spec.resources, defaultOsdResources),
      id: 'workload',
    });
    return { ready: true };
  }
);

const optionalNullableNullBranchComposition = kubernetesComposition(
  {
    name: 'optional-nullable-null-branch',
    kind: 'OptionalNullableNullBranch',
    spec: OptionalNullableResourcesSpecSchema,
    status: type({ ready: 'boolean' }),
  },
  (spec: OptionalNullableResourcesSpec) => {
    const resources = spec.resources === null ? defaultOsdResources : spec.resources;
    Deployment({
      name: spec.name,
      image: 'nginx:1.29',
      ...(resources === undefined ? {} : { resources }),
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
  it('lowers explicit helper-returned structured defaults into guarded KRO expressions', () => {
    const yaml = structuredDefaultsComposition.factory('kro').toYaml();
    const compact = yaml.replaceAll(' ', '');

    expect(compact).toContain(
      'has(schema.spec.resources)&&has(schema.spec.resources.osd)&&schema.spec.resources.osd!=null?schema.spec.resources.osd:{"requests":{"cpu":"250m","memory":"1Gi"},"limits":{"memory":"2Gi"}}'
    );
    expect(compact).toContain(
      'has(schema.spec.resources)&&has(schema.spec.resources.mon)&&schema.spec.resources.mon!=null?schema.spec.resources.mon:{"requests":{"cpu":"100m","memory":"256Mi"},"limits":{"memory":"1Gi"}}'
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
    expect(() => conditionalResourcesComposition.factory('kro').toYaml()).toThrow(
      /Cannot prove structured fallback semantics.*Cel\.default/
    );

    const disabledYaml = conditionalResourcesComposition.factory('direct').toYaml({
      name: 'disabled',
      enabled: false,
      resources: { limits: { memory: '4Gi' } },
    });
    const disabled = deploymentSection(disabledYaml, 'disabled');
    expect(disabled).toContain('memory: 2Gi');
    expect(disabled).not.toContain('memory: 4Gi');

    const enabledYaml = conditionalResourcesComposition.factory('direct').toYaml({
      name: 'enabled',
      enabled: true,
      resources: { limits: { memory: '4Gi' } },
    });
    const enabled = deploymentSection(enabledYaml, 'enabled');
    expect(enabled).toContain('memory: 4Gi');
    expect(enabled).not.toContain('memory: 2Gi');
  });

  it('fails closed instead of erasing a value-based scalar guard', () => {
    expect(() => scalarConditionalResourcesComposition.factory('kro').toYaml()).toThrow(
      /Cannot prove structured fallback semantics.*Cel\.default/
    );

    const disabledYaml = scalarConditionalResourcesComposition.factory('direct').toYaml({
      name: 'disabled-mode',
      mode: 'disabled',
      resources: { limits: { memory: '4Gi' } },
    });
    const disabled = deploymentSection(disabledYaml, 'disabled-mode');
    expect(disabled).toContain('memory: 2Gi');
    expect(disabled).not.toContain('memory: 4Gi');

    const enabledYaml = scalarConditionalResourcesComposition.factory('direct').toYaml({
      name: 'enabled-mode',
      mode: 'enabled',
      resources: { limits: { memory: '4Gi' } },
    });
    const enabled = deploymentSection(enabledYaml, 'enabled-mode');
    expect(enabled).toContain('memory: 4Gi');
    expect(enabled).not.toContain('memory: 2Gi');
  });

  it('fails closed when the all-defaults execution omits the guarded resource', () => {
    expect(() => guardedNativeFallbackComposition.factory('kro').toYaml()).toThrow(
      /Cannot prove structured fallback semantics.*Cel\.default/
    );
  });

  it('preserves an explicit fallback when the all-defaults execution omits the resource', () => {
    const yaml = guardedExplicitFallbackComposition.factory('kro').toYaml();
    const compact = yaml.replaceAll(' ', '');

    expect(compact).toContain('includeWhen:');
    expect(compact).toContain(
      'has(schema.spec.resources)&&schema.spec.resources!=null?schema.spec.resources:{"requests":{"cpu":"250m","memory":"1Gi"},"limits":{"memory":"2Gi"}}'
    );
    expect(compact).not.toContain('has(schema.spec.resources)?schema.spec.resources:omit()');
  });

  it('retains an authored optional passthrough on a guarded resource', () => {
    const yaml = guardedOptionalPassthroughComposition.factory('kro').toYaml();
    const compact = yaml.replaceAll(' ', '');

    expect(compact).toContain('has(schema.spec.resources)?schema.spec.resources:omit()');
  });

  it('fails closed for an implicit structured fallback inside a values-merge operand', () => {
    expect(() => mergedNativeFallbackComposition.factory('kro').toYaml()).toThrow(
      /Cannot prove structured fallback semantics.*Cel\.default/
    );
  });

  it('preserves an explicit structured fallback inside a values-merge operand', () => {
    const yaml = mergedExplicitFallbackComposition.factory('kro').toYaml();
    const compact = yaml.replaceAll(' ', '');

    expect(compact).toContain(
      'has(schema.spec.resources)&&schema.spec.resources!=null?schema.spec.resources:{"requests":{"cpu":"250m","memory":"1Gi"},"limits":{"memory":"2Gi"}}'
    );
    expect(compact).toContain('"replicaCount":1');
    expect(compact).not.toContain('has(schema.spec.resources)?schema.spec.resources:omit()');
  });

  it('fails closed for an implicit structured fallback inside a values-merge overlay', () => {
    expect(() => mergedOverlayNativeFallbackComposition.factory('kro').toYaml()).toThrow(
      /Cannot prove structured fallback semantics.*Cel\.default/
    );
  });

  it('does not confuse a normalized-away values merge with a base fallback', () => {
    const yaml = normalizedValuesMergeComposition.factory('kro').toYaml();
    const compact = yaml.replaceAll(' ', '');

    expect(compact).toContain('schema.spec.resources');
    expect(compact).toContain('"replicaCount":1');
  });

  it('fails closed when merge normalization reveals a different fallback branch', () => {
    expect(() => conditionalMergeFallbackComposition.factory('kro').toYaml()).toThrow(
      /Cannot prove structured fallback semantics.*Cel\.default/
    );
  });

  it('fails closed for an optional structured fallback inside a required union', () => {
    expect(() => unionBranchNativeFallbackComposition.factory('kro').toYaml()).toThrow(
      /schema\.spec\.settings\.resources.*Cel\.default/
    );
  });

  it('fails closed for a native fallback on a required nullable structured field', () => {
    expect(() => requiredNullableNativeFallbackComposition.factory('kro').toYaml()).toThrow(
      /schema\.spec\.resources.*Cel\.default/
    );
  });

  it('preserves explicit nullish semantics for a required nullable structured field', () => {
    const yaml = requiredNullableExplicitFallbackComposition.factory('kro').toYaml();
    const compact = yaml.replaceAll(' ', '');

    expect(compact).toContain(
      'has(schema.spec.resources)&&schema.spec.resources!=null?schema.spec.resources:{"requests":{"cpu":"250m","memory":"1Gi"},"limits":{"memory":"2Gi"}}'
    );

    const directYaml = requiredNullableExplicitFallbackComposition.factory('direct').toYaml({
      name: 'nullable-direct',
      resources: null,
    });
    expect(deploymentSection(directYaml, 'nullable-direct')).toContain('cpu: 250m');
  });

  it('probes null independently when an optional structured field is also nullable', () => {
    expect(() => optionalNullableNullBranchComposition.factory('kro').toYaml()).toThrow(
      /schema\.spec\.resources.*Cel\.default/
    );
  });

  it('preserves a structured terminal fallback in a cross-field chain', () => {
    const yaml = structuredChainComposition.factory('kro').toYaml();
    const compact = yaml.replaceAll(' ', '');

    expect(compact).toContain(
      'has(schema.spec.primary)&&schema.spec.primary!=null?schema.spec.primary:(has(schema.spec.secondary)&&schema.spec.secondary!=null?schema.spec.secondary:{"requests":{"cpu":"250m","memory":"1Gi"},"limits":{"memory":"2Gi"}})'
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
