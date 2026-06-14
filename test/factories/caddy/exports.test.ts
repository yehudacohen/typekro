import { describe, expect, it } from 'bun:test';
import * as caddy from '../../../src/factories/caddy/index.js';

describe('Caddy public exports', () => {
  it('exposes typekro/caddy through package metadata', async () => {
    const packageJson = (await Bun.file('package.json').json()) as {
      exports: Record<string, Record<string, string>>;
      files: string[];
    };
    expect(packageJson.exports['./caddy']).toEqual({
      import: './dist/factories/caddy/index.js',
      types: './dist/factories/caddy/index.d.ts',
    });
    expect(packageJson.files).toContain('dist');
  });

  it('exports the composition, helper, schemas, and constants', () => {
    expect(caddy.caddyIngress).toBeDefined();
    expect(typeof caddy.renderCaddyfile).toBe('function');
    expect(caddy.CaddyIngressConfigSchema).toBeDefined();
    expect(caddy.CaddyIngressStatusSchema).toBeDefined();
    expect(caddy.DEFAULT_CADDY_IMAGE).toBe('caddy');
    expect(caddy.DEFAULT_CADDY_VERSION).toBe('2.11.2');
    expect(caddy.DEFAULT_CADDY_NAMESPACE).toBe('caddy-system');
  });

  it('documents the Caddy API and lists it in the sidebar', async () => {
    const docsPage = await Bun.file('docs/api/caddy/index.md').text();
    const docsConfig = await Bun.file('docs/.vitepress/config.ts').text();

    expect(docsPage).toContain("from 'typekro/caddy'");
    expect(docsPage).toContain('caddyIngress');
    expect(docsPage).toContain('renderCaddyfile');
    expect(docsPage).toContain('tls internal');
    expect(docsPage).toContain('Prerequisites');
    expect(docsPage).toContain('Next steps');
    expect(docsConfig).toContain('/api/caddy/');
    expect(docsConfig).toContain('Caddy');
  });
});
