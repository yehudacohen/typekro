import { describe, expect, it } from 'bun:test';
import * as ory from '../../../src/factories/ory/index.js';

describe('Ory public exports', () => {
  it('Package metadata resolves typekro/ory through built dist files', async () => {
    const packageJson = (await Bun.file('package.json').json()) as {
      exports: Record<string, Record<string, string>>;
      files: string[];
    };

    expect(packageJson.exports['./ory']).toEqual({
      import: './dist/factories/ory/index.js',
      types: './dist/factories/ory/index.d.ts',
    });
    expect(packageJson.files).toContain('dist');
    expect(packageJson.files).not.toContain('src/factories/ory');
  });

  it('Export all public Ory Helm wrappers, Maester resources, compositions, mapper, and schemas', () => {
    expect(typeof ory.oryHelmRepository).toBe('function');
    expect(typeof ory.hydraHelmRelease).toBe('function');
    expect(typeof ory.kratosHelmRelease).toBe('function');
    expect(typeof ory.ketoHelmRelease).toBe('function');
    expect(typeof ory.oathkeeperHelmRelease).toBe('function');
    expect(typeof ory.oauth2Client).toBe('function');
    expect(typeof ory.oathkeeperRule).toBe('function');
    expect(ory.oryIdentityStack).toBeDefined();
    expect(ory.oryPlatformStack).toBeDefined();
    expect(typeof ory.mapOryConfigToHelmValues).toBe('function');
    expect(typeof ory.validateOryConfig).toBe('function');
    expect(ory.OryIdentityStackConfigSchema).toBeDefined();
    expect(ory.OryIdentityStackStatusSchema).toBeDefined();
    expect(ory.OryPlatformStackConfigSchema).toBeDefined();
    expect(ory.OryPlatformStackStatusSchema).toBeDefined();
  });

  it('Export physical subproduct schema modules through the Ory schema barrel', () => {
    expect('OryHydraChartValues' in ory).toBe(false);
    expect(ory.OryIdentityStackConfigSchema).toBeDefined();
    expect(ory.OryIdentityStackStatusSchema).toBeDefined();
    expect(ory.OryPlatformStackConfigSchema).toBeDefined();
    expect(ory.OryPlatformStackStatusSchema).toBeDefined();
  });
});
