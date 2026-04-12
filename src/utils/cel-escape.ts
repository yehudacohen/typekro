/**
 * Escape a string for safe embedding inside a CEL string literal.
 *
 * Handles backslash, double-quote, newline, carriage return, and tab.
 * Must be used everywhere we embed literal text in CEL output.
 *
 * This is the **single source of truth** for CEL string escaping —
 * all modules that need to produce CEL string literals should import
 * from here rather than maintaining inline copies.
 */
export function escapeCelString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}
