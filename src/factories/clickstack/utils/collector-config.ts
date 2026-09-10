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
 * ({@link CLICKSTACK_INGEST_PIPELINES}) and the persistent queue's own wiring.
 * Both open a top-level `service:` key, so the concatenated document declared
 * `service` twice and the supervisor rejected the WHOLE FILE on every poll:
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (isPlainObject(value)) {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) copy[key] = cloneValue(item);
    return copy;
  }
  return value;
}

/** Order-preserving union — the merge policy for every sequence in the overlay. */
function unionSequences(left: readonly unknown[], right: readonly unknown[]): unknown[] {
  const merged: unknown[] = [];
  const seen = new Set<string>();
  for (const item of [...left, ...right]) {
    const key = JSON.stringify(item ?? null);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(cloneValue(item));
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
 * @param fragments - Structured overlay fragments, in precedence-free order
 * @returns One merged configuration object
 * @throws Error when two fragments set the same path to incompatible values
 */
export function mergeCollectorConfig(
  fragments: readonly CollectorConfigFragment[]
): CollectorConfigFragment {
  const merged: CollectorConfigFragment = {};
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
  for (const [key, incoming] of Object.entries(source)) {
    const here = [...path, key];
    if (!(key in target)) {
      // COPY, never adopt: `incoming` belongs to a fragment the caller may
      // reuse — see {@link cloneValue}.
      target[key] = cloneValue(incoming);
      continue;
    }
    const existing = target[key];
    if (isPlainObject(existing) && isPlainObject(incoming)) {
      mergeInto(existing, incoming, here);
      continue;
    }
    if (Array.isArray(existing) && Array.isArray(incoming)) {
      target[key] = unionSequences(existing, incoming);
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
 * @param fragments - Structured overlay fragments
 * @returns The `global.otelCollector.customConfig` document
 * @throws Error when the fragments conflict (see {@link mergeCollectorConfig})
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
