import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import { caddyIngress } from '../../src/factories/caddy/index.js';
import { APISixBootstrapConfigSchema } from '../../src/factories/apisix/types.js';
import { generateKroSchemaFromArktype } from '../../src/core/serialization/schema.js';

/**
 * Regression for the 0.27 strict-CEL break: KRO's CEL type-checker rejects a `float` (double)
 * schema field used where an int is expected — e.g. a Caddy port reference reaching
 * `spec.template.spec.containers[].ports[].containerPort`
 * ("expression schema.spec.httpPort returns type double but expected int").
 *
 * The mapping in `getKroTypeFromJson` is correct as-is (bare arktype `number` → KRO `float`,
 * `number.integer` → KRO `integer`). The fix is that Kubernetes-integral factory fields must
 * DECLARE their integrality via `number.integer` rather than bare `number`. This test locks in
 * that the shipped factory schemas serialize integral fields as KRO `integer`.
 */
describe('factory integer schema fields (strict-CEL)', () => {
  it('preserves ArkType singleton literals and bounded arrays in SimpleSchema', () => {
    const kroSpec = generateKroSchemaFromArktype('literal-contract', {
      apiVersion: 'v1alpha1',
      kind: 'LiteralContract',
      spec: type({
        requiredTrue: 'true',
        requiredFalse: 'false',
        exactNumber: '3',
        values: 'string[] > 0',
      }),
      status: type({ ready: 'boolean' }),
    }).spec as Record<string, unknown>;

    expect(kroSpec.requiredTrue).toBe('boolean | validation="self == true"');
    expect(kroSpec.requiredFalse).toBe('boolean | validation="self == false"');
    expect(kroSpec.exactNumber).toBe('integer | validation="self == 3"');
    expect(kroSpec.values).toBe('[]string | minItems=1');
  });

  it('emits structured field rules through named SimpleSchema types', () => {
    const schema = generateKroSchemaFromArktype(
      'validated-contract',
      {
        apiVersion: 'v1alpha1',
        kind: 'ValidatedContract',
        spec: type({ policy: { enabled: 'boolean', destinations: 'string[]' } }),
        status: type({ ready: 'boolean' }),
      },
      undefined,
      undefined,
      undefined,
      { policy: 'self.enabled && size(self.destinations) > 0' }
    );

    expect(schema.spec.policy).toBe(
      'ValidatedContractPolicy | validation="self.enabled && size(self.destinations) > 0"'
    );
    expect(schema.types?.ValidatedContractPolicy).toEqual({
      enabled: 'boolean',
      destinations: '[]string',
    });
  });

  it('caddy httpPort/httpsPort serialize as KRO integer, not float', () => {
    const yaml = caddyIngress.toYaml();
    expect(yaml).toContain('httpPort: integer');
    expect(yaml).toContain('httpsPort: integer');
    expect(yaml).not.toContain('httpPort: float');
    expect(yaml).not.toContain('httpsPort: float');
    // The CEL reference into an int-typed container/Service port resolves to the integer field.
    expect(yaml).toContain('containerPort: ${schema.spec.httpPort}');
  });

  it('apisix stream port arrays (tcp/udp) serialize as KRO []integer, not []float', () => {
    const kroSpec = generateKroSchemaFromArktype('apisix', {
      apiVersion: 'v1alpha1',
      kind: 'APISix',
      spec: APISixBootstrapConfigSchema,
      status: type({ ready: 'boolean' }),
    }).spec as Record<string, unknown>;
    const gateway = kroSpec.gateway as Record<string, unknown>;
    const stream = gateway.stream as Record<string, unknown>;
    expect(stream.tcp).toBe('[]integer');
    expect(stream.udp).toBe('[]integer');
  });

  it('int-or-string fields (nodePort, rolling-update / PDB limits) reject fractional numbers at validation', () => {
    // Mirrors ory nodePort/maxSurge/maxUnavailable/minAvailable, which use `string | number.integer`
    // (a k8s IntOrString whose numeric branch must be integral). KRO SimpleSchema collapses the union
    // to `object`, so this integrality is enforced at the arktype validation layer.
    const intOrString = type({ 'nodePort?': 'string | number.integer' });
    expect(intOrString({ nodePort: 30000.5 }) instanceof type.errors).toBe(true);
    expect(intOrString({ nodePort: 30000 }) instanceof type.errors).toBe(false);
    expect(intOrString({ nodePort: '30000' }) instanceof type.errors).toBe(false);

    const intArray = type({ 'tcp?': 'number.integer[]' });
    expect(intArray({ tcp: [9000.5] }) instanceof type.errors).toBe(true);
    expect(intArray({ tcp: [9000] }) instanceof type.errors).toBe(false);
  });
});
