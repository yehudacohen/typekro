/**
 * Regression test: multiline strings in CEL conditionals must be
 * properly escaped. Found when SearXNG's settingsYaml (containing
 * newlines) broke CEL parsing in KRO mode because celValueRepr
 * didn't escape \n characters.
 */

import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import { kubernetesComposition } from '../../src/core/composition/imperative.js';
import { configMap } from '../../src/factories/kubernetes/config/config-map.js';

describe('CEL multiline string escaping', () => {
  it('escapes newlines in string values used in CEL conditionals', () => {
    // Create a composition where a multiline string appears in a
    // conditional branch (ternary on an optional spec field).
    // This is the exact pattern that broke SearXNG in KRO mode.
    const comp = kubernetesComposition(
      {
        name: 'multiline-test',
        kind: 'MultilineTest',
        spec: type({
          name: 'string',
          'customConfig?': 'string',
        }),
        status: type({ ready: 'boolean' }),
      },
      (spec) => {
        const defaultConfig = `key1: value1
key2: value2
key3: value3`;

        // Use a ternary — this is the pattern that triggers
        // buildCelConditional → celValueRepr in KRO mode.
        // The nullish coalescing (??) resolves differently.
        const configValue = spec.customConfig
          ? spec.customConfig
          : defaultConfig;

        configMap({
          metadata: { name: spec.name, namespace: 'default' },
          data: { 'config.yaml': configValue },
          id: 'config',
        });

        return { ready: true };
      }
    );

    // Generate KRO YAML — this is where the CEL conditional is emitted.
    // If newlines aren't escaped, the KRO controller rejects the RGD
    // with a CEL parse error.
    const yaml = (comp as any).toYaml();
    expect(yaml).toBeDefined();
    expect(typeof yaml).toBe('string');

    // The YAML should NOT contain raw newlines inside CEL string
    // literals. Look for the pattern: a CEL string with literal
    // newlines (not escaped \n).
    // Find any CEL conditional containing a multiline value
    const celConditionals = yaml.match(/has\(schema\.spec\.[^)]+\)\s*\?\s*"[^"]*"/g) || [];
    for (const cel of celConditionals) {
      // Extract the string literal content (between quotes)
      const stringContent = cel.match(/"([^"]*)"/)?.[1] ?? '';
      // Raw newlines should be escaped as \\n, not literal \n
      expect(stringContent).not.toContain('\n');
    }

    // The escaped version should be in there
    expect(yaml).toContain('\\n');
  });
});
