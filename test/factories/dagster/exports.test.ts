import { describe, expect, it } from 'bun:test';
import * as dagster from '../../../src/factories/dagster/index.js';

describe('Dagster public exports', () => {
  it('Import Dagster APIs from typekro/dagster through package metadata', async () => {
    const packageJson = (await Bun.file('package.json').json()) as {
      exports: Record<string, Record<string, string>>;
      files: string[];
    };

    expect(packageJson.exports['./dagster']).toEqual({
      import: './dist/factories/dagster/index.js',
      types: './dist/factories/dagster/index.d.ts',
    });
    expect(packageJson.files).toContain('dist');
    expect(packageJson.files).not.toContain('src/factories/dagster');
  });

  it('Export Dagster wrappers, composition, mapper, schemas, and constants', () => {
    expect(typeof dagster.dagsterHelmRepository).toBe('function');
    expect(typeof dagster.dagsterHelmRelease).toBe('function');
    expect(dagster.dagsterBootstrap).toBeDefined();
    expect(typeof dagster.mapDagsterConfigToHelmValues).toBe('function');
    expect(typeof dagster.validateDagsterConfig).toBe('function');
    expect(dagster.DagsterBootstrapConfigSchema).toBeDefined();
    expect(dagster.DagsterBootstrapStatusSchema).toBeDefined();
    expect(dagster.DagsterHelmRepositoryConfigSchema).toBeDefined();
    expect(dagster.DagsterHelmReleaseConfigSchema).toBeDefined();
    expect(dagster.DEFAULT_DAGSTER_REPO_URL).toBe('https://dagster-io.github.io/helm');
    expect(dagster.DEFAULT_DAGSTER_REPO_NAME).toBe('dagster');
    expect(dagster.DEFAULT_DAGSTER_VERSION).toBe('1.13.8');
  });

  it('Document Dagster API usage and expose Dagster in the API sidebar', async () => {
    const docsPage = await Bun.file('docs/api/dagster/index.md').text();
    const docsConfig = await Bun.file('docs/.vitepress/config.ts').text();

    expect(docsPage).toContain("from 'typekro/dagster'");
    expect(docsPage).toContain('dagsterBootstrap');
    expect(docsPage).toContain('external PostgreSQL');
    expect(docsPage).toContain('Secrets');
    expect(docsPage).toContain('Troubleshooting');
    expect(docsPage).toContain('Next Steps');
    expect(docsConfig).toContain('/api/dagster/');
    expect(docsConfig).toContain('Dagster');
  });
});
