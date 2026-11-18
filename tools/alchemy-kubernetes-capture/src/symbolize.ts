// Recovers which captured values come from which layer props.
//
// Providers only ever see resolved values, so a capture is a tree of literals. The symbolizer runs
// the capture more than once and compares the results:
// - string props are given unique sentinel tokens, and every string leaf that contains a token
//   becomes a template;
// - number and boolean props are captured again with an alternate value, and every leaf that
//   changed from the base value to the alternate value is bound to the prop.
// Anything else that changes is reported, never guessed: a change of shape is a branch in the
// layer's code, and a changed leaf that is not exactly the prop's value is a derived value.

export type ParamKind = 'string' | 'number' | 'boolean';

export interface StringParam {
  readonly name: string;
  readonly kind: 'string';
  /** Unique token substituted for the prop. Must not occur anywhere else in the capture. */
  readonly sentinel: string;
  /** A second token, used to prove the prop does not change the capture's shape. */
  readonly alternate: string;
}

export interface ScalarParam<K extends 'number' | 'boolean', V> {
  readonly name: string;
  readonly kind: K;
  readonly base: V;
  readonly alternate: V;
  /**
   * A third probe for numbers, ideally an edge such as 0 or a negative. Two probes cannot tell
   * the prop from a function that agrees with it at both points (`Math.max(n, 1)`); a leaf is
   * bound only if it also follows the prop at this value. Booleans have no third value.
   */
  readonly third?: V;
}

export type Param = StringParam | ScalarParam<'number', number> | ScalarParam<'boolean', boolean>;

/** A symbolic leaf: the whole value is the prop. */
export interface ParamRef {
  readonly $param: string;
}

/** A symbolic leaf: the prop rendered as a string, e.g. `"false"` from a boolean. */
export interface ParamString {
  readonly $string: string;
}

/** A symbolic string assembled from literal parts and props. */
export interface Template {
  readonly $template: ReadonlyArray<string | ParamRef>;
}

export type Symbolic = unknown;

export type Finding =
  | {
      readonly kind: 'branch';
      readonly param: string;
      readonly path: string;
      readonly detail: string;
    }
  | {
      readonly kind: 'derived';
      readonly param: string;
      readonly path: string;
      readonly base: unknown;
      readonly alternate: unknown;
    }
  | { readonly kind: 'unused'; readonly param: string }
  | { readonly kind: 'capture-failed'; readonly param: string; readonly detail: string }
  | { readonly kind: 'sentinel-collision'; readonly param: string; readonly path: string };

export interface SymbolizeResult {
  readonly value: Symbolic;
  readonly findings: readonly Finding[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pathOf(parts: readonly (string | number)[]): string {
  return parts.length === 0
    ? '$'
    : `$${parts.map((part) => (typeof part === 'number' ? `[${part}]` : `.${part}`)).join('')}`;
}

/** Split a string into literal parts and references to every sentinel token it contains. */
function templateOf(text: string, params: readonly StringParam[]): string | Template {
  const parts: Array<string | ParamRef> = [];
  let rest = text;
  while (rest.length > 0) {
    let next: { index: number; param: StringParam } | undefined;
    for (const param of params) {
      const index = rest.indexOf(param.sentinel);
      if (index >= 0 && (next === undefined || index < next.index)) next = { index, param };
    }
    if (next === undefined) {
      parts.push(rest);
      break;
    }
    if (next.index > 0) parts.push(rest.slice(0, next.index));
    parts.push({ $param: next.param.name });
    rest = rest.slice(next.index + next.param.sentinel.length);
  }
  if (parts.length === 1 && typeof parts[0] === 'string') return parts[0];
  if (parts.length === 1 && typeof parts[0] !== 'string') return parts[0] as unknown as Template;
  return { $template: parts };
}

function substituteStrings(
  value: unknown,
  params: readonly StringParam[],
  used: Set<string>
): Symbolic {
  if (typeof value === 'string') {
    const symbolic = templateOf(value, params);
    for (const param of params) if (value.includes(param.sentinel)) used.add(param.name);
    return symbolic;
  }
  if (Array.isArray(value)) return value.map((item) => substituteStrings(item, params, used));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, substituteStrings(item, params, used)])
    );
  }
  return value;
}

interface Change {
  readonly path: readonly (string | number)[];
  readonly base: unknown;
  readonly alternate: unknown;
}

/** Leaf-by-leaf comparison; a difference in keys or array length is a shape change. */
function compare(
  base: unknown,
  alternate: unknown,
  path: (string | number)[],
  changes: Change[],
  shape: string[]
): void {
  if (Array.isArray(base) && Array.isArray(alternate)) {
    if (base.length !== alternate.length) {
      shape.push(`${pathOf(path)} has ${base.length} items, then ${alternate.length}`);
      return;
    }
    base.forEach((item, index) =>
      compare(item, alternate[index], [...path, index], changes, shape)
    );
    return;
  }
  if (isPlainObject(base) && isPlainObject(alternate)) {
    const keys = new Set([...Object.keys(base), ...Object.keys(alternate)]);
    for (const key of [...keys].sort()) {
      if (!(key in base) || !(key in alternate)) {
        shape.push(`${pathOf([...path, key])} is present in only one capture`);
        continue;
      }
      compare(base[key], alternate[key], [...path, key], changes, shape);
    }
    return;
  }
  if (
    Array.isArray(base) ||
    Array.isArray(alternate) ||
    isPlainObject(base) ||
    isPlainObject(alternate)
  ) {
    shape.push(`${pathOf(path)} changes type`);
    return;
  }
  if (!Object.is(base, alternate)) changes.push({ path, base, alternate });
}

