import { describe, expect, it } from 'bun:test';
import { webAppWithProcessing } from '../../../src/factories/webapp/compositions/web-app-with-processing.js';

describe('WebAppWithProcessing Composition', () => {
  it('should generate valid KRO YAML with all resources', () => {
    const yaml = webAppWithProcessing.toYaml();

    expect(yaml).toContain('apiVersion: kro.run/v1alpha1');
    expect(yaml).toContain('kind: ResourceGraphDefinition');
    expect(yaml).toContain('name: web-app-with-processing');

    // Should contain all resource types
    expect(yaml).toContain('kind: Cluster');       // CNPG
    expect(yaml).toContain('kind: Pooler');         // PgBouncer
    expect(yaml).toContain('kind: Valkey');          // Cache
    expect(yaml).toContain('kind: Deployment');      // App
    expect(yaml).toContain('kind: Service');          // App service

    // Status section with component readiness references
    expect(yaml).toContain('status:');
    expect(yaml).toContain('components:');
    // Note: static string status fields (databaseUrl, cacheUrl, etc.) are
    // hydrated directly in direct mode, not sent to Kro in the YAML.
  });

  it('should generate YAML with environment variable wiring', () => {
    const yaml = webAppWithProcessing.toYaml();

    // The app deployment should have env vars injected
    expect(yaml).toContain('DATABASE_URL');
    expect(yaml).toContain('VALKEY_URL');
    expect(yaml).toContain('REDIS_URL');
    expect(yaml).toContain('INNGEST_BASE_URL');
    expect(yaml).toContain('INNGEST_EVENT_KEY');
    expect(yaml).toContain('INNGEST_SIGNING_KEY');
  });

  it('should support both kro and direct factory modes', () => {
    const kroFactory = webAppWithProcessing.factory('kro', {
      namespace: 'test',
    });
    const directFactory = webAppWithProcessing.factory('direct', {
      namespace: 'test',
    });

    expect(kroFactory.mode).toBe('kro');
    expect(directFactory.mode).toBe('direct');
  });

  it('should generate YAML with CNPG naming conventions', () => {
    const yaml = webAppWithProcessing.toYaml();

    // CNPG service names follow {cluster}-rw pattern
    expect(yaml).toContain('-db');
    expect(yaml).toContain('-db-pooler');
    expect(yaml).toContain('-cache');
    expect(yaml).toContain('-inngest');
  });

  it('should generate YAML with Inngest using external databases', () => {
    const yaml = webAppWithProcessing.toYaml();

    // Inngest should disable bundled PostgreSQL and Redis
    // (these show up in the Helm values)
    expect(yaml).toContain('postgresql');
    expect(yaml).toContain('redis');
  });

  it('should include nested composition for Inngest', () => {
    const yaml = webAppWithProcessing.toYaml();

    // Inngest bootstrap creates HelmRepository + HelmRelease
    expect(yaml).toContain('HelmRelease');
    expect(yaml).toContain('HelmRepository');
  });
});
