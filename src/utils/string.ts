/**
 * String manipulation utilities
 *
 * Pure, zero-dependency string helpers used across the codebase.
 * This module intentionally has NO imports from other TypeKro modules
 * to prevent circular dependency chains.
 */

/**
 * Converts a kebab-case or snake_case string to camelCase.
 */
export function toCamelCase(str: string): string {
  if (!str) {
    return '';
  }

  return str
    .split(/[-_]/)
    .map((word, index) => {
      if (index === 0) {
        return word.charAt(0).toLowerCase() + word.slice(1);
      }
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join('');
}

/**
 * Converts a string to PascalCase.
 */
export function pascalCase(str: string): string {
  return str
    .split(/[-_\s]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join('');
}

/**
 * Calculate the Levenshtein distance between two strings.
 * Useful for suggesting similar names when a user makes a typo.
 */
export function levenshteinDistance(str1: string, str2: string): number {
  const rows = str2.length + 1;
  const cols = str1.length + 1;
  const matrix: number[][] = Array(rows)
    .fill(null)
    .map(() => Array(cols).fill(0) as number[]);

  // Safe: matrix[0] always exists since rows >= 1
  const firstRow = matrix[0] as number[];
  for (let i = 0; i <= str1.length; i++) firstRow[i] = i;
  for (let j = 0; j <= str2.length; j++) (matrix[j] as number[])[0] = j;

  for (let j = 1; j <= str2.length; j++) {
    const currentRow = matrix[j] as number[];
    const previousRow = matrix[j - 1] as number[];
    for (let i = 1; i <= str1.length; i++) {
      const indicator = str1[i - 1] === str2[j - 1] ? 0 : 1;
      currentRow[i] = Math.min(
        (currentRow[i - 1] ?? 0) + 1, // deletion
        (previousRow[i] ?? 0) + 1, // insertion
        (previousRow[i - 1] ?? 0) + indicator // substitution
      );
    }
  }

  return (matrix[str2.length] as number[])[str1.length] ?? 0;
}

/**
 * Calculate similarity between two strings as a ratio (0.0 to 1.0)
 * based on Levenshtein distance.
 */
export function calculateSimilarity(str1: string, str2: string): number {
  const longer = str1.length > str2.length ? str1 : str2;
  const shorter = str1.length > str2.length ? str2 : str1;

  if (longer.length === 0) return 1.0;

  const distance = levenshteinDistance(longer, shorter);
  return (longer.length - distance) / longer.length;
}

/**
 * Ensures a version string has a 'v' prefix.
 * Many container images require version tags with 'v' prefix (e.g., 'v0.14.0').
 */
export function ensureVersionPrefix(version: string): string {
  return version.startsWith('v') ? version : `v${version}`;
}
