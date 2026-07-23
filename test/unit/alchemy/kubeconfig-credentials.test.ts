import type { KubeConfig } from '@kubernetes/client-node';
import { afterEach, describe, expect, it } from 'bun:test';
import type { SerializableKubeConfigOptions } from '../../../src/alchemy/types.js';
import {
  extractSerializableKubeConfigOptions,
  materializeSerializableKubeConfigOptions,
} from '../../../src/core/deployment/shared-utilities.js';
import { TypeKroError } from '../../../src/core/errors.js';

function kubeConfig(user: Record<string, unknown>): KubeConfig {
  return {
    getCurrentCluster: () => ({
      name: 'test-cluster',
      server: 'https://cluster.example',
      skipTLSVerify: false,
      caData: 'public-ca-data',
    }),
    getCurrentUser: () => ({ name: 'test-user', ...user }),
    getCurrentContext: () => 'test-context',
  } as unknown as KubeConfig;
}

function captureError(operation: () => unknown): TypeKroError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(TypeKroError);
    return error as TypeKroError;
  }
  throw new Error('Expected operation to throw');
}

const environmentToRestore = new Map<string, string | undefined>();

function setEnvironment(name: string, value: string | undefined): void {
  if (!environmentToRestore.has(name)) environmentToRestore.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  for (const [name, value] of environmentToRestore) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  environmentToRestore.clear();
});

