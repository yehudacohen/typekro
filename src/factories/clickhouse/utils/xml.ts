/**
 * Minimal XML escaping for the ClickHouse server-configuration documents this
 * factory family renders by hand (`config.d/*.xml`).
 *
 * Hand-rolled rather than pulled from a builder library on purpose: the
 * documents are a fixed handful of elements whose SHAPE is part of the
 * factory's contract (the tests pin the rendered bytes), so a builder would add
 * a dependency and a formatting policy without removing the one thing that
 * actually needs care — deciding, per interpolation site, whether the value is
 * escapable at all.
 *
 * ## The rule these two helpers exist to make explicit
 *
 * XML has three interpolation positions, and only two of them can be escaped:
 *
 * - TEXT (`<endpoint>value</endpoint>`) — escapable, use {@link xmlText}.
 * - ATTRIBUTE VALUE (`from_env="value"`) — escapable, use {@link xmlAttr}.
 * - ELEMENT NAME (`<value>`) — **not escapable**. There is no encoding that
 *   makes an arbitrary string a legal element name: a `>` closes the tag, a
 *   space starts an attribute, and a leading digit is simply not a Name. A
 *   value landing here must be VALIDATED instead — see
 *   `assertClickHouseIdentifier` in `./validation.ts`.
 */

/**
 * Escape a value for XML TEXT content.
 *
 * Escapes all five predefined entities, not just the three that text position
 * strictly requires: `"` and `'` are legal in text, but escaping them keeps one
 * behaviour for both positions and makes {@link xmlAttr} a pure extension of
 * this function rather than a divergent second escaper.
 *
 * A carriage return is escaped numerically because XML line-ending
 * normalization (spec 2.11) would otherwise rewrite a literal CR to LF while
 * parsing, silently changing the value ClickHouse reads back.
 *
 * @param value - The raw value
 * @returns The value, safe to place between an open and close tag
 */
export function xmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/\r/g, '&#13;');
}

/**
 * Escape a value for an XML ATTRIBUTE value (assumed double-quoted).
 *
 * Everything {@link xmlText} does, plus numeric escapes for tab and newline:
 * attribute-value normalization (spec 3.3.3) replaces a literal tab, newline or
 * carriage return inside an attribute with a SPACE, so an unescaped one is a
 * value change rather than a parse error — the quiet failure mode.
 *
 * @param value - The raw value
 * @returns The value, safe to place inside `"…"`
 */
export function xmlAttr(value: string): string {
  // Safe to layer on xmlText: its `&` pass runs before any of the numeric
  // escapes are introduced, so the `&` of a `&#NN;` is never double-escaped.
  return xmlText(value).replace(/\t/g, '&#9;').replace(/\n/g, '&#10;');
}
