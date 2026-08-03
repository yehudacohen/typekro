import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import {
  artifactOutput,
  decodePlanValue,
  emitExpressionCel,
  encodePlanValue,
  evaluateExpressionIR,
  expressionIR,
  externalInput,
  lowerPlanValue,
  materializePlanOutputs,
  materializePlanValue,
  planExpression,
  resolveStaticYamlSensitiveBindings,
  schemaToIR,
  sensitiveValue,
} from '../../../src/core/planning/index.js';
import { createSchemaProxy } from '../../../src/core/references/schema-proxy.js';

describe('PlanValue and ExpressionIR', () => {
  it('preserves arrays, object order independence, and omitted values', () => {
    const lowered = lowerPlanValue({ z: [1, undefined, { b: true }], a: null });
    const encoded = encodePlanValue(lowered.value);

    expect(lowered.diagnostics).toEqual([]);
    expect(decodePlanValue(encoded)).toEqual(lowered.value);
    expect(encoded).toContain('"kind":"omitted"');
    expect(encoded.indexOf('"key":"a"')).toBeLessThan(encoded.indexOf('"key":"z"'));
  });

  it('serializes opaque bindings without leaking plaintext', () => {
    const plaintext = 'super-secret-password';
    const lowered = lowerPlanValue({
      password: sensitiveValue('registry-password', '4'),
      environment: externalInput('environment'),
      image: artifactOutput('container-build', 'image'),
    });
    const encoded = encodePlanValue(lowered.value);

    expect(lowered.sensitivity).toBe('sensitive');
    expect(encoded).toContain('registry-password');
    expect(encoded).not.toContain(plaintext);
    expect(JSON.stringify(lowered.value)).not.toContain(plaintext);
  });

  it('requires explicit and complete bindings at the static YAML boundary', () => {
    expect(() =>
      resolveStaticYamlSensitiveBindings(
        ['registry-password'],
        { 'registry-password': 'secret' },
        undefined,
        'fixture YAML'
      )
    ).toThrow('requires explicit plaintext materialization');

    expect(() =>
      resolveStaticYamlSensitiveBindings(
        ['registry-password', 'registry-token'],
        { 'registry-password': 'secret' },
        { allowSensitiveMaterialization: true },
        'fixture YAML'
      )
    ).toThrow('registry-token');

    expect(
      resolveStaticYamlSensitiveBindings(
        ['registry-password', 'registry-token'],
        { 'registry-password': 'secret' },
        {
          allowSensitiveMaterialization: true,
          sensitiveBindings: { 'registry-token': 'token' },
        },
        'fixture YAML'
      )
    ).toEqual({ 'registry-password': 'secret', 'registry-token': 'token' });
  });

  it('rejects unsupported runtime values in strict mode', () => {
    expect(() => lowerPlanValue({ callback: () => true }, { strict: true })).toThrow(
      'Plan value lowering failed'
    );
  });

  it('extracts references and uses one expression for CEL emission and direct evaluation', async () => {
    const expression = expressionIR('deployment.status.readyReplicas >= 2');

    expect(expression.references).toEqual([
      {
        source: 'resource',
        resourceId: 'deployment',
        fieldPath: 'status.readyReplicas',
      },
    ]);
    expect(emitExpressionCel(expression)).toBe(expression.expression);
    await expect(
      evaluateExpressionIR(expression, {
        resources: new Map([['deployment', { status: { readyReplicas: 3 } }]]),
      })
    ).resolves.toBe(true);
  });

  it('evaluates optional CEL presence without dereferencing absent members', () => {
    const value = {
      kind: 'expression' as const,
      expression: expressionIR('!(has(schema.spec.enabled)) || schema.spec.enabled != false'),
    };

    expect(materializePlanValue(value, { spec: {} })).toBe(true);
    expect(materializePlanValue(value, { spec: { enabled: true } })).toBe(true);
    expect(materializePlanValue(value, { spec: { enabled: false } })).toBe(false);
  });

  it('treats KRO dyn type widening as identity during portable direct materialization', () => {
    const value = {
      kind: 'expression' as const,
      expression: expressionIR(
        'has(schema.spec.repositoryName) && dyn(schema.spec.repositoryName) != null ? schema.spec.repositoryName : "envoyproxy-helm"'
      ),
    };

    expect(materializePlanValue(value, { spec: {} })).toBe('envoyproxy-helm');
    expect(
      materializePlanValue(value, {
        spec: { repositoryName: 'custom-repository' },
      })
    ).toBe('custom-repository');
  });

  it('hydrates composition outputs from live resources without re-running the closure', () => {
    const outputs = {
      endpoint: {
        kind: 'expression' as const,
        expression: expressionIR(
          'has(gateway.status.addresses) && size(gateway.status.addresses) > 0 ? "http://" + string(gateway.status.addresses[0].value) + ":" + string(gateway.spec.listeners[0].port) : ""'
        ),
      },
      observedName: {
        kind: 'reference' as const,
        source: 'resource' as const,
        resourceId: 'gateway',
        fieldPath: 'metadata.name',
      },
      advertised: {
        kind: 'template' as const,
        segments: [
          { kind: 'literal' as const, value: 'gateway=' },
          {
            kind: 'reference' as const,
            source: 'resource' as const,
            resourceId: 'gateway',
            fieldPath: 'metadata.name',
          },
        ],
      },
    };

    expect(
      materializePlanOutputs(outputs, {
        resources: {
          gateway: {
            metadata: { name: 'inference' },
            spec: { listeners: [{ port: 8080 }] },
            status: { addresses: [{ value: '10.0.0.12' }] },
          },
        },
      })
    ).toEqual({
      advertised: 'gateway=inference',
      endpoint: 'http://10.0.0.12:8080',
      observedName: 'inference',
    });
  });

  it('hydrates resource-backed template expressions from complete live bindings', () => {
    const value = {
      kind: 'template' as const,
      segments: [
        { kind: 'literal' as const, value: 'replicas=' },
        {
          kind: 'expression' as const,
          expression: expressionIR('string(deployment.status.readyReplicas)'),
        },
      ],
    };

    expect(
      materializePlanValue(value, {
        resources: {
          deployment: { status: { readyReplicas: 3 } },
        },
      })
    ).toBe('replicas=3');
  });

  it('fails closed when a complete live-resource binding omits a required producer', () => {
    const required = {
      kind: 'reference' as const,
      source: 'resource' as const,
      resourceId: 'deployment',
      fieldPath: 'status.readyReplicas',
    };
    const expressionTemplate = {
      kind: 'template' as const,
      segments: [
        {
          kind: 'expression' as const,
          expression: expressionIR('string(deployment.status.readyReplicas)'),
        },
      ],
    };
    const expression = {
      kind: 'expression' as const,
      expression: expressionIR('deployment.status.readyReplicas'),
    };

    expect(() => materializePlanValue(required, { resources: {} })).toThrow(
      'Required resource binding deployment'
    );
    expect(() => materializePlanValue(expression, { resources: {} })).toThrow(
      'Required resource binding deployment'
    );
    expect(() => materializePlanValue(expressionTemplate, { resources: {} })).toThrow(
      'Required resource binding deployment'
    );
  });

  it('omits optional resource references absent from complete live bindings', () => {
    const optional = {
      kind: 'reference' as const,
      source: 'resource' as const,
      resourceId: 'optionalService',
      fieldPath: 'status.endpoint',
      optional: true as const,
    };
    const template = {
      kind: 'template' as const,
      segments: [{ kind: 'literal' as const, value: 'endpoint=' }, optional],
    };

    expect(materializePlanValue(optional, { resources: {} })).toBeUndefined();
    expect(materializePlanValue(template, { resources: {} })).toBeUndefined();
  });

  it('fails closed on missing spec bindings during concrete template hydration', () => {
    const referenceTemplate = {
      kind: 'template' as const,
      segments: [
        { kind: 'literal' as const, value: 'label=' },
        {
          kind: 'reference' as const,
          source: 'spec' as const,
          fieldPath: 'label',
        },
      ],
    };
    const expressionTemplate = {
      kind: 'template' as const,
      segments: [
        { kind: 'literal' as const, value: 'label=' },
        {
          kind: 'expression' as const,
          expression: expressionIR('string(schema.spec.label)'),
        },
      ],
    };

    expect(() => materializePlanValue(referenceTemplate, { resources: {} })).toThrow(
      'Spec binding is required to resolve label'
    );
    expect(() => materializePlanValue(expressionTemplate, { resources: {} })).toThrow(
      'Spec binding is required to evaluate string(schema.spec.label)'
    );
  });

  it('omits optional spec template references during concrete hydration without spec bindings', () => {
    const template = {
      kind: 'template' as const,
      segments: [
        { kind: 'literal' as const, value: 'label=' },
        {
          kind: 'reference' as const,
          source: 'spec' as const,
          fieldPath: 'label',
          optional: true as const,
        },
      ],
    };

    expect(materializePlanValue(template, { resources: {} })).toBeUndefined();
  });

  it('preserves resource references when live bindings are not supplied', () => {
    const value = {
      kind: 'reference' as const,
      source: 'resource' as const,
      resourceId: 'service',
      fieldPath: 'metadata.name',
    };

    expect(materializePlanValue(value)).toEqual(
      expect.objectContaining({
        resourceId: 'service',
        fieldPath: 'metadata.name',
      })
    );
  });

  it('derives references from parsed CEL rather than matching text inside literals', () => {
    const expression = expressionIR(
      '"deployment.status.notAReference" + schema.spec.name + service.metadata.name'
    );

    expect(expression.references).toEqual([
      { source: 'resource', resourceId: 'service', fieldPath: 'metadata.name' },
      { source: 'spec', fieldPath: 'name' },
    ]);
    expect(expression.sourceLocation).toEqual({ line: 1, column: 1 });
  });

  it('accepts analyzer-owned references and source locations as semantic authority', () => {
    const references = [
      { source: 'resource' as const, resourceId: 'backend', fieldPath: 'status.url' },
    ];
    const expression = expressionIR('opaqueCompilerExpression()', {
      references,
      sourceLocation: { file: 'fixture.ts', line: 12, column: 7 },
    });

    expect(expression.references).toEqual(references);
    expect(expression.sourceLocation).toEqual({ file: 'fixture.ts', line: 12, column: 7 });
    expect(decodePlanValue(encodePlanValue(planExpression(expression)))).toEqual(
      expect.objectContaining({ kind: 'expression', expression })
    );
  });

  it('rejects raw CEL in the portable direct evaluator', async () => {
    const expression = expressionIR('resource.status.phase == "Ready"', {
      language: 'raw-cel',
    });

    await expect(evaluateExpressionIR(expression, { resources: new Map() })).rejects.toThrow(
      'cannot be evaluated as a portable direct expression'
    );
  });

  it('propagates expression sensitivity through PlanValue lowering', () => {
    const lowered = lowerPlanValue(
      planExpression(
        expressionIR('secrets.password + "-suffix"', {
          sensitivity: 'sensitive',
        })
      )
    );

    expect(lowered.sensitivity).toBe('sensitive');
    expect(lowered.value).toEqual(
      expect.objectContaining({
        kind: 'expression',
        expression: expect.objectContaining({ sensitivity: 'sensitive' }),
      })
    );
  });

  it('validates decoded expression structure', () => {
    expect(() => decodePlanValue('{"kind":"expression","expression":{"version":2}}')).toThrow(
      'Invalid expression'
    );
  });

  it('rejects plaintext nested anywhere beneath a sensitive taint wrapper', () => {
    expect(() =>
      decodePlanValue(
        JSON.stringify({
          kind: 'sensitive-value',
          value: {
            kind: 'object',
            entries: [
              {
                key: 'nested',
                value: {
                  kind: 'array',
                  items: [{ kind: 'literal', value: 'plaintext' }],
                },
              },
            ],
          },
        })
      )
    ).toThrow('cannot contain plaintext literals');
  });

  it('allows public template framing beneath a sensitive taint wrapper', () => {
    const value = {
      kind: 'sensitive-value' as const,
      value: {
        kind: 'template' as const,
        segments: [
          { kind: 'literal' as const, value: 'Bearer ' },
          {
            kind: 'reference' as const,
            source: 'spec' as const,
            fieldPath: 'token',
          },
        ],
      },
    };

    expect(decodePlanValue(encodePlanValue(value))).toEqual(value);
  });

  it('round-trips expression-bearing template segments through the canonical codec', () => {
    const value = {
      kind: 'template' as const,
      segments: [
        { kind: 'literal' as const, value: 'app-' },
        {
          kind: 'expression' as const,
          expression: expressionIR('schema.spec.name'),
        },
      ],
    };

    expect(decodePlanValue(encodePlanValue(value))).toEqual(value);
  });

  it('round-trips nested-composition origin on references and template segments', () => {
    const value = {
      kind: 'array' as const,
      items: [
        {
          kind: 'reference' as const,
          source: 'resource' as const,
          resourceId: 'nestedService',
          fieldPath: 'status.ready',
          nestedComposition: true as const,
        },
        {
          kind: 'template' as const,
          segments: [
            { kind: 'literal' as const, value: 'https://' },
            {
              kind: 'reference' as const,
              source: 'resource' as const,
              resourceId: 'nestedService',
              fieldPath: 'status.hostname',
              nestedComposition: true as const,
            },
          ],
        },
      ],
    };

    expect(decodePlanValue(encodePlanValue(value))).toEqual(value);
  });

  it('preserves schema optionality through proxy lowering and canonical round trips', () => {
    const specSchema = type({
      name: 'string',
      'namespace?': 'string',
      'config?': {
        required: 'string',
        'suffix?': 'string',
      },
    });
    const schema = createSchemaProxy<
      {
        name: string;
        namespace?: string;
        config?: { required: string; suffix?: string };
      },
      Record<string, never>
    >(specSchema.json);
    const lowered = lowerPlanValue(
      {
        name: schema.spec.name,
        namespace: schema.spec.namespace,
        nestedRequired: schema.spec.config?.required,
        nestedOptional: schema.spec.config?.suffix,
        hostname: `app-${schema.spec.namespace}`,
      },
      { specSchema: schemaToIR(specSchema) }
    );
    const decoded = decodePlanValue(encodePlanValue(lowered.value));

    expect(decoded).toEqual(lowered.value);
    expect(decoded).toEqual({
      kind: 'object',
      entries: [
        {
          key: 'hostname',
          value: {
            kind: 'template',
            segments: [
              { kind: 'literal', value: 'app-' },
              {
                kind: 'reference',
                source: 'spec',
                fieldPath: 'namespace',
                optional: true,
              },
            ],
          },
        },
        {
          key: 'name',
          value: { kind: 'reference', source: 'spec', fieldPath: 'name' },
        },
        {
          key: 'namespace',
          value: {
            kind: 'reference',
            source: 'spec',
            fieldPath: 'namespace',
            optional: true,
          },
        },
        {
          key: 'nestedOptional',
          value: {
            kind: 'reference',
            source: 'spec',
            fieldPath: 'config.suffix',
            optional: true,
          },
        },
        {
          key: 'nestedRequired',
          value: {
            kind: 'reference',
            source: 'spec',
            fieldPath: 'config.required',
            optional: true,
          },
        },
      ],
    });
  });

  it('omits absent optional references without weakening required-path failures', () => {
    const value = {
      kind: 'object' as const,
      entries: [
        {
          key: 'name',
          value: { kind: 'reference' as const, source: 'spec' as const, fieldPath: 'name' },
        },
        {
          key: 'namespace',
          value: {
            kind: 'reference' as const,
            source: 'spec' as const,
            fieldPath: 'namespace',
            optional: true as const,
          },
        },
        {
          key: 'hostname',
          value: {
            kind: 'template' as const,
            segments: [
              { kind: 'literal' as const, value: 'app-' },
              {
                kind: 'reference' as const,
                source: 'spec' as const,
                fieldPath: 'namespace',
                optional: true as const,
              },
            ],
          },
        },
      ],
    };

    expect(materializePlanValue(value, { spec: { name: 'demo' } })).toEqual({ name: 'demo' });
    expect(materializePlanValue(value, { spec: { name: 'demo', namespace: 'apps' } })).toEqual({
      name: 'demo',
      namespace: 'apps',
      hostname: 'app-apps',
    });
    expect(() => materializePlanValue(value, { spec: {} })).toThrow(
      'Declared spec reference name is not present'
    );
  });

  it('rejects invalid nested-composition origin metadata', () => {
    expect(() =>
      decodePlanValue(
        JSON.stringify({
          kind: 'reference',
          source: 'resource',
          resourceId: 'nestedService',
          fieldPath: 'status.ready',
          nestedComposition: false,
        })
      )
    ).toThrow('Invalid reference');
    expect(() =>
      decodePlanValue(
        JSON.stringify({
          kind: 'reference',
          source: 'spec',
          fieldPath: 'name',
          nestedComposition: true,
        })
      )
    ).toThrow('Invalid reference');
    expect(() =>
      decodePlanValue(
        JSON.stringify({
          kind: 'reference',
          source: 'spec',
          fieldPath: 'namespace',
          optional: false,
        })
      )
    ).toThrow('Invalid reference');
  });

  it('rejects non-canonical object order and incomplete resource references', () => {
    expect(() =>
      decodePlanValue(
        JSON.stringify({
          kind: 'object',
          entries: [
            { key: 'z', value: { kind: 'literal', value: true } },
            { key: 'a', value: { kind: 'literal', value: false } },
          ],
        })
      )
    ).toThrow('canonically sorted keys');
    expect(() =>
      decodePlanValue(
        JSON.stringify({ kind: 'reference', source: 'resource', fieldPath: 'status.ready' })
      )
    ).toThrow('Invalid reference');
  });
});
