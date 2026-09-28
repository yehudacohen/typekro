// Caller-supplied ClickHouse settings: `serverSettings` (the CHI's
// `configuration.settings`, which the clickhouse-operator renders into
// `config.d/chop-generated-settings.xml`, a path key `a/b` becoming
// `<a><b>value</b></a>`) and `systemLogs.tables.<log>.settings` (see
// ./system-logs.ts).
//
// Both end up as server configuration TEXT, and the operator writes
// `configuration.settings` values into that XML VERBATIM. So the rules here are
// VALIDATION, not encoding: a key is an XML ELEMENT NAME (no escape form), so
// every path segment must be a bare identifier; a string value must not contain
// `<`, `>` or `&` and must be representable in XML; a number must render as a
// plain decimal (`1e21` does not read back as a number); a boolean renders as
// `1`/`0`, which every ClickHouse boolean setting accepts.

import { assertXmlRepresentable } from './xml.js';

/** A setting value as a caller writes it. */
export type ClickHouseSettingValue = string | number | boolean;

/** A settings map as it arrives from a `Composable<...>` config. */
export type ClickHouseSettingsInput = Readonly<Record<string, ClickHouseSettingValue | undefined>>;

// One path segment of a setting name. Every ClickHouse server and MergeTree
// setting name has this shape, and it is also a legal XML element name.
const CLICKHOUSE_SETTING_NAME_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

const CLICKHOUSE_SETTING_KEY_MAX_LENGTH = 256;

// Sections the operator generates (`remote_servers`, `macros`) or TypeKro
// renders from a dedicated option (`zookeeper`, from `keeper`). A key inside
// one would merge into the generated section and silently change the topology.
const CLICKHOUSE_RESERVED_SERVER_SETTING_SECTIONS: Readonly<Record<string, string>> = {
  remote_servers: 'the clickhouse-operator generates it from the cluster layout',
  macros: 'the clickhouse-operator generates it per replica',
  zookeeper: 'it is rendered from the `keeper` option',
};

/** Characters the operator would write into the server's XML unescaped. */
const XML_SPECIAL = /[<>&]/;

/** Validate a setting value and render it as configuration text (`1`/`0` for booleans). */
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

/** Validate a setting name: bare identifier segments, `/`-separated when `allowPath`. */
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
 * Validate and render a caller's `serverSettings` as `configuration.settings`
 * entries. Keys equal to, or a path prefix/extension of, a `generated` key, and
 * keys in an `ownedSections` section, are refused.
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
