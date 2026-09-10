/**
 * Composition of the gateway collector's `custom.config.yaml` overlay.
 *
 * The ClickStack chart renders `global.otelCollector.customConfig` verbatim
 * into a ConfigMap, mounts it at
 * `/etc/otelcol-contrib/custom/custom.config.yaml`, and the OpAMP supervisor
 * merges that file into the remote configuration it hands the agent. It is one
 * YAML DOCUMENT, so every contributor to it has to land in ONE mapping.
 *
 * ⚠️ WHY THIS MODULE EXISTS — LIVE FINDING. The overlay used to be assembled by
 * CONCATENATING two hand-written YAML strings: the ingest pipelines
 * (`CLICKSTACK_INGEST_PIPELINES_CONFIG` in `helm-values-mapper.ts`) and the
 * persistent queue's own wiring (`renderPersistentQueueConfig` in
 * `storage.ts`). Both open a top-level `service:` key, so the concatenated
 * document declared `service` twice and the supervisor rejected the WHOLE FILE
 * on every poll:
 *
 *   Could not merge local config file: /etc/otelcol-contrib/custom/custom.config.yaml
 *   yaml: unmarshal errors: line 18: mapping key "service" already defined at line 1
 *
 * The agent then ran with NEITHER the ingest pipelines NOR the queue — while
 * the Pod still reported Ready, because readiness comes from the supervisor's
 * `health_check` and not from the agent. Enabling the persistent queue was a
 * silent no-op that also took OTLP ingestion down.
 *
 * So fragments are STRUCTURED OBJECTS here, deep-merged into a single document
 * and serialised exactly once. Duplicate keys are unrepresentable: a colliding
 * mapping key is either merged (two mappings, two sequences) or a loud
 * construction-time error (anything else).
 *
 * ⚠️ THE MERGE IS A PUBLIC ENTRY POINT, so it treats fragment keys as
 * UNTRUSTED. Names in a fragment come from caller options
 * (`storage.persistentQueue.exporterNames`, `.extensions`) and become object
 * keys, and JavaScript reserves a few of those — see
 * {@link UNSAFE_MAPPING_KEYS} for the two live failure modes (a mutated
 * `Object.prototype`, and a key the serialiser drops) and why the fix is a
 * refusal plus null-prototype dictionaries rather than a filter.
 */

import * as yaml from 'js-yaml';

/** One structured contribution to the collector overlay. */
export type CollectorConfigFragment = Record<string, unknown>;

/**
 * Nesting level from which sequences are emitted in flow style.
 *
 * Purely cosmetic — block and flow sequences parse identically. The value 4 is
 * the depth of a pipeline's `receivers` list
 * (`service` → `pipelines` → `<pipeline>` → `receivers`), so the rendered
 * overlay keeps the inline `receivers: [fluentforward, otlp/hyperdx]` spelling
 * the hand-written constant used and the collector's own docs show, and the
 * no-queue rendering comes out BYTE-IDENTICAL to the pre-merge one.
 */
const RECEIVER_LIST_FLOW_LEVEL = 4;

/**
 * Mapping keys this module refuses to carry, anywhere in a fragment.
 *
 * ⚠️ WHY A REFUSAL AND NOT A SILENT SKIP. Two of these are load-bearing in
 * JavaScript's own object model, and both failure modes were real here:
 *
 * - `__proto__` on a plain object is an ACCESSOR inherited from
 *   `Object.prototype`, and BOTH halves of it bit:
 *   - Its GETTER. The merge tested `key in target` — true for `'__proto__'` on
 *     any plain object, inherited — then read `target.__proto__`, which IS
 *     `Object.prototype`, saw a mapping on both sides and recursed. A single
 *     fragment with a top-level `__proto__` key wrote its sub-mapping straight
 *     into `Object.prototype`, process-wide.
 *   - Its SETTER. The clone built copies as plain `{}` and assigned
 *     `copy[key] = …`, so a `__proto__` key silently RE-PARENTED the copy
 *     instead of adding a key to it. That is where an
 *     `exporterNames: ['__proto__']` entry went: `Object.fromEntries` had
 *     honestly defined an own `__proto__` property, the clone dropped it on the
 *     floor, and the overlay rendered `exporters: {}` — a queue that configured
 *     nothing and reported nothing, which is precisely the class of silent
 *     misconfiguration this module exists to remove.
 * - `constructor` and `prototype` are here for the same reason one level out:
 *   they are inherited/own members whose presence makes `in`, property reads
 *   and any future map lookup mean something other than "the config said so".
 *
 * None of the three is a legal OpenTelemetry Collector component name, an
 * extension name or a pipeline name, so nothing legitimate is lost. A fragment
 * carrying one is a construction-time bug (or an attempt), and it is reported
 * as one, naming the path.
 */
