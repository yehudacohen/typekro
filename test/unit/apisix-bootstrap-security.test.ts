import { describe, expect, it } from 'bun:test';
import { apisixBootstrap } from '../../src/factories/apisix/compositions/apisix-bootstrap.js';

describe('APISIX bootstrap credential serialization', () => {
  it('uses env credentials, not chart defaults, in KRO YAML when spec credentials are omitted', () => {
    const originalAdmin = process.env.APISIX_ADMIN_KEY;
    const originalViewer = process.env.APISIX_VIEWER_KEY;
    process.env.APISIX_ADMIN_KEY = 'env-admin-key';
    process.env.APISIX_VIEWER_KEY = 'env-viewer-key';

    try {
      const yaml = apisixBootstrap.toYaml();

      expect(yaml).not.toContain('edd1c9f034335f136f87ad84b625c8f1');
      expect(yaml).not.toContain('4054f7cf07e344346cd3f287985e76a2');
      expect(yaml).toContain('env-admin-key');
      expect(yaml).toContain('env-viewer-key');
      expect(yaml).not.toContain('schema.spec.gateway.adminCredentials.admin');
      expect(yaml).not.toContain('schema.spec.gateway.adminCredentials.viewer');
    } finally {
      if (originalAdmin === undefined) {
        delete process.env.APISIX_ADMIN_KEY;
      } else {
        process.env.APISIX_ADMIN_KEY = originalAdmin;
      }
      if (originalViewer === undefined) {
        delete process.env.APISIX_VIEWER_KEY;
      } else {
        process.env.APISIX_VIEWER_KEY = originalViewer;
      }
    }
  });

  it('fails KRO YAML generation when credentials are omitted and env vars are unset', () => {
    const originalAdmin = process.env.APISIX_ADMIN_KEY;
    const originalViewer = process.env.APISIX_VIEWER_KEY;
    delete process.env.APISIX_ADMIN_KEY;
    delete process.env.APISIX_VIEWER_KEY;

    try {
      expect(() => apisixBootstrap.toYaml()).toThrow('APISIX admin credentials not configured');
    } finally {
      if (originalAdmin === undefined) {
        delete process.env.APISIX_ADMIN_KEY;
      } else {
        process.env.APISIX_ADMIN_KEY = originalAdmin;
      }
      if (originalViewer === undefined) {
        delete process.env.APISIX_VIEWER_KEY;
      } else {
        process.env.APISIX_VIEWER_KEY = originalViewer;
      }
    }
  });

  it('preserves toYaml(spec) for explicit credential custom resources', () => {
    const originalAdmin = process.env.APISIX_ADMIN_KEY;
    const originalViewer = process.env.APISIX_VIEWER_KEY;
    delete process.env.APISIX_ADMIN_KEY;
    delete process.env.APISIX_VIEWER_KEY;

    try {
      const yaml = apisixBootstrap.toYaml({
        name: 'apisix',
        gateway: {
          adminCredentials: {
            admin: 'spec-admin-key',
            viewer: 'spec-viewer-key',
          },
        },
      });

      expect(yaml).toContain('kind: APISixBootstrap');
      expect(yaml).toContain('spec-admin-key');
      expect(yaml).toContain('spec-viewer-key');
    } finally {
      if (originalAdmin === undefined) {
        delete process.env.APISIX_ADMIN_KEY;
      } else {
        process.env.APISIX_ADMIN_KEY = originalAdmin;
      }
      if (originalViewer === undefined) {
        delete process.env.APISIX_VIEWER_KEY;
      } else {
        process.env.APISIX_VIEWER_KEY = originalViewer;
      }
    }
  });
});
