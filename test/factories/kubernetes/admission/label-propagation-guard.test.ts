import { describe, expect, test } from 'bun:test';
import { evaluate } from 'cel-js';
import { KRO_OWNERSHIP_LABELS } from '../../../../src/core/kro/labels.js';
import {
  LABEL_PROPAGATION_GUARD_JSON_PATCH_EXPRESSION,
  LABEL_PROPAGATION_GUARD_NAME,
  LABEL_PROPAGATION_GUARD_RESOURCE_RULES,
  labelPropagationGuard,
  labelPropagationGuardPolicySpec,
  serviceAccountUsername,
} from '../../../../src/factories/kubernetes/admission/label-propagation-guard.js';

const OPTIONS = { kroNamespace: 'kro-system' } as const;

// ---------------------------------------------------------------------------
// A tiny CEL harness.
//
// The policy's variables are evaluated in declaration order, each seeing the
// ones before it under `variables`, which is exactly how the API server
// evaluates them. cel-js covers the subset the guard uses (`has`, `in`,
// `filter`, ternaries); the JSONPatch construction and `jsonpatch.escapeKey`
// are API-server extensions and are asserted structurally instead, with the
// end-to-end behaviour proved in test/integration/kro-label-propagation-guard.
// ---------------------------------------------------------------------------
interface AdmissionContext {
  object: unknown;
  oldObject: unknown;
  request: { operation: 'CREATE' | 'UPDATE'; resource: { group: string; resource: string } };
}

function evaluateGuardVariables(context: AdmissionContext): Record<string, unknown> {
  const spec = labelPropagationGuardPolicySpec(OPTIONS);
  const variables: Record<string, unknown> = {};
  for (const variable of spec.variables ?? []) {
    variables[variable.name] = evaluate(variable.expression, { ...context, variables });
  }
  return variables;
}

function createContext(
  resource: { group: string; resource: string },
  object: unknown
): AdmissionContext {
  return { object, oldObject: null, request: { operation: 'CREATE', resource } };
}

function updateContext(
  resource: { group: string; resource: string },
  oldObject: unknown,
  object: unknown
): AdmissionContext {
  return { object, oldObject, request: { operation: 'UPDATE', resource } };
}

const CONFIGMAPS = { group: '', resource: 'configmaps' };
const SERVICES = { group: '', resource: 'services' };
const DEPLOYMENTS = { group: 'apps', resource: 'deployments' };

describe('labelPropagationGuard — rendered resources', () => {
  test('renders exactly one policy and one binding that reference each other', () => {
    const guard = labelPropagationGuard(OPTIONS);

    expect(guard.policy.kind).toBe('MutatingAdmissionPolicy');
    expect(guard.binding.kind).toBe('MutatingAdmissionPolicyBinding');
    expect(guard.policy.metadata.name).toBe(LABEL_PROPAGATION_GUARD_NAME);
    expect(guard.binding.spec.policyName).toBe(LABEL_PROPAGATION_GUARD_NAME);
    expect(guard.policy.apiVersion).toBe('admissionregistration.k8s.io/v1');
    expect(guard.binding.apiVersion).toBe('admissionregistration.k8s.io/v1');
  });

  test('renders the beta group version when asked', () => {
    const guard = labelPropagationGuard({
      ...OPTIONS,
      apiVersion: 'admissionregistration.k8s.io/v1beta1',
    });
    expect(guard.policy.apiVersion).toBe('admissionregistration.k8s.io/v1beta1');
    expect(guard.binding.apiVersion).toBe('admissionregistration.k8s.io/v1beta1');
  });

  test('the binding carries no paramRef and no narrowing matchResources', () => {
    // Read through JSON: Enhanced resources hand back a magic proxy for any
    // property, so `toBeUndefined()` on a missing field would never fire.
    const rendered = JSON.parse(JSON.stringify(labelPropagationGuard(OPTIONS).binding));
    expect(Object.keys(rendered.spec)).toEqual(['policyName']);
  });
});

