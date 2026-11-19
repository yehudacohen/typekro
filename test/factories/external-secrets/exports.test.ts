import { describe, expect, it } from 'bun:test';
import * as eso from '../../../src/factories/external-secrets/index.js';
import * as root from '../../../src/index.js';

describe('typekro/external-secrets exports', () => {
  it('exports the composition, factories, helpers and constants', () => {
    expect(eso.externalSecretsAws).toBeDefined();
    expect(eso.clusterSecretStore).toBeTypeOf('function');
    expect(eso.secretStore).toBeTypeOf('function');
    expect(eso.externalSecret).toBeTypeOf('function');
    expect(eso.externalSecretsHelmRepository).toBeTypeOf('function');
    expect(eso.externalSecretsHelmRelease).toBeTypeOf('function');
    expect(eso.assertPodIdentityProvider).toBeTypeOf('function');
    expect(eso.EXTERNAL_SECRETS_API_VERSION).toBe('external-secrets.io/v1');
  });

  it('stays out of the root barrel', () => {
    expect(Object.keys(root)).not.toContain('externalSecretsAws');
    expect(Object.keys(root)).not.toContain('clusterSecretStore');
  });
});
