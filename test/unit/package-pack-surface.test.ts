import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const workspace = resolve(import.meta.dirname, '..', '..');

interface DeclaredPackSurface {
  exclusions: string[];
  inclusions: string[];
}

function readDeclaredPackSurface(): DeclaredPackSurface {
  const packageJson = JSON.parse(
    readFileSync(resolve(workspace, 'package.json'), 'utf8')
  ) as { files?: unknown };
  if (!Array.isArray(packageJson.files)) {
    throw new Error('package.json must declare a "files" pack surface.');
  }
  const inclusions: string[] = [];
  const exclusions: string[] = [];
  for (const entry of packageJson.files) {
    if (typeof entry !== 'string' || entry.length === 0) continue;
    if (entry.startsWith('!')) exclusions.push(entry.slice(1));
    else inclusions.push(entry);
  }
  return { exclusions, inclusions };
}

function runOrThrow(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    cwd: workspace,
    encoding: 'utf8',
  });
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${String(result.status)}).\n${stdout}${stderr}`
    );
  }
  return stdout;
}

function ensureBuiltDist(): void {
  if (existsSync(resolve(workspace, 'dist', 'index.js'))) return;
  runOrThrow('bun', ['run', 'build:lib']);
}

function readOwnerPackSurface(): string[] {
  ensureBuiltDist();
  const output = runOrThrow('bun', ['pm', 'pack', '--dry-run', '--ignore-scripts']);
  const members: string[] = [];
  for (const line of output.split('\n')) {
    const match = /^packed\s+\S+\s+(.+?)\s*$/.exec(line);
    if (match?.[1]) members.push(match[1]);
  }
  return members;
}

describe('published pack surface excludes compiler cache metadata', () => {
  it('declares a build-info exclusion on the actual pack surface', () => {
    const { exclusions, inclusions } = readDeclaredPackSurface();
    expect(inclusions).toContain('dist');
    expect(exclusions.some((pattern) => pattern.includes('tsbuildinfo'))).toBe(true);
  });

  it('keeps noEmit typechecks from seeding incremental build-info', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(workspace, 'package.json'), 'utf8')
    ) as { scripts?: unknown };
    if (typeof packageJson.scripts !== 'object' || packageJson.scripts === null) {
      throw new Error('package.json must declare a "scripts" table.');
    }
    const scripts = packageJson.scripts as Record<string, unknown>;
    for (const name of ['typecheck:lib', 'typecheck:examples', 'typecheck:tests']) {
      const command = scripts[name];
      expect(typeof command === 'string' && command.includes('--noEmit')).toBe(true);
      // A noEmit check that writes dist/.tsbuildinfo perturbs the next emit's
      // declaration output, so the check must run with incremental disabled.
      expect(typeof command === 'string' && command.includes('--incremental false')).toBe(true);
    }
  });

  it(
    'keeps build-info out of the owner pack surface while shipping runtime, declarations and maps',
    () => {
      const members = readOwnerPackSurface();
      // Guard against a vacuous pass on an empty or unbuilt surface.
      expect(members.length).toBeGreaterThan(1000);
      const buildInfoMembers = members.filter((member) => member.endsWith('.tsbuildinfo'));
      expect(buildInfoMembers).toEqual([]);
      for (const shippedPath of [
        'dist/index.js',
        'dist/index.d.ts',
        'dist/index.js.map',
        'dist/index.d.ts.map',
        'dist/factories/simple/index.js',
      ]) {
        expect(members).toContain(shippedPath);
      }
    },
    300000
  );
});
