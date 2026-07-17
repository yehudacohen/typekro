import { describe, expect, it } from 'bun:test';
import { caddyIngress } from '../../src/factories/caddy/index.js';

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
  it('caddy httpPort/httpsPort serialize as KRO integer, not float', () => {
    const yaml = caddyIngress.toYaml();
    expect(yaml).toContain('httpPort: integer');
    expect(yaml).toContain('httpsPort: integer');
    expect(yaml).not.toContain('httpPort: float');
    expect(yaml).not.toContain('httpsPort: float');
    // The CEL reference into an int-typed container/Service port resolves to the integer field.
    expect(yaml).toContain('containerPort: ${schema.spec.httpPort}');
  });
});
