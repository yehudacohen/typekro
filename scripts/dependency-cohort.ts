export function resolvedLockVersions(lockfile: string, packageName: string): Set<string> {
  const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = lockfile.matchAll(new RegExp(`"${escapedName}@([^\"]+)"`, 'g'));

  return new Set([...matches].flatMap((match) => (match[1] === undefined ? [] : [match[1]])));
}
