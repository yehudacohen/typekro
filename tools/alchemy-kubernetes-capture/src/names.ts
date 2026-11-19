// Kubernetes names the generated composition builds from spec fields, checked when it is
// generated. Each spec field that reaches a name gets a pattern and a maximum length; the emitter
// puts both on the RGD's instance schema, so the API server refuses a bad value in KRO mode and
// TypeKro's spec validation refuses it in direct mode. This module checks that every name the
// fields can produce is then valid for its kind: it renders each name with the longest value each
// field admits, starting and ending with a digit where the field allows one.
import type { GraphResource } from './lower.ts';
import type { ParamRef, Template } from './symbolize.ts';

/** RFC 1123 label: what most Kubernetes names, and namespaces, must be. */
export const DNS1123_LABEL = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;
/** RFC 1035 label: a Service name, which also becomes a DNS name, so it starts with a letter. */
export const DNS1035_LABEL = /^[a-z](?:[-a-z0-9]*[a-z0-9])?$/;
const DNS1123_SUBDOMAIN = /^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/;
const LABEL_VALUE = /^(?:[A-Za-z0-9](?:[-A-Za-z0-9_.]*[A-Za-z0-9])?)?$/;

/** The constraint on a spec field that is interpolated into Kubernetes names. */
export interface NameParam {
  readonly pattern: RegExp;
  readonly maxLength: number;
}

interface NameRule {
  readonly what: string;
  readonly pattern: RegExp;
  readonly maxLength: number;
}

/** `metadata.name` by kind. An object of any other kind fails the check. */
const NAME_RULES: Readonly<Record<string, NameRule>> = {
  Service: { what: 'a Service name (RFC 1035 label)', pattern: DNS1035_LABEL, maxLength: 63 },
  // Pods are `<name>-<ordinal>`, and the controller-revision-hash label is `<name>-<10 chars>`.
  StatefulSet: { what: 'a StatefulSet name', pattern: DNS1123_LABEL, maxLength: 52 },
  // The Job controller copies the name into each pod's `job-name` label.
  Job: { what: 'a Job name', pattern: DNS1123_LABEL, maxLength: 63 },
  Secret: { what: 'a Secret name', pattern: DNS1123_SUBDOMAIN, maxLength: 253 },
};

const NAMESPACE_RULE: NameRule = {
  what: 'a namespace (RFC 1123 label)',
  pattern: DNS1123_LABEL,
  maxLength: 63,
};
const LABEL_VALUE_RULE: NameRule = { what: 'a label value', pattern: LABEL_VALUE, maxLength: 63 };

export class NameError extends Error {
  constructor(problems: readonly string[]) {
    super(`Generated Kubernetes names can be invalid:\n- ${problems.join('\n- ')}`);
    this.name = 'NameError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The longest value `param` admits, starting and ending with a digit where its pattern allows,
 * since a digit is what a name's first character most often can't be.
 */
export function longestValue(param: NameParam): string {
  const { maxLength, pattern } = param;
  for (const [first, last] of [
    ['0', '0'],
    ['a', '0'],
    ['a', 'a'],
  ] as const) {
    const candidate =
      maxLength === 1 ? first : `${first}${'a'.repeat(Math.max(0, maxLength - 2))}${last}`;
    if (pattern.test(candidate)) return candidate;
  }
  throw new Error(`No value of length ${maxLength} matches ${pattern}.`);
}

type Rendered = { readonly text: string } | { readonly problem: string };

/** A name rendered with the longest value of each field it interpolates. */
function render(value: unknown, params: Readonly<Record<string, NameParam>>): Rendered {
  const parts: readonly unknown[] =
    isRecord(value) && Array.isArray(value.$template)
      ? (value as unknown as Template).$template
      : [value];
  let text = '';
  for (const part of parts) {
    if (typeof part === 'string') {
      text += part;
    } else if (isRecord(part) && typeof part.$param === 'string') {
      const name = (part as unknown as ParamRef).$param;
      const param = params[name];
      if (param === undefined) {
        return { problem: `interpolates spec field ${name}, which has no name constraint` };
      }
      text += longestValue(param);
    } else {
      return { problem: `is not a string or a template over spec fields: ${JSON.stringify(part)}` };
    }
  }
  return { text };
}

function checkName(
  where: string,
  value: unknown,
  rule: NameRule,
  params: Readonly<Record<string, NameParam>>,
  problems: string[]
): void {
  const rendered = render(value, params);
  if ('problem' in rendered) {
    problems.push(`${where} ${rendered.problem}`);
    return;
  }
  if (rendered.text.length > rule.maxLength) {
    problems.push(
      `${where} can be ${rendered.text.length} characters, over the ${rule.maxLength} allowed for ${rule.what}`
    );
  }
  if (!rule.pattern.test(rendered.text)) {
    problems.push(`${where} can be ${JSON.stringify(rendered.text)}, which is not ${rule.what}`);
  }
}

/** Every label value under any `labels` or `matchLabels` map in `value`. */
function labelValues(value: unknown, path: string, found: [string, unknown][]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => labelValues(item, `${path}[${index}]`, found));
    return;
  }
  if (!isRecord(value) || '$template' in value || '$param' in value) return;
  for (const [key, child] of Object.entries(value)) {
    if ((key === 'labels' || key === 'matchLabels') && isRecord(child)) {
      for (const [label, labelValue] of Object.entries(child)) {
        found.push([`${path}.${key}[${label}]`, labelValue]);
      }
    } else {
      labelValues(child, `${path}.${key}`, found);
    }
  }
}

/**
 * Throws a {@link NameError} listing every name, namespace or label value of `resources` that a
 * value admitted by `params` could make invalid or too long for its kind.
 */
export function checkGeneratedNames(
  resources: readonly GraphResource[],
  params: Readonly<Record<string, NameParam>>
): void {
  const problems: string[] = [];
  for (const resource of resources) {
    const object = resource.object as Record<string, unknown>;
    const metadata = isRecord(object.metadata) ? object.metadata : {};
    const kind = String(object.kind);
    const rule = NAME_RULES[kind];
    if (rule === undefined) {
      problems.push(`${resource.id} is a ${kind}, which has no name rule`);
    } else {
      checkName(`${resource.id} metadata.name`, metadata.name, rule, params, problems);
    }
    if (metadata.namespace !== undefined) {
      checkName(
        `${resource.id} metadata.namespace`,
        metadata.namespace,
        NAMESPACE_RULE,
        params,
        problems
      );
    }
    const labels: [string, unknown][] = [];
    labelValues(object, resource.id, labels);
    for (const [where, value] of labels) {
      checkName(where, value, LABEL_VALUE_RULE, params, problems);
    }
  }
  if (problems.length > 0) throw new NameError(problems);
}
