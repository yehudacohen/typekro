/**
 * Tests for simple.Deployment features added during CollectorBills dogfooding:
 * - command: container entrypoint override
 * - args: container arguments
 * - envFrom: inject all keys from a Secret/ConfigMap as env vars
 */

import { describe, expect, it } from 'bun:test';
import { simple } from '../../src/factories/simple/index.js';

describe('simple.Deployment', () => {
  describe('command', () => {
    it('sets the container command when provided', () => {
      const deploy = simple.Deployment({
        name: 'worker',
        image: 'myapp:latest',
        command: ['bun', 'run', 'dist/worker.js'],
      });

      const container = (deploy as any).spec.template.spec.containers[0];
      expect(container.command).toEqual(['bun', 'run', 'dist/worker.js']);
    });

    it('omits command when not provided', () => {
      const deploy = simple.Deployment({
        name: 'app',
        image: 'myapp:latest',
      });

      const container = (deploy as any).spec.template.spec.containers[0];
      expect(container.command).toBeUndefined();
    });
  });

  describe('args', () => {
    it('sets container args when provided', () => {
      const deploy = simple.Deployment({
        name: 'worker',
        image: 'myapp:latest',
        args: ['--port', '8080', '--workers', '4'],
      });

      const container = (deploy as any).spec.template.spec.containers[0];
      expect(container.args).toEqual(['--port', '8080', '--workers', '4']);
    });

    it('omits args when not provided', () => {
      const deploy = simple.Deployment({
        name: 'app',
        image: 'myapp:latest',
      });

      const container = (deploy as any).spec.template.spec.containers[0];
      expect(container.args).toBeUndefined();
    });

    it('works alongside command', () => {
      const deploy = simple.Deployment({
        name: 'worker',
        image: 'myapp:latest',
        command: ['node'],
        args: ['server.js', '--port', '3000'],
      });

      const container = (deploy as any).spec.template.spec.containers[0];
      expect(container.command).toEqual(['node']);
      expect(container.args).toEqual(['server.js', '--port', '3000']);
    });
  });

  describe('envFrom', () => {
    it('sets envFrom with secretRef', () => {
      const deploy = simple.Deployment({
        name: 'app',
        image: 'myapp:latest',
        envFrom: [{ secretRef: { name: 'app-secrets' } }],
      });

      const container = (deploy as any).spec.template.spec.containers[0];
      expect(container.envFrom).toEqual([
        { secretRef: { name: 'app-secrets' } },
      ]);
    });

    it('sets envFrom with configMapRef', () => {
      const deploy = simple.Deployment({
        name: 'app',
        image: 'myapp:latest',
        envFrom: [{ configMapRef: { name: 'app-config' } }],
      });

      const container = (deploy as any).spec.template.spec.containers[0];
      expect(container.envFrom).toEqual([
        { configMapRef: { name: 'app-config' } },
      ]);
    });

    it('supports multiple envFrom sources', () => {
      const deploy = simple.Deployment({
        name: 'app',
        image: 'myapp:latest',
        envFrom: [
          { secretRef: { name: 'app-secrets' } },
          { configMapRef: { name: 'app-config' } },
        ],
      });

      const container = (deploy as any).spec.template.spec.containers[0];
      expect(container.envFrom).toHaveLength(2);
    });

    it('coexists with env', () => {
      const deploy = simple.Deployment({
        name: 'app',
        image: 'myapp:latest',
        env: { NODE_ENV: 'production' },
        envFrom: [{ secretRef: { name: 'app-secrets' } }],
      });

      const container = (deploy as any).spec.template.spec.containers[0];
      expect(container.env).toBeDefined();
      expect(container.env.length).toBeGreaterThan(0);
      expect(container.envFrom).toEqual([
        { secretRef: { name: 'app-secrets' } },
      ]);
    });

    it('omits envFrom when not provided', () => {
      const deploy = simple.Deployment({
        name: 'app',
        image: 'myapp:latest',
      });

      const container = (deploy as any).spec.template.spec.containers[0];
      expect(container.envFrom).toBeUndefined();
    });
  });
});
