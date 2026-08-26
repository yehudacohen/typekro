import { describe, expect, it } from 'bun:test';
import { resolvedLockVersions } from '../../scripts/dependency-cohort.js';

describe('dependency cohort lockfile inspection', () => {
  it('finds every distinct resolved version of an unscoped package', () => {
    const lockfile = `
      "alchemy": ["alchemy@2.0.0-beta.74", ""]
      "nested/alchemy": ["alchemy@2.0.0-beta.58", ""]
    `;

    expect([...resolvedLockVersions(lockfile, 'alchemy')].sort()).toEqual([
      '2.0.0-beta.58',
      '2.0.0-beta.74',
    ]);
  });

  it('finds every distinct resolved version of a scoped package', () => {
    const lockfile = `
      "@distilled.cloud/aws": ["@distilled.cloud/aws@1.0.0-rc.6", ""]
      "nested/@distilled.cloud/aws": ["@distilled.cloud/aws@1.0.0-rc.5", ""]
    `;

    expect([...resolvedLockVersions(lockfile, '@distilled.cloud/aws')].sort()).toEqual([
      '1.0.0-rc.5',
      '1.0.0-rc.6',
    ]);
  });
});