describe('labelPropagationGuard — policy spec', () => {
  const spec = labelPropagationGuardPolicySpec(OPTIONS);

  test('fails open', () => {
    // A broken guard must never block a write.
    expect(spec.failurePolicy).toBe('Ignore');
  });

  test('re-runs after mutating webhooks', () => {
    expect(spec.reinvocationPolicy).toBe('IfNeeded');
  });

  test('matches CREATE and UPDATE on the documented kinds', () => {
    const rules = spec.matchConstraints?.resourceRules ?? [];
    expect(rules).toHaveLength(LABEL_PROPAGATION_GUARD_RESOURCE_RULES.length);
    for (const rule of rules) {
      expect(rule.operations).toEqual(['CREATE', 'UPDATE']);
    }
    const resources = rules.flatMap((rule) => rule.resources ?? []);
    expect(resources.sort()).toEqual(
      [
        'configmaps',
        'deployments',
        'persistentvolumeclaims',
        'poddisruptionbudgets',
        'secrets',
        'services',
        'statefulsets',
      ].sort()
    );
  });

  test('exempts the KRO controller ServiceAccount computed from the bootstrap', () => {
    expect(spec.matchConditions).toHaveLength(1);
    const expression = spec.matchConditions?.[0]?.expression ?? '';
    expect(expression).toContain('system:serviceaccount:kro-system:kro');
    // The condition must be a negated membership test: the policy applies only
    // when the caller is NOT exempt.
    expect(expression).toStartWith('!(request.userInfo.username in [');
  });

  test('honours a non-default KRO namespace and ServiceAccount, plus extra callers', () => {
    const expression =
      labelPropagationGuardPolicySpec({
        kroNamespace: 'platform',
        kroServiceAccount: 'kro-controller',
        additionalExemptCallers: ['system:serviceaccount:ops:migrator'],
      }).matchConditions?.[0]?.expression ?? '';

    expect(expression).toContain(serviceAccountUsername('platform', 'kro-controller'));
    expect(expression).toContain('system:serviceaccount:ops:migrator');
    expect(expression).not.toContain('kro-system');
  });

  test('emits exactly one JSONPatch mutation', () => {
    expect(spec.mutations).toHaveLength(1);
    expect(spec.mutations[0]?.patchType).toBe('JSONPatch');
    expect(spec.mutations[0]?.jsonPatch?.expression).toBe(
      LABEL_PROPAGATION_GUARD_JSON_PATCH_EXPRESSION
    );
    expect(spec.mutations[0]?.applyConfiguration).toBeUndefined();
  });

  test('the guarded list is exactly KRO_OWNERSHIP_LABELS', () => {
    const guarded = spec.variables?.find((variable) => variable.name === 'guardedLabels');
    expect(guarded).toBeDefined();
    expect(evaluate(guarded?.expression ?? '', {})).toEqual([...KRO_OWNERSHIP_LABELS]);
  });
});

describe('labelPropagationGuard — JSONPatch expression', () => {
  test('removes only, and escapes every key as a JSON pointer segment', () => {
    const expression = LABEL_PROPAGATION_GUARD_JSON_PATCH_EXPRESSION;
    // Every ownership label contains a `/`, so an unescaped key would address
    // the wrong pointer entirely.
    const escapeCalls = expression.match(/jsonpatch\.escapeKey\(k\)/g) ?? [];
    expect(escapeCalls).toHaveLength(4);
    expect(expression).not.toContain('"add"');
    expect(expression).not.toContain('"replace"');
    expect(expression.match(/op: "remove"/g)).toHaveLength(4);
  });

  test('patches the four documented paths', () => {
    for (const path of [
      '"/metadata/labels/"',
      '"/spec/selector/"',
      '"/spec/selector/matchLabels/"',
      '"/spec/template/metadata/labels/"',
    ]) {
      expect(LABEL_PROPAGATION_GUARD_JSON_PATCH_EXPRESSION).toContain(path);
    }
  });

  test('every patch is driven by a filtered strip list, never by the raw label set', () => {
    // This is what keeps `remove` from ever targeting a missing path.
    for (const strip of [
      'variables.metadataStrip',
      'variables.serviceSelectorStrip',
      'variables.matchLabelsStrip',
      'variables.templateStrip',
    ]) {
      expect(LABEL_PROPAGATION_GUARD_JSON_PATCH_EXPRESSION).toContain(`${strip}.map(k,`);
    }
    expect(LABEL_PROPAGATION_GUARD_JSON_PATCH_EXPRESSION).not.toContain('guardedLabels.map(');
  });
});

describe('labelPropagationGuard — CREATE rule', () => {
  test('strips every ownership label present on a created object', () => {
    const variables = evaluateGuardVariables(
      createContext(CONFIGMAPS, {
        metadata: {
          labels: {
            app: 'cache',
            'kro.run/owned': 'true',
            'applyset.kubernetes.io/part-of': 'applyset-abc',
          },
        },
      })
    );
    expect(variables.metadataStrip).toEqual(['applyset.kubernetes.io/part-of', 'kro.run/owned']);
  });

  test('strips nothing when the object carries none of them', () => {
    const variables = evaluateGuardVariables(
      createContext(CONFIGMAPS, { metadata: { labels: { app: 'cache' } } })
    );
    expect(variables.metadataStrip).toEqual([]);
  });

  test('tolerates an object with no labels at all', () => {
    const variables = evaluateGuardVariables(createContext(CONFIGMAPS, { metadata: {} }));
    expect(variables.newLabels).toEqual({});
    expect(variables.metadataStrip).toEqual([]);
  });
});

