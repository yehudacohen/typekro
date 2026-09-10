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
 *
 * ## Escaping is not the only failure mode: some characters have no encoding
 *
 * A second, easily-missed rule cuts across both escapable positions. Escaping
 * answers "how do I write this character so the parser reads it back as data",
 * and for a handful of characters the answer is THERE IS NO WAY — XML 1.0's
 * `Char` production simply excludes them, and a numeric character reference to
 * an excluded code point is itself a well-formedness error (spec 4.1). So a NUL
 * in a cache path survives escaping unchanged and then makes `xmllint` and
 * ClickHouse's own config parser reject `config.d/storage.xml` at server
 * startup — a build that "succeeded" producing a server that will not boot.
 * Both helpers therefore REFUSE such a value at construction time; see
 * {@link assertXmlRepresentable}.
 */

/**
 * The characters XML 1.0 cannot represent at all, as a readable rule.
 *
 * The spec's `Char` production is
 * `#x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF]`,
 * so the complement is: the C0 controls other than tab/LF/CR, the surrogate
 * range (reachable from a JavaScript string only as a LONE surrogate — a
 * well-formed pair is one `[#x10000-#x10FFFF]` character and is legal), and the
 * two `#xFFFE`/`#xFFFF` non-characters.
 */
const XML_FORBIDDEN_RULE =
  '#x0-#x8, #xB, #xC, #xE-#x1F, a lone surrogate (#xD800-#xDFFF), #xFFFE or #xFFFF';

/** Format a UTF-16 code unit as the `U+XXXX` form error messages quote. */
function codePointLabel(unit: number): string {
  return `U+${unit.toString(16).toUpperCase().padStart(4, '0')}`;
}

function rejectForbidden(value: string, index: number, unit: number, why: string): never {
  throw new Error(
    `xml: value contains ${codePointLabel(unit)} (${why}) at index ${index}, which XML 1.0 ` +
      `cannot represent in any form — escaping does not help, and a numeric character ` +
      `reference to it is itself a well-formedness error (XML 1.0 §2.2/§4.1), so ` +
      `\`config.d/*.xml\` would be rejected by the server's parser at startup. Forbidden: ` +
      `${XML_FORBIDDEN_RULE}. Got ${JSON.stringify(value)}.`
  );
}

/**
 * Assert a value can appear in an XML document at all.
 *
 * Scanned by code unit rather than matched with a regex so the error can name
 * the exact INDEX and code point — with a NUL or a `\x01` in the middle of a
 * path, "the value is invalid" is not a debuggable message.
 *
 * Tab, LF and CR are allowed: they are legal `Char`s, and {@link xmlText} /
 * {@link xmlAttr} already escape them numerically wherever the parser would
 * otherwise rewrite them.
 *
 * @param value - The raw value about to be escaped
 * @throws Error naming the index and code point of the first character XML 1.0
 *   forbids
 */
export function assertXmlRepresentable(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    // The three C0 controls the spec keeps. Escaped, not rejected.
    if (unit === 0x09 || unit === 0x0a || unit === 0x0d) continue;
    if (unit <= 0x1f) rejectForbidden(value, index, unit, 'a C0 control character');
    if (unit >= 0xd800 && unit <= 0xdbff) {
      // A high surrogate followed by a low one is ONE astral character, which
      // the `Char` production allows; anything else is a lone surrogate and is
      // not a character at all.
      const low = value.charCodeAt(index + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) {
        rejectForbidden(value, index, unit, 'an unpaired high surrogate');
      }
      index += 1;
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      rejectForbidden(value, index, unit, 'an unpaired low surrogate');
    }
    if (unit === 0xfffe || unit === 0xffff) {
      rejectForbidden(value, index, unit, 'a non-character');
    }
  }
}

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
 * @throws Error when the value contains a character XML 1.0 forbids outright
 *   (see {@link assertXmlRepresentable}) — such a character has no escape, so
 *   the only correct answer is to refuse it here
 */
export function xmlText(value: string): string {
  assertXmlRepresentable(value);
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
 * @throws Error when the value contains a character XML 1.0 forbids outright —
 *   inherited from {@link xmlText}, which runs
 *   {@link assertXmlRepresentable} before escaping anything
 */
export function xmlAttr(value: string): string {
  // Safe to layer on xmlText: its `&` pass runs before any of the numeric
  // escapes are introduced, so the `&` of a `&#NN;` is never double-escaped.
  // The representability check comes from the same call, which is why this
  // function does not repeat it — one scan, one rule, no chance of the two
  // positions drifting apart on which characters they accept.
  return xmlText(value).replace(/\t/g, '&#9;').replace(/\n/g, '&#10;');
}
