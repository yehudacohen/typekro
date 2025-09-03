/**
 * Unit tests for TypeKro runtime bootstrap CEL expression generation
 * 
 * These tests verify that the TypeKro runtime bootstrap correctly generates CEL expressions
 * for status fields instead of static values, and that no false warnings are generated
 * about static fields.
 * 
 * This test suite would have caught the bug where the bootstrap was generating warnings
 * about "static fields" even though the expressions contained dynamic KubernetesRef objects.
 */

import { describe, expect, it } from 'bun:test';

import { typeKroRuntimeBootstrap } from '../../src/core/composition/typekro-runtime/index.js';

describe('TypeKro Runtime Bootstrap CEL Generation', () => {
  describe('Status field KubernetesRef creation', () => {
    it('should create KubernetesRef objects for status fields in bootstrap composition', async () => {
      const bootstrap = typeKroRuntimeBootstrap({
        namespace: 'flux-system',
        fluxVersion: 'v2.4.0',
        kroVersion: '0.3.0'
      });

      // Test that the bootstrap creates a valid factory
      const factory = await bootstrap.factory('kro', { namespace: 'flux-system' });
      expect(factory).toBeDefined();

      // Test that the YAML contains CEL expressions, not static values
      const yaml = await factory.toYaml();
      expect(yaml).toContain('${');
      expect(yaml).toContain('kroHelmRelease.status.phase');
      // fluxHelmRelease was removed - Flux is installed via YAML, not Helm
      expect(yaml).not.toContain('fluxHelmRelease.status.phase');
      
      // Verify that the status section contains dynamic expressions
      expect(yaml).toContain('phase: "${');
      // Verify that components is now properly structured with individual CEL expressions
      expect(yaml).toContain('components:');
      expect(yaml).toContain('kroSystem: ${');
    });

    it('should generate proper CEL expressions when serialized to YAML', async () => {
      const bootstrap = typeKroRuntimeBootstrap({
        namespace: 'flux-system',
        fluxVersion: 'v2.4.0',
        kroVersion: '0.3.0'
      });

      const kroFactory = await bootstrap.factory('kro', { namespace: 'flux-system' });
      const rgdYaml = kroFactory.toYaml();

      // Should contain CEL expressions for status fields
      expect(rgdYaml).toContain('${');
      expect(rgdYaml).toContain('kroHelmRelease.status.phase');
      // fluxHelmRelease was removed - Flux is installed via YAML, not Helm
      expect(rgdYaml).not.toContain('fluxHelmRelease.status.phase');
      
      // Should NOT contain static placeholder values
      expect(rgdYaml).not.toContain('phase: Ready');
      expect(rgdYaml).not.toContain('phase: Pending');
      expect(rgdYaml).not.toContain('phase: Installing');
      expect(rgdYaml).not.toContain('phase: Failed');
      
      // Should contain proper CEL expressions for components unless they're yamlFile deployment closures
      expect(rgdYaml).not.toContain('fluxSystem:');
      expect(rgdYaml).toContain('kroSystem:');
    });

    it('should not generate warnings about static fields', async () => {
      // Capture console output to check for warnings
      const originalWarn = console.warn;
      const warnings: string[] = [];
      console.warn = (...args) => {
        warnings.push(args.join(' '));
      };

      try {
        const bootstrap = typeKroRuntimeBootstrap({
          namespace: 'flux-system',
          fluxVersion: 'v2.4.0',
          kroVersion: '0.3.0'
        });

        const kroFactory = await bootstrap.factory('kro', { namespace: 'flux-system' });
        kroFactory.toYaml();

        // Should not have warnings about static fields since we fixed the bug
        const staticFieldWarnings = warnings.filter(w => 
          w.includes('Static fields') && 
          (w.includes('phase') || w.includes('components'))
        );
        
        expect(staticFieldWarnings).toHaveLength(0);
      } finally {
        console.warn = originalWarn;
      }
    });
  });

  describe('Resource reference behavior', () => {
    it('should ensure kroHelmRelease status fields are referenced in CEL expressions', async () => {
      const bootstrap = typeKroRuntimeBootstrap({
        namespace: 'flux-system',
        fluxVersion: 'v2.4.0',
        kroVersion: '0.3.0'
      });

      const factory = await bootstrap.factory('kro', { namespace: 'flux-system' });
      const yaml = await factory.toYaml();

      // Verify that kroHelmRelease status fields are referenced in CEL expressions
      expect(yaml).toContain('kroHelmRelease.status.phase');
      expect(yaml).toContain('kroSystem: ${kroHelmRelease.status.phase === "Ready"}');
      
      // Ensure it's not a static value
      expect(yaml).not.toContain('phase: "Ready"');
      expect(yaml).not.toContain('phase: "Installing"');
    });

    it('should ensure bootstrap works correctly without fluxHelmRelease', async () => {
      const bootstrap = typeKroRuntimeBootstrap({
        namespace: 'flux-system',
        fluxVersion: 'v2.4.0',
        kroVersion: '0.3.0'
      });

      const factory = await bootstrap.factory('kro', { namespace: 'flux-system' });
      const yaml = await factory.toYaml();

      // Verify that fluxHelmRelease is no longer referenced (Flux installed via YAML)
      expect(yaml).not.toContain('fluxHelmRelease.status.phase');
      // Only kroSystem component should remain
      expect(yaml).toContain('kroSystem: ${kroHelmRelease.status.phase === "Ready"}');
      
      // Ensure it's not a static value
      expect(yaml).not.toContain('fluxSystem: true');
      expect(yaml).not.toContain('fluxSystem: false');
    });
  });

  describe('Status builder expressions', () => {
    it('should create JavaScript expressions that convert to CEL', async () => {
      const bootstrap = typeKroRuntimeBootstrap({
        namespace: 'flux-system',
        fluxVersion: 'v2.4.0',
        kroVersion: '0.3.0'
      });

      const factory = await bootstrap.factory('kro', { namespace: 'flux-system' });
      const yaml = await factory.toYaml();

      // Test that JavaScript expressions are converted to CEL expressions
      expect(yaml).toContain('kroHelmRelease.status.phase === \\"Ready\\"');
      expect(yaml).toContain('? \\"Ready\\" : \\"Installing\\"');
      
      // Ensure it's not a static value
      expect(yaml).not.toContain('phase: Ready');
      expect(yaml).not.toContain('phase: Installing');
    });

    it('should handle complex status expressions correctly', async () => {
      const bootstrap = typeKroRuntimeBootstrap({
        namespace: 'flux-system',
        fluxVersion: 'v2.4.0',
        kroVersion: '0.3.0'
      });

      const factory = await bootstrap.factory('kro', { namespace: 'flux-system' });
      const yaml = await factory.toYaml();

      // Test complex expressions in the components section (they're wrapped in CEL expressions) unless they're installed with deployment closures
      expect(yaml).not.toContain('fluxSystem: ${fluxHelmRelease.status.phase === "Ready"}');
      expect(yaml).toContain('kroSystem: ${kroHelmRelease.status.phase === "Ready"}');
      
      // Ensure components are not static boolean values
      expect(yaml).not.toContain('fluxSystem: true');
      expect(yaml).not.toContain('kroSystem: false');
    });
  });

  describe('Regression prevention', () => {
    it('should catch if bootstrap starts providing static status values again', async () => {
      // This test specifically prevents the bug we just fixed
      const bootstrap = typeKroRuntimeBootstrap({
        namespace: 'flux-system',
        fluxVersion: 'v2.4.0',
        kroVersion: '0.3.0'
      });

      const kroFactory = await bootstrap.factory('kro', { namespace: 'flux-system' });
      const rgdYaml = kroFactory.toYaml();

      // These specific checks would have failed with the bug
      expect(rgdYaml).not.toContain('phase: "Ready"');
      expect(rgdYaml).not.toContain('phase: "Pending"');
      expect(rgdYaml).not.toContain('phase: "Installing"');
      expect(rgdYaml).not.toContain('components: true');
      expect(rgdYaml).not.toContain('components: false');
      
      // Should contain CEL expressions instead
      expect(rgdYaml).toContain('${kroHelmRelease.status.phase');
      // flux is installed by yamlFile deployment closure
      expect(rgdYaml).not.toContain('fluxHelmRelease.status.phase');
    });

    it('should ensure serialization preserves KubernetesRef expressions', async () => {
      const bootstrap = typeKroRuntimeBootstrap({
        namespace: 'flux-system',
        fluxVersion: 'v2.4.0',
        kroVersion: '0.3.0'
      });

      // Test both factory types to ensure consistency
      const kroFactory = await bootstrap.factory('kro', { namespace: 'flux-system' });
      const directFactory = await bootstrap.factory('direct', { namespace: 'flux-system' });

      // Both should handle the same expressions correctly
      expect(kroFactory).toBeDefined();
      expect(directFactory).toBeDefined();

      // Kro factory should generate CEL expressions
      const kroYaml = kroFactory.toYaml();
      expect(kroYaml).toContain('${kroHelmRelease.');
      
      // Direct factory should be deployable (expressions will be evaluated at runtime)
      expect(typeof directFactory.deploy).toBe('function');
    });
  });
});