describe('labelPropagationGuard — UPDATE rule', () => {
  test('KEEPS a label KRO already placed when a non-KRO caller updates the object', () => {
    // A human annotating, Flux patching, an HPA scaling — all legitimate
    // non-KRO UPDATEs. Stripping here would start a flapping war with KRO.
    const labels = { app: 'cache', 'kro.run/owned': 'true' };
    const variables = evaluateGuardVariables(
      updateContext(
        CONFIGMAPS,
        { metadata: { labels } },
        { metadata: { labels }, data: { touched: 'yes' } }
      )
    );
    expect(variables.metadataStrip).toEqual([]);
  });

  test('STRIPS a label the caller is introducing on UPDATE', () => {
    // An operator that re-copies the parent label map on every reconcile.
    const variables = evaluateGuardVariables(
      updateContext(
        CONFIGMAPS,
        { metadata: { labels: { app: 'cache' } } },
        { metadata: { labels: { app: 'cache', 'kro.run/node-id': 'cache' } } }
      )
    );
    expect(variables.metadataStrip).toEqual(['kro.run/node-id']);
  });

  test('keeps the old label and strips the new one in the same request', () => {
    const variables = evaluateGuardVariables(
      updateContext(
        CONFIGMAPS,
        { metadata: { labels: { 'kro.run/owned': 'true' } } },
        {
          metadata: {
            labels: { 'kro.run/owned': 'true', 'applyset.kubernetes.io/id': 'applyset-xyz' },
          },
        }
      )
    );
    expect(variables.metadataStrip).toEqual(['applyset.kubernetes.io/id']);
  });

  test('a changed VALUE on an already-present label is not a strip', () => {
    // KRO upgrades rewrite kro.run/kro-version. The key was already there, so
    // the caller is not introducing it and the guard leaves it alone.
    const variables = evaluateGuardVariables(
      updateContext(
        CONFIGMAPS,
        { metadata: { labels: { 'kro.run/kro-version': '0.9.2' } } },
        { metadata: { labels: { 'kro.run/kro-version': '0.9.3' } } }
      )
    );
    expect(variables.metadataStrip).toEqual([]);
  });
});

describe('labelPropagationGuard — Service selector', () => {
  test('strips ownership labels from a created Service selector', () => {
    const variables = evaluateGuardVariables(
      createContext(SERVICES, {
        metadata: { labels: { 'kro.run/owned': 'true' } },
        spec: { selector: { app: 'cache', 'kro.run/owned': 'true' } },
      })
    );
    expect(variables.serviceSelectorStrip).toEqual(['kro.run/owned']);
    expect(variables.metadataStrip).toEqual(['kro.run/owned']);
  });

  test('leaves a selector key the caller did not introduce', () => {
    const selector = { app: 'cache', 'kro.run/owned': 'true' };
    const variables = evaluateGuardVariables(
      updateContext(SERVICES, { spec: { selector } }, { spec: { selector } })
    );
    expect(variables.serviceSelectorStrip).toEqual([]);
  });

  test('does not treat a workload selector as a Service selector', () => {
    // A Deployment's spec.selector is a LabelSelector, not a label map.
    const variables = evaluateGuardVariables(
      createContext(DEPLOYMENTS, {
        spec: { selector: { matchLabels: { app: 'cache', 'kro.run/owned': 'true' } } },
      })
    );
    expect(variables.isService).toBe(false);
    expect(variables.serviceSelectorStrip).toEqual([]);
    expect(variables.matchLabelsStrip).toEqual(['kro.run/owned']);
  });

  test('a Service with no selector produces no patch', () => {
    const variables = evaluateGuardVariables(
      createContext(SERVICES, { metadata: {}, spec: { ports: [] } })
    );
    expect(variables.serviceSelectorStrip).toEqual([]);
  });
});

describe('labelPropagationGuard — workload pod template', () => {
  test('strips the pod template labels and the matching selector together', () => {
    // Stripping only the template would leave `selector does not match template
    // labels` and the create would be rejected.
    const variables = evaluateGuardVariables(
      createContext(DEPLOYMENTS, {
        spec: {
          selector: { matchLabels: { app: 'cache', 'kro.run/node-id': 'cache' } },
          template: { metadata: { labels: { app: 'cache', 'kro.run/node-id': 'cache' } } },
        },
      })
    );
    expect(variables.matchLabelsStrip).toEqual(['kro.run/node-id']);
    expect(variables.templateStrip).toEqual(['kro.run/node-id']);
  });

  test('a workload UPDATE that re-copies the labels into the template is stripped', () => {
    const variables = evaluateGuardVariables(
      updateContext(
        DEPLOYMENTS,
        { spec: { template: { metadata: { labels: { app: 'cache' } } } } },
        {
          spec: {
            template: {
              metadata: { labels: { app: 'cache', 'kro.run/kro-version': '0.9.3' } },
            },
          },
        }
      )
    );
    expect(variables.templateStrip).toEqual(['kro.run/kro-version']);
  });

  test('a ConfigMap never touches the workload paths', () => {
    const variables = evaluateGuardVariables(
      createContext(CONFIGMAPS, { metadata: { labels: { 'kro.run/owned': 'true' } } })
    );
    expect(variables.isWorkload).toBe(false);
    expect(variables.templateStrip).toEqual([]);
    expect(variables.matchLabelsStrip).toEqual([]);
    expect(variables.serviceSelectorStrip).toEqual([]);
  });
});
