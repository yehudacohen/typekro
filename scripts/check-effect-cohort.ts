const EXPECTED_EFFECT_VERSION = '4.0.0-beta.999';
const COHORT_PACKAGES = [
  'effect',
  '@effect/platform-bun',
  '@effect/platform-node-shared',
  '@effect/vitest',
] as const;

const packageJson = (await Bun.file('package.json').json()) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  overrides?: Record<string, string>;
};
const lockfile = await Bun.file('bun.lock').text();

const failures: string[] = [];
for (const packageName of COHORT_PACKAGES) {
  const declared =
    packageJson.dependencies?.[packageName] ?? packageJson.devDependencies?.[packageName];
  if (declared !== EXPECTED_EFFECT_VERSION) {
    failures.push(
      `${packageName} must be declared at ${EXPECTED_EFFECT_VERSION}; found ${declared ?? 'missing'}`
    );
  }
  if (packageJson.overrides?.[packageName] !== EXPECTED_EFFECT_VERSION) {
    failures.push(`${packageName} must be overridden to ${EXPECTED_EFFECT_VERSION}`);
  }

  const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const resolvedVersions = new Set(
    [...lockfile.matchAll(new RegExp(`"${escapedName}@([^"]+)"`, 'g'))].map((match) => match[1])
  );
  if (resolvedVersions.size !== 1 || !resolvedVersions.has(EXPECTED_EFFECT_VERSION)) {
    failures.push(
      `${packageName} must resolve exactly once at ${EXPECTED_EFFECT_VERSION}; found ${
        resolvedVersions.size === 0 ? 'nothing' : [...resolvedVersions].join(', ')
      }`
    );
  }
}

if (failures.length > 0) {
  console.error(`Effect dependency cohort check failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}

console.log(`Effect dependency cohort is coherent at ${EXPECTED_EFFECT_VERSION}.`);
