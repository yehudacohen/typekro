import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

describe('analysis-only resource diagnostics', () => {
  it('does not emit namespace warnings from Rook counterfactual executions', () => {
    const moduleUrl = pathToFileURL(
      resolve(import.meta.dir, '../../src/factories/rook/index.ts')
    ).href;
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        '-e',
        `import { rookCephSingleNodePlatform } from ${JSON.stringify(moduleUrl)}; rookCephSingleNodePlatform.factory('kro').toYaml();`,
      ],
      cwd: resolve(import.meta.dir, '../..'),
      env: { ...process.env, TYPEKRO_LOG_LEVEL: 'warn' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const output =
      new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);

    expect(result.exitCode).toBe(0);
    expect(output).not.toContain('no namespace specified');
    expect(output).not.toContain('CephCluster');
    expect(output).not.toContain('CephObjectStore');
  });
});
