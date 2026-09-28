/**
 * Caller-supplied ClickHouse Settings
 *
 * Two build-time options let a composition set ClickHouse configuration that
 * TypeKro does not model field by field:
 *
 * - `serverSettings` — SERVER settings (`config.xml` level), e.g.
 *   `memory_worker_correct_memory_tracker` or `merge_tree/max_suspicious_broken_parts`.
 *   They ride the CHI's `configuration.settings`, which the clickhouse-operator
 *   renders into `config.d/chop-generated-settings.xml`: a path key
 *   `a/b` becomes `<a><b>value</b></a>`.
 * - `systemLogs.tables.<log>.settings` — MergeTree settings for ONE of
 *   ClickHouse's own `system.*_log` tables, rendered into that log's
 *   `<settings>` element (or into its engine's `SETTINGS` clause, for the logs
 *   the operator gives a full `<engine>`). See `./system-logs.ts`.
 *
 * Both end up as ClickHouse server configuration TEXT, and the operator writes
 * `configuration.settings` values into that XML VERBATIM — no escaping. So the
 * rules here are VALIDATION, not encoding:
 *
 * - a key is rendered as an XML ELEMENT NAME, which has no escape form, so
 *   every path segment must be a bare identifier;
 * - a string value must not contain `<`, `>` or `&` (and must be representable
 *   in XML at all), because it lands in the document unescaped;
 * - a number must render as a plain decimal (`1e21` is not something
 *   ClickHouse's config parser reads back as a number);
 * - a boolean renders as `1` / `0`, the form every ClickHouse boolean setting
 *   accepts.
 *
 * @module
 */

import { assertXmlRepresentable } from './xml.js';

/** A setting value as a caller writes it. */
export type ClickHouseSettingValue = string | number | boolean;

/** A settings map as it arrives from a `Composable<...>` config. */
export type ClickHouseSettingsInput = Readonly<Record<string, ClickHouseSettingValue | undefined>>;

/**
 * One path segment of a setting name: a letter or underscore, then letters,
 * digits or underscores. Every ClickHouse server and MergeTree setting name
 * has this shape, and it is also a legal XML element name.
 */
export const CLICKHOUSE_SETTING_NAME_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Upper bound on a setting key, as a sanity check on the rendered config. */
export const CLICKHOUSE_SETTING_KEY_MAX_LENGTH = 256;

/**
 * Top-level configuration sections the clickhouse-operator generates itself
 * (`remote_servers`, `macros`) or that TypeKro renders from a dedicated option
 * (`zookeeper`, from `keeper`). A `serverSettings` key inside one of them would
 * be merged into the generated section and silently change the cluster
 * topology, so it is refused with a pointer to the option that owns it.
 */
export const CLICKHOUSE_RESERVED_SERVER_SETTING_SECTIONS: Readonly<Record<string, string>> = {
  remote_servers: 'the clickhouse-operator generates it from the cluster layout',
  macros: 'the clickhouse-operator generates it per replica',
  zookeeper: 'it is rendered from the `keeper` option',
};

/** Characters the operator would write into the server's XML unescaped. */
const XML_SPECIAL = /[<>&]/;

/**
 * Validate a setting value and render it as the text ClickHouse reads back.
 *
 * @param context - Caller and option path, quoted into errors
 *   (e.g. `makeClickHouseCluster: serverSettings.max_concurrent_queries`)
 * @param value - The raw value
 * @returns The value as configuration text (`1`/`0` for booleans)
 */
export function renderClickHouseSettingValue(context: string, value: unknown): string {
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') {
    const text = String(value);
    if (!Number.isFinite(value) || /e/i.test(text)) {
      throw new Error(
        `${context} must be a finite number that renders as a plain decimal (got ${text}). ` +
          `Pass very large or very small values as a string, e.g. '1099511627776'.`
      );
    }
    return text;
  }
  if (typeof value === 'string') {
    if (XML_SPECIAL.test(value)) {
      throw new Error(
        `${context} must not contain '<', '>' or '&' (got ${JSON.stringify(value)}): the ` +
          `clickhouse-operator writes setting values into the server's XML configuration ` +
          `unescaped, so the server would fail to parse its config at startup.`
      );
    }
    try {
      assertXmlRepresentable(value);
    } catch (error) {
      throw new Error(`${context}: ${(error as Error).message}`);
    }
    return value;
  }
  throw new Error(
    `${context} must be a string, a number or a boolean (got ${
      value === null ? 'null' : typeof value
    }).`
  );
}