function at(root: unknown, path: readonly (string | number)[]): unknown {
  return path.reduce<unknown>(
    (node, part) =>
      node !== null && typeof node === 'object'
        ? (node as Record<string | number, unknown>)[part]
        : undefined,
    root
  );
}

function setAt(root: unknown, path: readonly (string | number)[], value: unknown): unknown {
  if (path.length === 0) return value;
  const [head, ...tail] = path;
  if (Array.isArray(root)) {
    const copy = [...root];
    copy[head as number] = setAt(copy[head as number], tail, value);
    return copy;
  }
  const record = root as Record<string, unknown>;
  return { ...record, [head as string]: setAt(record[head as string], tail, value) };
}

/**
 * Symbolize a layer. `capture(values)` must run the real layer with the given prop values and
 * return its captured tree; it is called once for the base values and once per parameter.
 */
export async function symbolize(
  params: readonly Param[],
  capture: (values: Readonly<Record<string, unknown>>) => Promise<unknown>
): Promise<SymbolizeResult> {
  const findings: Finding[] = [];
  const baseValues: Record<string, unknown> = {};
  for (const param of params)
    baseValues[param.name] = param.kind === 'string' ? param.sentinel : param.base;
  const base = await capture(baseValues);

  const stringParams = params.filter((param): param is StringParam => param.kind === 'string');
  for (const param of stringParams) {
    const others = stringParams.filter((other) => other !== param);
    if (
      others.some(
        (other) =>
          other.sentinel.includes(param.sentinel) || param.sentinel.includes(other.sentinel)
      )
    ) {
      findings.push({
        kind: 'sentinel-collision',
        param: param.name,
        path: 'sentinel overlaps another sentinel',
      });
    }
  }

  let value: unknown = base;
  for (const param of params) {
    if (param.kind === 'string') continue;
    let alternate: unknown;
    try {
      alternate = await capture({ ...baseValues, [param.name]: param.alternate });
    } catch (error) {
      findings.push({
        kind: 'capture-failed',
        param: param.name,
        detail: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const changes: Change[] = [];
    const shape: string[] = [];
    compare(base, alternate, [], changes, shape);
    let third: unknown;
    if (param.third !== undefined) {
      try {
        third = await capture({ ...baseValues, [param.name]: param.third });
        compare(base, third, [], [], shape);
      } catch (error) {
        findings.push({
          kind: 'capture-failed',
          param: param.name,
          detail: `third probe ${String(param.third)}: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }
    }
    const followsThird = (path: readonly (string | number)[], render: (v: unknown) => unknown) =>
      param.third === undefined || Object.is(at(third, path), render(param.third));
    for (const detail of new Set(shape))
      findings.push({
        kind: 'branch',
        param: param.name,
        path: detail.split(' ')[0] ?? '$',
        detail,
      });
    if (changes.length === 0 && shape.length === 0)
      findings.push({ kind: 'unused', param: param.name });
    for (const change of changes) {
      if (
        Object.is(change.base, param.base) &&
        Object.is(change.alternate, param.alternate) &&
        followsThird(change.path, (v) => v)
      ) {
        value = setAt(value, change.path, { $param: param.name } satisfies ParamRef);
      } else if (
        change.base === String(param.base) &&
        change.alternate === String(param.alternate) &&
        followsThird(change.path, String)
      ) {
        value = setAt(value, change.path, { $string: param.name } satisfies ParamString);
      } else {
        findings.push({
          kind: 'derived',
          param: param.name,
          path: pathOf(change.path),
          base: change.base,
          alternate: change.alternate,
        });
      }
    }
  }

  for (const param of stringParams) {
    let alternate: unknown;
    try {
      alternate = await capture({ ...baseValues, [param.name]: param.alternate });
    } catch (error) {
      findings.push({
        kind: 'capture-failed',
        param: param.name,
        detail: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const changes: Change[] = [];
    const shape: string[] = [];
    compare(base, alternate, [], changes, shape);
    for (const detail of shape)
      findings.push({
        kind: 'branch',
        param: param.name,
        path: detail.split(' ')[0] ?? '$',
        detail,
      });
    for (const change of changes) {
      const expected =
        typeof change.base === 'string'
          ? change.base.split(param.sentinel).join(param.alternate)
          : undefined;
      if (expected !== change.alternate) {
        findings.push({
          kind: 'derived',
          param: param.name,
          path: pathOf(change.path),
          base: change.base,
          alternate: change.alternate,
        });
      }
    }
  }

  const used = new Set<string>();
  value = substituteStrings(value, stringParams, used);
  for (const param of stringParams)
    if (!used.has(param.name)) findings.push({ kind: 'unused', param: param.name });
  return { value, findings };
}
