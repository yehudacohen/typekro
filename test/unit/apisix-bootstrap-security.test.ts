import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import { apisixBootstrap } from '../../src/factories/apisix/compositions/apisix-bootstrap.js';
import { APISixBootstrapConfigSchema, APISixBootstrapStatusSchema } from '../../src/factories/apisix/types.js';
import { mapAPISixConfigToHelmValues, validateAPISixHelmValues } from '../../src/factories/apisix/utils/helm-values-mapper.js';
import { kubernetesComposition } from '../../src/index.js';

describe('APISIX bootstrap credential serialization', () => {
  it('exposes gateway.ingress in the KRO config schema', () => {
    const result = APISixBootstrapConfigSchema({
      name: 'apisix',
      gateway: {
        ingress: {
          enabled: true,
          annotations: { 'kubernetes.io/ingress.class': 'apisix' },
          hosts: ['apisix.example.com'],
          tls: [{ secretName: 'apisix-tls', hosts: ['apisix.example.com'] }],
        },
      },
    });

    expect(result).toHaveProperty('gateway');
    if ('gateway' in result) {
      expect(result.gateway?.ingress?.enabled).toBe(true);
      expect(result.gateway?.ingress?.hosts).toEqual(['apisix.example.com']);
    }
  });

  it('exposes gateway.stream and serviceAccount annotations in the KRO config schema', () => {
    const result = APISixBootstrapConfigSchema({
      name: 'apisix',
      gateway: {
        stream: {
          enabled: true,
          only: false,
          tcp: [9000],
          udp: [9001],
        },
      },
      serviceAccount: {
        create: true,
        annotations: { 'eks.amazonaws.com/role-arn': 'arn:aws:iam::123456789012:role/apisix' },
      },
    });

    expect(result).toHaveProperty('gateway');
    if ('gateway' in result) {
      expect(result.gateway?.stream?.tcp).toEqual([9000]);
      expect(result.serviceAccount?.annotations).toEqual({
        'eks.amazonaws.com/role-arn': 'arn:aws:iam::123456789012:role/apisix',
      });
    }
  });

  it('exposes public APISIX sections in the KRO config schema', () => {
    const result = APISixBootstrapConfigSchema({
      name: 'apisix',
      apisix: {
        image: { repository: 'apache/apisix', tag: '3.12.0', pullPolicy: 'IfNotPresent' },
        resources: { requests: { cpu: '100m', memory: '128Mi' } },
        config: { nginx_config: { error_log_level: 'warn' } },
      },
      dashboard: {
        enabled: true,
        image: { repository: 'apache/apisix-dashboard', tag: '3.0.1' },
      },
      etcd: {
        enabled: true,
        replicaCount: 1,
        auth: { tls: { enabled: false } },
      },
      customValues: { extra: { enabled: true } },
    });

    expect(result).toHaveProperty('apisix');
    if ('apisix' in result) {
      expect(result.apisix?.image?.repository).toBe('apache/apisix');
      expect(result.dashboard?.enabled).toBe(true);
      expect(result.etcd?.replicaCount).toBe(1);
      expect(result.customValues).toEqual({ extra: { enabled: true } });
    }
  });

  it('exposes gateway service ports in the KRO status schema', () => {
    const result = APISixBootstrapStatusSchema({
      ready: true,
      phase: 'Ready',
      gatewayReady: true,
      standardIngressReady: false,
      dashboardReady: false,
      etcdReady: true,
      gatewayService: {
        name: 'apisix-gateway',
        namespace: 'apisix',
        type: 'ClusterIP',
        ports: [{ name: 'http', port: 80, targetPort: 9080, protocol: 'TCP' }],
      },
    });

    expect(result).toHaveProperty('gatewayService');
    if ('gatewayService' in result) {
      expect(result.gatewayService?.ports?.[0]?.targetPort).toBe(9080);
    }
  });

  it('warns accurately when APISIX ingress controller reconciliation is disabled', () => {
    const warnings = validateAPISixHelmValues({
      ingressController: { enabled: false },
      gateway: { http: { enabled: true } },
    });

    expect(warnings).toContain(
      'APISIX ingress controller is disabled. APISIX CRD resources and standard Kubernetes Ingress resources will not be reconciled unless you deploy an ingress controller separately.',
    );
    expect(warnings).not.toContain(
      'Ingress controller is disabled. This will prevent ingress resources from being processed.'
    );
  });

  it('omits gateway admin credentials from the generic gateway values path', () => {
    const helmValues = mapAPISixConfigToHelmValues({
      name: 'apisix',
      gateway: {
        adminCredentials: {
          admin: 'admin-key',
          viewer: 'viewer-key',
        },
        type: 'ClusterIP',
      },
    });

    expect(helmValues.gateway).toEqual({ type: 'ClusterIP' });
    expect(helmValues.gateway).not.toHaveProperty('adminCredentials');
  });

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

  it('does not create IngressClass or advertise Ingress readiness when controller subchart is disabled', () => {
    const originalAdmin = process.env.APISIX_ADMIN_KEY;
    const originalViewer = process.env.APISIX_VIEWER_KEY;
    process.env.APISIX_ADMIN_KEY = 'env-admin-key';
    process.env.APISIX_VIEWER_KEY = 'env-viewer-key';

    try {
      const yaml = apisixBootstrap.toYaml();

      expect(yaml).not.toContain('kind: IngressClass');
      expect(yaml).not.toContain('apisixIngressClass');
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

  it('wires the HelmRelease sourceRef to the created HelmRepository name', () => {
    const originalAdmin = process.env.APISIX_ADMIN_KEY;
    const originalViewer = process.env.APISIX_VIEWER_KEY;
    process.env.APISIX_ADMIN_KEY = 'env-admin-key';
    process.env.APISIX_VIEWER_KEY = 'env-viewer-key';

    try {
      const yaml = apisixBootstrap.toYaml();

      expect(yaml).toContain('kind: HelmRepository');
      expect(yaml).toContain('name: apisix-repo');
      expect(yaml).toContain('sourceRef:');
      expect(yaml).toContain('name: apisix-repo');
      expect(yaml).not.toContain('name: apisix-bootstrap-repo');
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

  it('propagates public chart config fields into the Helm values template', () => {
    const originalAdmin = process.env.APISIX_ADMIN_KEY;
    const originalViewer = process.env.APISIX_VIEWER_KEY;
    process.env.APISIX_ADMIN_KEY = 'env-admin-key';
    process.env.APISIX_VIEWER_KEY = 'env-viewer-key';

    try {
      const yaml = apisixBootstrap.toYaml();

      expect(yaml).toContain('apisix:');
      expect(yaml).toContain('image: "${has(schema.spec.apisix) && has(schema.spec.apisix.image) ? schema.spec.apisix.image : omit()}"');
      expect(yaml).toContain('dashboard:');
      expect(yaml).toContain('enabled: "${has(schema.spec.dashboard) && has(schema.spec.dashboard.enabled) ? schema.spec.dashboard.enabled : omit()}"');
      expect(yaml).toContain('schema.spec.customValues');
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

  it('does not emit undeclared helmRelease status', () => {
    const originalAdmin = process.env.APISIX_ADMIN_KEY;
    const originalViewer = process.env.APISIX_VIEWER_KEY;
    process.env.APISIX_ADMIN_KEY = 'env-admin-key';
    process.env.APISIX_VIEWER_KEY = 'env-viewer-key';

    try {
      const yaml = apisixBootstrap.toYaml();
      const statusStart = yaml.indexOf('    status:');
      const resourcesStart = yaml.indexOf('\n  resources:', statusStart);
      const statusBlock = yaml.slice(statusStart, resourcesStart);

      expect(statusBlock).not.toContain('helmRelease:');
      expect(statusBlock).toContain('ready:');
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

  it('fails factory("kro").toYaml() when credentials are omitted and env vars are unset', () => {
    const originalAdmin = process.env.APISIX_ADMIN_KEY;
    const originalViewer = process.env.APISIX_VIEWER_KEY;
    delete process.env.APISIX_ADMIN_KEY;
    delete process.env.APISIX_VIEWER_KEY;

    try {
      expect(() => apisixBootstrap.factory('kro').toYaml()).toThrow(
        'APISIX admin credentials not configured'
      );
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

  it('fails nested KRO composition generation when credentials are omitted and env vars are unset', () => {
    const originalAdmin = process.env.APISIX_ADMIN_KEY;
    const originalViewer = process.env.APISIX_VIEWER_KEY;
    try {
      delete process.env.APISIX_ADMIN_KEY;
      delete process.env.APISIX_VIEWER_KEY;

      expect(() => {
        const parent = kubernetesComposition(
          {
            name: 'apisix-nested-security',
            kind: 'ApisixNestedSecurity',
            spec: type({ name: 'string' }),
            status: type({ ready: 'boolean' }),
          },
          (spec) => {
            apisixBootstrap({ name: spec.name });
            return { ready: true };
          }
        );
        parent.toYaml();
      }).toThrow('APISIX admin credentials not configured');
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

  it('allows factory("kro").toYaml(spec) to use explicit deploy-time credentials', () => {
    const originalAdmin = process.env.APISIX_ADMIN_KEY;
    const originalViewer = process.env.APISIX_VIEWER_KEY;
    delete process.env.APISIX_ADMIN_KEY;
    delete process.env.APISIX_VIEWER_KEY;

    try {
      const yaml = apisixBootstrap.factory('kro').toYaml({
        name: 'apisix',
        gateway: {
          adminCredentials: {
            admin: 'spec-admin-key',
            viewer: 'spec-viewer-key',
          },
        },
      });

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