describe('durable kubeconfig credential handling', () => {
  it('serializes a host-readable source without requiring an active local kubeconfig', () => {
    expect(
      extractSerializableKubeConfigOptions(undefined, {
        persistence: { source: { kind: 'default' } },
      })
    ).toEqual({
      loadFromDefault: true,
      skipTLSVerify: false,
    });
  });

  it('requires a concrete kubeconfig when no durable source is configured', () => {
    const error = captureError(() => extractSerializableKubeConfigOptions(undefined));
    expect(error.code).toBe('KUBECONFIG_DURABLE_SOURCE_REQUIRED');
  });

  it('rejects unbound static credentials without including their values in diagnostics', () => {
    const secret = 'should-never-enter-state-or-errors';
    const error = captureError(() =>
      extractSerializableKubeConfigOptions(kubeConfig({ token: secret }))
    );

    expect(error.code).toBe('KUBECONFIG_STATIC_CREDENTIALS_UNBOUND');
    expect(error.context).toEqual({ paths: ['/user/token'] });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(error.message).not.toContain(secret);
  });

  it('persists only a binding identity and resolves it inside the operation host', () => {
    const secret = 'short-lived-token';
    const serialized = extractSerializableKubeConfigOptions(kubeConfig({ token: secret }), {
      persistence: {
        credentialBindings: {
          '/user/token': { kind: 'environment', name: 'TYPEKRO_TEST_TOKEN' },
        },
      },
    });

    expect(JSON.stringify(serialized)).not.toContain(secret);
    expect(serialized.user).toEqual({ name: 'test-user' });
    expect(serialized.credentialBindings).toEqual({
      '/user/token': { kind: 'environment', name: 'TYPEKRO_TEST_TOKEN' },
    });

    setEnvironment('TYPEKRO_TEST_TOKEN', 'resolved-at-operation-time');
    const materialized = materializeSerializableKubeConfigOptions(serialized);
    expect(materialized.user?.token).toBe('resolved-at-operation-time');
    expect('credentialBindings' in materialized).toBe(false);
  });

  it('fails closed when a required host binding is unavailable', () => {
    setEnvironment('TYPEKRO_MISSING_TOKEN', undefined);
    const serialized = extractSerializableKubeConfigOptions(kubeConfig({ token: 'discarded' }), {
      persistence: {
        credentialBindings: {
          '/user/token': { kind: 'environment', name: 'TYPEKRO_MISSING_TOKEN' },
        },
      },
    });

    const error = captureError(() => materializeSerializableKubeConfigOptions(serialized));
    expect(error.code).toBe('KUBECONFIG_CREDENTIAL_BINDING_UNRESOLVED');
    expect(error.context).toEqual({
      path: '/user/token',
      environmentVariable: 'TYPEKRO_MISSING_TOKEN',
    });
  });

  it('rejects manually supplied inline credentials at provider materialization', () => {
    const secret = 'manual-inline-token';
    const error = captureError(() =>
      materializeSerializableKubeConfigOptions({
        user: { name: 'test-user', token: secret },
      } as SerializableKubeConfigOptions)
    );

    expect(error.code).toBe('KUBECONFIG_INLINE_CREDENTIALS_FORBIDDEN');
    expect(error.context).toEqual({ paths: ['/user/token'] });
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it('detects nested auth-provider credential fields', () => {
    const error = captureError(() =>
      extractSerializableKubeConfigOptions(
        kubeConfig({
          authProvider: {
            name: 'oidc',
            config: { 'access-token': 'nested-token' },
          },
        })
      )
    );

    expect(error.code).toBe('KUBECONFIG_STATIC_CREDENTIALS_UNBOUND');
    expect(error.context).toEqual({ paths: ['/user/authProvider/config/access-token'] });
  });

  it('detects secret-bearing exec environment values', () => {
    const error = captureError(() =>
      extractSerializableKubeConfigOptions(
        kubeConfig({
          exec: {
            apiVersion: 'client.authentication.k8s.io/v1',
            command: 'credential-helper',
            env: [{ name: 'AWS_SECRET_ACCESS_KEY', value: 'nested-secret' }],
          },
        })
      )
    );

    expect(error.code).toBe('KUBECONFIG_STATIC_CREDENTIALS_UNBOUND');
    expect(error.context).toEqual({ paths: ['/user/exec/env/0/value'] });
  });

  it('detects common secret-bearing exec arguments', () => {
    const error = captureError(() =>
      extractSerializableKubeConfigOptions(
        kubeConfig({
          exec: {
            apiVersion: 'client.authentication.k8s.io/v1',
            command: 'credential-helper',
            args: ['--audience', 'api', '--client-secret', 'nested-secret'],
          },
        })
      )
    );

    expect(error.code).toBe('KUBECONFIG_STATIC_CREDENTIALS_UNBOUND');
    expect(error.context).toEqual({ paths: ['/user/exec/args/3'] });
  });

  it('preserves safe exec configuration without treating the command as a credential', () => {
    const serialized = extractSerializableKubeConfigOptions(
      kubeConfig({
        exec: {
          apiVersion: 'client.authentication.k8s.io/v1',
          command: 'aws',
          args: ['eks', 'get-token', '--cluster-name', 'demo'],
          env: [{ name: 'AWS_PROFILE', value: 'production' }],
        },
      })
    );

    expect(serialized.user?.exec).toEqual({
      apiVersion: 'client.authentication.k8s.io/v1',
      command: 'aws',
      args: ['eks', 'get-token', '--cluster-name', 'demo'],
      env: [{ name: 'AWS_PROFILE', value: 'production' }],
    });
    expect(serialized.credentialBindings).toBeUndefined();
  });

  it('persists only source identity when the operation host re-reads kubeconfig', () => {
    const secret = 'source-only-secret';
    const fromDefault = extractSerializableKubeConfigOptions(
      kubeConfig({ token: secret, certData: secret, keyData: secret }),
      { persistence: { source: { kind: 'default' } } }
    );
    const fromFile = extractSerializableKubeConfigOptions(kubeConfig({ token: secret }), {
      persistence: { source: { kind: 'file', path: '/run/secrets/kubeconfig' } },
    });

    expect(fromDefault).toEqual({
      loadFromDefault: true,
      context: 'test-context',
      skipTLSVerify: false,
    });
    expect(fromFile).toEqual({
      loadFromDefault: true,
      kubeconfigPath: '/run/secrets/kubeconfig',
      context: 'test-context',
      skipTLSVerify: false,
    });
    expect(JSON.stringify({ fromDefault, fromFile })).not.toContain(secret);
  });
});
