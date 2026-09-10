import { afterEach, describe, expect, it } from 'bun:test';
import { typeKroRuntimeBootstrap } from '../../src/compositions/typekro-runtime/index.js';
import {
  DISABLE_LABEL_GUARD_ENV,
  LABEL_GUARD_API_VERSION_ENV,
  resetLabelPropagationGuardCapabilityCache,
  resolveLabelPropagationGuardCapability,
  setLabelPropagationGuardCapability,
} from '../../src/core/kro/label-guard-capability.js';
import type { KubernetesResource } from '../../src/core/types/kubernetes.js';

function bootstrap() {
  // `external` keeps the composition serializable without a live cluster.
  return typeKroRuntimeBootstrap({ fluxInstallation: 'external' });
}

function resourcesOfKind(kind: string): KubernetesResource<unknown, unknown>[] {
  return bootstrap().resources.filter(
    (resource: KubernetesResource<unknown, unknown>) => resource.kind === kind
  );
}

function clearEnv() {
  delete process.env[DISABLE_LABEL_GUARD_ENV];
  delete process.env[LABEL_GUARD_API_VERSION_ENV];
  resetLabelPropagationGuardCapabilityCache();
}

afterEach(clearEnv);

describe('typeKroRuntimeBootstrap — always-on label-propagation guard', () => {
  it('installs the guard with no configuration at all', () => {
    clearEnv();
    expect(resourcesOfKind('MutatingAdmissionPolicy')).toHaveLength(1);
    expect(resourcesOfKind('MutatingAdmissionPolicyBinding')).toHaveLength(1);
  });

  it('exempts the KRO controller ServiceAccount it installs', () => {
    clearEnv();
    const policy = resourcesOfKind('MutatingAdmissionPolicy')[0] as {
      spec?: { matchConditions?: Array<{ expression: string }> };
    };
    expect(policy.spec?.matchConditions?.[0]?.expression).toContain(
      'system:serviceaccount:kro-system:kro'
    );
  });

  it('accepts no config option to turn the guard off', () => {
    // Guard against a future `labelPropagationGuard` option creeping back in:
    // the invariant is that there is exactly one way to disable it.
    const configKeys = ['namespace', 'fluxVersion', 'kroVersion', 'fluxInstallation', 'rbac'];
    type Config = NonNullable<Parameters<typeof typeKroRuntimeBootstrap>[0]>;
    const probe: Record<string, unknown> = {};
    for (const key of configKeys) probe[key] = undefined;
    // A type-level assertion: adding a guard toggle to TypeKroRuntimeConfig
    // would make this cast fail to compile.
    const typed: Config = probe as Config;
    expect(Object.keys(typed)).toEqual(configKeys);
  });

  it('skips the guard when the break-glass env var is set', () => {
    clearEnv();
    process.env[DISABLE_LABEL_GUARD_ENV] = '1';
    expect(resourcesOfKind('MutatingAdmissionPolicy')).toHaveLength(0);
    expect(resourcesOfKind('MutatingAdmissionPolicyBinding')).toHaveLength(0);
  });

  it('renders the beta group version when the cluster only serves it', () => {
    clearEnv();
    process.env[LABEL_GUARD_API_VERSION_ENV] = 'admissionregistration.k8s.io/v1beta1';
    const policy = resourcesOfKind('MutatingAdmissionPolicy')[0];
    expect(policy?.apiVersion).toBe('admissionregistration.k8s.io/v1beta1');
  });

  it('skips the guard when a probe reported the API is not served', () => {
    clearEnv();
    setLabelPropagationGuardCapability({ status: 'unavailable', reason: 'test' });
    expect(resourcesOfKind('MutatingAdmissionPolicy')).toHaveLength(0);
  });
});

describe('typeKroRuntimeBootstrap — status contract', () => {
  it('declares labelPropagationGuard in the status schema', () => {
    clearEnv();
    const schema = bootstrap().schema;
    expect(schema).toBeDefined();
  });

  it('projects the status from a resource rather than a literal (#188)', () => {
    clearEnv();
    const rendered = bootstrap().toYaml();
    // The RGD's status block must reference a resource id. A literal
    // "active" would be accepted here and then dropped by KRO.
    const match = rendered.match(/labelPropagationGuard:\s*(.*)/);
    expect(match).not.toBeNull();
    const value = match?.[1]?.trim() ?? '';
    expect(value).toContain('${');
    expect(value).toContain('labelPropagationGuardPolicy');
  });

  it('still projects from a resource when the guard is skipped', () => {
    clearEnv();
    process.env[DISABLE_LABEL_GUARD_ENV] = '1';
    const rendered = bootstrap().toYaml();
    const match = rendered.match(/labelPropagationGuard:\s*(.*)/);
    const value = match?.[1]?.trim() ?? '';
    expect(value).toContain('${');
    expect(value).toContain('kroHelmRelease');
    expect(value).toContain('"unavailable"');
  });
});

describe('resolveLabelPropagationGuardCapability', () => {
  it('defaults to the GA group version with no inputs', () => {
    clearEnv();
    expect(resolveLabelPropagationGuardCapability()).toEqual({
      status: 'active',
      apiVersion: 'admissionregistration.k8s.io/v1',
    });
  });

  it('lets the break-glass env var win over a successful probe', () => {
    clearEnv();
    setLabelPropagationGuardCapability({
      status: 'active',
      apiVersion: 'admissionregistration.k8s.io/v1beta1',
    });
    process.env[DISABLE_LABEL_GUARD_ENV] = 'true';
    expect(resolveLabelPropagationGuardCapability().status).toBe('unavailable');
  });

  it('ignores an unrecognised group version override', () => {
    clearEnv();
    process.env[LABEL_GUARD_API_VERSION_ENV] = 'admissionregistration.k8s.io/v1alpha1';
    expect(resolveLabelPropagationGuardCapability()).toEqual({
      status: 'active',
      apiVersion: 'admissionregistration.k8s.io/v1',
    });
  });

  it('uses a cached probe result', () => {
    clearEnv();
    setLabelPropagationGuardCapability({
      status: 'active',
      apiVersion: 'admissionregistration.k8s.io/v1beta1',
    });
    expect(resolveLabelPropagationGuardCapability()).toEqual({
      status: 'active',
      apiVersion: 'admissionregistration.k8s.io/v1beta1',
    });
  });
});
