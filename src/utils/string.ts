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
  const matrix: number[][] = Array(str2.length + 1)
    .fill(null)
    .map(() => Array(str1.length + 1).fill(0));

  for (let i = 0; i <= str1.length; i++) matrix[0]![i] = i;
  for (let j = 0; j <= str2.length; j++) matrix[j]![0] = j;

  for (let j = 1; j <= str2.length; j++) {
    for (let i = 1; i <= str1.length; i++) {
      const indicator = str1[i - 1] === str2[j - 1] ? 0 : 1;
      matrix[j]![i] = Math.min(
        matrix[j]?.[i - 1]! + 1, // deletion
        matrix[j - 1]?.[i]! + 1, // insertion
        matrix[j - 1]?.[i - 1]! + indicator // substitution
      );
    }
  }

  return matrix[str2.length]?.[str1.length]!;
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
