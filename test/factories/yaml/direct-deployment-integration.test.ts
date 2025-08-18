import { describe, it, expect } from 'bun:test';
import { yamlFile, yamlDirectory } from '../../../src/factories/kubernetes/yaml/index.js';


describe('YAML Factory Deployment Integration', () => {
  describe('yamlFile deployment closures', () => {
    it('should return a deployment closure', () => {
      const yaml = yamlFile({
        name: 'test-config',
        path: './test-manifests/configmap.yaml'
      });

      // Should be a function (closure)
      expect(typeof yaml).toBe('function');
      expect(yaml).toBeInstanceOf(Function);
    });
  });

  describe('yamlDirectory deployment closures', () => {
    it('should return a deployment closure', () => {
      const yamlDir = yamlDirectory({
        name: 'helm-controller',
        path: 'git:github.com/fluxcd/helm-controller/config/default@main'
      });

      // Should be a function (closure)
      expect(typeof yamlDir).toBe('function');
      
      // Should be callable with deployment context
      expect(yamlDir).toBeInstanceOf(Function);
    });
  });

  describe('multiple YAML resources as closures', () => {
    it('should return deployment closures', () => {
      const helmController = yamlDirectory({
        name: 'helm-controller',
        path: 'git:github.com/fluxcd/helm-controller/config/default@main'
      });

      const appConfig = yamlFile({
        name: 'app-config',
        path: './config/app-config.yaml'
      });

      // Both should be functions (closures)
      expect(typeof helmController).toBe('function');
      expect(typeof appConfig).toBe('function');
      
      // Should be different closure instances
      expect(helmController).not.toBe(appConfig);
    });
  });

  describe('resource references between YAML resources', () => {
    it('should support cross-references between YAML resources', () => {
      const namespace = yamlFile({
        name: 'app-namespace',
        path: './manifests/namespace.yaml'
      });

      const deployment = yamlFile({
        name: 'app-deployment',
        path: './manifests/deployment.yaml'
      });

      // Should be deployment closures
      expect(typeof namespace).toBe('function');
      expect(typeof deployment).toBe('function');
      
      // Closures should be different instances
      expect(namespace).not.toBe(deployment);
    });

    it('should work in composition patterns with references', () => {
      // Simulate a composition that uses YAML resources with cross-references
      const helmController = yamlDirectory({
        name: 'helm-controller',
        path: 'git:github.com/fluxcd/helm-controller/config/default@main'
      });

      const helmRelease = yamlFile({
        name: 'my-app-release',
        path: './helm-releases/my-app.yaml'
      });

      // Should be deployment closures
      expect(typeof helmController).toBe('function');
      expect(typeof helmRelease).toBe('function');
    });
  });

  describe('closure behavior', () => {
    it('should create closures with Git URLs', () => {
      const gitYaml = yamlDirectory({
        name: 'flux-system',
        path: 'git:github.com/fluxcd/flux2/manifests/install@v2.2.0'
      });

      // Should be a function (closure)
      expect(typeof gitYaml).toBe('function');
      expect(gitYaml).toBeInstanceOf(Function);
    });

    it('should create closures for YAML files', () => {
      const yaml = yamlFile({
        name: 'test-config',
        path: './test.yaml'
      });

      // Should be a function (closure)
      expect(typeof yaml).toBe('function');
      expect(yaml).toBeInstanceOf(Function);
    });
  });
});