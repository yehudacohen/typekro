import { describe, expect, it } from 'bun:test';

const lockfileUrl = new URL('../../bun.lock', import.meta.url);
const packageUrl = new URL('../../package.json', import.meta.url);

function atLeastJsYamlPatch(version: string): boolean {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map(Number);
  return major > 4 || (major === 4 && (minor > 3 || (minor === 3 && patch >= 1)));
}

describe('dependency security invariants', () => {
  it('pins every frozen js-yaml installation to 4.3.1 or newer', async () => {
    const manifest = (await Bun.file(packageUrl).json()) as {
      dependencies?: Record<string, string>;
      overrides?: Record<string, string>;
    };
    expect(manifest.dependencies?.['js-yaml']).toBe('4.3.1');
    expect(manifest.overrides?.['js-yaml']).toBe('4.3.1');

    const lockfile = await Bun.file(lockfileUrl).text();
    const installedVersions = [
      ...lockfile.matchAll(/"(?:[^"]+\/)?js-yaml": \["js-yaml@(\d+\.\d+\.\d+)"/g),
    ].map((match) => match[1]!);

    expect(installedVersions.length).toBeGreaterThan(0);
    expect(installedVersions.every(atLeastJsYamlPatch)).toBe(true);
  });

  it('pins angular-expressions to its patched release', async () => {
    const manifest = (await Bun.file(packageUrl).json()) as {
      dependencies?: Record<string, string>;
    };
    expect(manifest.dependencies?.['angular-expressions']).toBe('1.5.2');

    const lockfile = await Bun.file(lockfileUrl).text();
    expect(lockfile).toContain(
      '"angular-expressions": ["angular-expressions@1.5.2"',
    );
  });
});