const UNSAFE_MAPPING_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];

/**
 * Reject a mapping key that would mean something to the object model.
 *
 * @param key - The candidate mapping key
 * @param path - Path segments of the key's parent, for the error message
 * @throws Error when the key is one of {@link UNSAFE_MAPPING_KEYS}
 */
export function assertSafeCollectorConfigKey(key: string, path: readonly string[] = []): void {
  if (!UNSAFE_MAPPING_KEYS.includes(key)) return;
  const here = [...path, key].join('.');
  throw new Error(
    `Unsafe collector configuration key at '${here}': '${key}' is a JavaScript object-model ` +
      `member, not a collector component name. A mapping key named ` +
      `${UNSAFE_MAPPING_KEYS.map((name) => `'${name}'`).join(', ')} either mutates ` +
      `Object.prototype while the overlay is built or vanishes from it silently, so it is ` +
      `refused here instead of misconfiguring the collector without saying so.`
  );
}

/** A dictionary with NO prototype: `__proto__` cannot be an accessor on it. */
function emptyDict(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Own, enumerable string keys of a mapping, each checked before it is used.
 *
 * `Object.keys` never reports an inherited property, so this is the only way a
 * key enters the merge — an inherited `constructor` or the `__proto__` accessor
 * on `Object.prototype` is invisible here by construction.
 */
function safeKeys(source: Record<string, unknown>, path: readonly string[]): string[] {
  const keys = Object.keys(source);
  for (const key of keys) assertSafeCollectorConfigKey(key, path);
  return keys;
}

/**
 * Structural copy of a fragment value.
 *
 * ⚠️ WHY MERGING MUST COPY. Fragments are long-lived module constants —
 * `CLICKSTACK_INGEST_PIPELINES_FRAGMENT` is built once at import time and used
 * by every composition in the process. Adopting an incoming sub-object BY
 * REFERENCE means the next merge writes the queue's `service.extensions`
 * straight into that shared constant, so the second install in a process
 * inherits the first one's overlay and a queue-free install silently grows a
 * queue's extension list. Caught by the "merging does not mutate its inputs"
 * test; the fragments themselves stay frozen-in-practice because nothing here
 * ever writes to them.
 */
function cloneValue(value: unknown, path: readonly string[] = []): unknown {
  if (Array.isArray(value))
    return value.map((item, index) => cloneValue(item, [...path, `${index}`]));
  if (isPlainObject(value)) {
    // A NULL-PROTOTYPE copy: on a plain `{}` the assignment `copy.__proto__ = x`
    // is a call to the inherited setter and silently re-parents the copy
    // instead of adding a key. With no prototype there is no setter to call —
    // and `safeKeys` has already refused the key anyway, so the two guards are
    // independent.
    const copy = emptyDict();
    for (const key of safeKeys(value, path)) copy[key] = cloneValue(value[key], [...path, key]);
    return copy;
  }
  return value;
}

/** Order-preserving union — the merge policy for every sequence in the overlay. */
function unionSequences(
  left: readonly unknown[],
  right: readonly unknown[],
  path: readonly string[]
): unknown[] {
  const merged: unknown[] = [];
  const seen = new Set<string>();
  for (const item of [...left, ...right]) {
    const key = JSON.stringify(item ?? null);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(cloneValue(item, path));
  }
  return merged;
}

/**
 * Deep-merge collector overlay fragments into one document.
 *
 * EXPLICIT CONFLICT POLICY, because a silent winner here is exactly the class
 * of bug this module was written to remove:
 *
 * - **mapping + mapping** → merged key by key, recursively.
 * - **sequence + sequence** → concatenated, de-duplicated, order preserved.
 *   This is what makes `service.extensions` composable: a fragment that needs
 *   `file_storage/hyperdx` adds it without erasing what another fragment
 *   contributed. (It does NOT change the fact that the overlay's list REPLACES
 *   the supervisor's own — that merge happens later, inside the supervisor.)
 * - **identical scalars** → kept.
 * - **anything else** → THROWS, naming the path and both values. Two fragments
 *   disagreeing about a scalar (or about whether a key is a map, a list or a
 *   scalar) is a construction-time bug, and guessing which one wins would put
 *   the collector back into the silent-misconfiguration territory above.
 *
 * The result is a fresh structure: no fragment is mutated and nothing in the
 * result aliases one, so a module-level fragment constant can be merged any
 * number of times — see {@link cloneValue}.
 *
 * Every mapping in the result is a NULL-PROTOTYPE dictionary and every key is
 * checked against {@link UNSAFE_MAPPING_KEYS} before it is used, at every
 * depth. A fragment carrying `__proto__`, `constructor` or `prototype` as a
 * mapping key is refused with the path named — it cannot reach
 * `Object.prototype`, and it cannot be quietly dropped by the serialiser
 * either.
 *
 * @param fragments - Structured overlay fragments, in precedence-free order
 * @returns One merged configuration object (prototype-less at every level)
 * @throws Error when two fragments set the same path to incompatible values,
 *   or when any fragment uses an object-model member as a mapping key
 */
export function mergeCollectorConfig(
  fragments: readonly CollectorConfigFragment[]
): CollectorConfigFragment {
  const merged = emptyDict();
  for (const fragment of fragments) {
    mergeInto(merged, fragment, []);
  }
  return merged;
}

function mergeInto(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  path: readonly string[]
): void {
  for (const key of safeKeys(source, path)) {
    const incoming = source[key];
    const here = [...path, key];
    // `Object.hasOwn`, never `key in target`: `'__proto__' in {}` is TRUE
    // (inherited accessor) and `'constructor' in {}` is too, so the `in` test
    // used to send those keys down the "already present, merge into it" path
    // and hand `mergeInto` `Object.prototype` as its target. Own-property
    // checks only, on dictionaries that have no prototype to inherit from.
    if (!Object.hasOwn(target, key)) {
      // COPY, never adopt: `incoming` belongs to a fragment the caller may
      // reuse — see {@link cloneValue}.
      target[key] = cloneValue(incoming, here);
      continue;
    }
    const existing = target[key];
    if (isPlainObject(existing) && isPlainObject(incoming)) {
      mergeInto(existing, incoming, here);
      continue;
    }
    if (Array.isArray(existing) && Array.isArray(incoming)) {
      target[key] = unionSequences(existing, incoming, here);
      continue;
    }
    if (JSON.stringify(existing ?? null) === JSON.stringify(incoming ?? null)) continue;
    throw new Error(
      `Conflicting collector configuration at '${here.join('.')}': ` +
        `${JSON.stringify(existing)} vs ${JSON.stringify(incoming)}. Collector overlay ` +
        `fragments may only extend each other (mappings merge, sequences concatenate); ` +
        `two fragments cannot set the same key to different values.`
    );
  }
}

/**
 * Merge overlay fragments and serialise them ONCE.
 *
 * The single `yaml.dump` is the point: a rendered overlay can no longer carry
 * a duplicate top-level key, whatever its fragments contribute.
 *
 * ROUND-TRIP NOTE (VERIFIED, and pinned by a test): js-yaml is not the problem
 * here. On the default schema `dump` EMITS a `__proto__` key and `load` reads
 * it back as an ORDINARY own property without touching `Object.prototype`, so
 * the document round-trips faithfully in both directions. The damage was
 * entirely on this side of the serialiser — see {@link UNSAFE_MAPPING_KEYS} —
 * and it is fixed there: the key is refused, so a rendered overlay never
 * contains one to begin with.
 *
 * @param fragments - Structured overlay fragments
 * @returns The `global.otelCollector.customConfig` document
 * @throws Error when the fragments conflict or use an object-model member as a
 *   mapping key (see {@link mergeCollectorConfig})
 */
export function renderCollectorConfig(fragments: readonly CollectorConfigFragment[]): string {
  return yaml.dump(mergeCollectorConfig(fragments), {
    flowLevel: RECEIVER_LIST_FLOW_LEVEL,
    // Never fold a long value onto a second line: the supervisor reads this
    // file as plain YAML, and a wrapped scalar is needless churn in the
    // rendered ConfigMap.
    lineWidth: -1,
    // Fragments are plain data built here; anchors/aliases would only appear
    // if a caller shared a sub-object between fragments, and an alias in a
    // config the supervisor merges is a surprise nobody wants.
    noRefs: true,
  });
}
