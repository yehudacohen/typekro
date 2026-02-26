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