/**
 * Validate a setting KEY: `/`-separated path segments, each a bare identifier.
 *
 * @param context - Caller and option name, quoted into errors
 * @param key - The raw key
 * @param allowPath - Whether `/` path separators are allowed (server settings
 *   are path-keyed; a MergeTree setting name is a single segment)
 */
export function assertClickHouseSettingKey(context: string, key: string, allowPath: boolean): void {
  const segments = allowPath ? key.split('/') : [key];
  const valid =
    key.length > 0 &&
    key.length <= CLICKHOUSE_SETTING_KEY_MAX_LENGTH &&
    segments.every((segment) => CLICKHOUSE_SETTING_NAME_SEGMENT.test(segment));
  if (valid) return;
  throw new Error(
    `${context}: setting name ${JSON.stringify(key)} is not valid. ` +
      (allowPath ? `It must be one or more '/'-separated segments, each ` : `It must be `) +
      `a letter or underscore followed by letters, digits or underscores (at most ` +
      `${CLICKHOUSE_SETTING_KEY_MAX_LENGTH} characters). The name is rendered as an XML ` +
      `element name in the server's configuration, where escaping is not available.`
  );
}

/**
 * Validate and render a caller's `serverSettings`.
 *
 * @param factoryName - Caller name, quoted into errors
 * @param settings - The caller's map, if any
 * @param options.generated - Settings TypeKro already renders into
 *   `configuration.settings` for this installation. A caller key equal to one
 *   of them, or a path prefix/extension of one (which would give one element
 *   both text and children), is refused rather than silently overriding it.
 * @param options.ownedSections - Top-level sections owned by a dedicated
 *   TypeKro option, mapped to that option's name. Keys under them are refused
 *   with a pointer to the option.
 * @returns The settings as `configuration.settings` entries (string values)
 */
export function resolveClickHouseServerSettings(
  factoryName: string,
  settings: ClickHouseSettingsInput | undefined,
  options: {
    readonly generated: Readonly<Record<string, unknown>>;
    readonly ownedSections: Readonly<Record<string, string>>;
  }
): Record<string, string> {
  if (settings === undefined) return {};
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error(`${factoryName}: serverSettings must be an object of setting name to value.`);
  }

  const rendered: Record<string, string> = {};
  const generatedKeys = Object.keys(options.generated);
  for (const [key, value] of Object.entries(settings)) {
    if (value === undefined) continue;
    const context = `${factoryName}: serverSettings.${key}`;
    assertClickHouseSettingKey(`${factoryName}: serverSettings`, key, true);

    const section = key.split('/')[0] as string;
    const reserved = CLICKHOUSE_RESERVED_SERVER_SETTING_SECTIONS[section];
    if (reserved !== undefined) {
      throw new Error(
        `${context}: the <${section}> section cannot be set through serverSettings — ${reserved}.`
      );
    }
    const owner = options.ownedSections[section];
    if (owner !== undefined) {
      throw new Error(
        `${context}: the <${section}> section is configured through \`${owner}\`, not ` +
          `serverSettings.`
      );
    }
    const clash = generatedKeys.find(
      (generated) =>
        generated === key || generated.startsWith(`${key}/`) || key.startsWith(`${generated}/`)
    );
    if (clash !== undefined) {
      throw new Error(
        `${context}: collides with the '${clash}' setting TypeKro renders from another ` +
          `option. Configure it through that option instead.`
      );
    }
    rendered[key] = renderClickHouseSettingValue(context, value);
  }

  // Two caller keys can collide with each other the same way (`a` and `a/b`).
  const keys = Object.keys(rendered);
  for (const key of keys) {
    const nested = keys.find((other) => other.startsWith(`${key}/`));
    if (nested !== undefined) {
      throw new Error(
        `${factoryName}: serverSettings keys '${key}' and '${nested}' conflict: one would ` +
          `render as an element with both a value and child elements.`
      );
    }
  }
  return rendered;
}
