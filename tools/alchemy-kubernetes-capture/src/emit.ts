// Emits a lowered composition as TypeScript that uses only TypeKro's public API. The output
// imports no Alchemy code and is deterministic, so a regeneration can be compared byte for byte.
import type { GeneratedComposition, GraphResource, SpecField } from './lower.ts';

export class EmitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmitError';
  }
}

const INDENT = '  ';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function quote(text: string): string {
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
}

function key(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : quote(name);
}

/** How a `$param` leaf is spelled in the emitted code. */
type ParamSpelling = (name: string) => string;

function literalPart(text: string): string {
  if (text.includes('%s') || text.includes('${')) {
    throw new EmitError(
      `A literal template part contains a reserved sequence: ${JSON.stringify(text)}`
    );
  }
  return text;
}

function expression(value: unknown, param: ParamSpelling, depth: number): string {
  if (isRecord(value) && typeof value.$param === 'string') return param(value.$param);
  if (isRecord(value) && typeof value.$string === 'string') {
    return `Cel.expr<string>('string(', ${param(value.$string)}, ')')`;
  }
  if (isRecord(value) && Array.isArray(value.$template)) {
    const parts = value.$template as ReadonlyArray<string | { $param: string }>;
    const format = parts
      .map((part) => (typeof part === 'string' ? literalPart(part) : '%s'))
      .join('');
    const refs = parts
      .filter((part): part is { $param: string } => typeof part !== 'string')
      .map((part) => param(part.$param));
    return `Cel.template(${quote(format)}, ${refs.join(', ')})`;
  }
  if (typeof value === 'string') return quote(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  const pad = INDENT.repeat(depth + 1);
  const close = INDENT.repeat(depth);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[\n${value.map((item) => `${pad}${expression(item, param, depth + 1)},`).join('\n')}\n${close}]`;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return '{}';
    return `{\n${entries.map(([name, item]) => `${pad}${key(name)}: ${expression(item, param, depth + 1)},`).join('\n')}\n${close}}`;
  }
  throw new EmitError(`Cannot emit a value of type ${typeof value}.`);
}

/** A field's ArkType: its kind, or for a field that reaches Kubernetes names, its constraint. */
function fieldType(field: SpecField): string {
  if (field.pattern === undefined && field.maxLength === undefined) return quote(field.kind);
  if (field.kind !== 'string' || field.pattern === undefined || field.maxLength === undefined) {
    throw new EmitError(`Spec field ${field.name} has an incomplete name constraint.`);
  }
  if (field.pattern.includes('/')) {
    throw new EmitError(`Spec field ${field.name} has a pattern with a slash: ${field.pattern}`);
  }
  return `type(/${field.pattern}/).and(${quote(`string <= ${field.maxLength}`)})`;
}

function arktype(fields: readonly SpecField[]): string {
  return `type({ ${fields.map((field) => `${key(field.name)}: ${fieldType(field)}`).join(', ')} })`;
}

const READINESS: Readonly<Record<string, (id: string) => string>> = {
  'statefulset-replicas': () =>
    '(self: { status: { readyReplicas: number }; spec: { replicas: number } }) =>\n' +
    '        self.status.readyReplicas === self.spec.replicas',
  // `has()` keeps the expression defined before the Job controller writes `status.succeeded`.
  'job-succeeded': (id) =>
    `Cel.expr<boolean>('has(${id}.status.succeeded) && ${id}.status.succeeded > 0')`,
};

/** TypeKro's typed factory for each captured kind. An unknown kind fails closed. */
const FACTORIES: Readonly<Record<string, string>> = {
  Job: 'job',
  Secret: 'secret',
  Service: 'service',
  StatefulSet: 'statefulSet',
};

function factoryFor(object: Record<string, unknown>): string {
  const factory = FACTORIES[String(object.kind)];
  if (factory === undefined)
    throw new EmitError(`No TypeKro factory is mapped for kind ${String(object.kind)}.`);
  return factory;
}

function resourceStatement(resource: GraphResource): string {
  const object = resource.object as Record<string, unknown>;
  const factory = factoryFor(object);
  const body = expression({ id: resource.id, ...object }, (name) => `schema.spec.${name}`, 2);
  const readiness =
    resource.readiness === undefined
      ? ''
      : `.withReadyWhen(\n      ${READINESS[resource.readiness]?.(resource.id)}\n    )`;
  return `    // From ${resource.origin}.\n    const ${resource.id} = ${factory}(${body})${readiness};`;
}

function header(generated: GeneratedComposition): string {
  const packages = Object.entries(generated.source.packages)
    .map(([name, version]) => `//   ${name}@${version}`)
    .join('\n');
  return [
    '// GENERATED by tools/alchemy-kubernetes-capture. Do not edit; run `bun run generate` there.',
    `// Source: Alchemy's ${generated.source.layer}, captured from`,
    packages,
    `// Variant: ${generated.source.variant}.`,
    '// This file imports no Alchemy code. Lowerings are listed in rivet-control-plane.capture.json.',
  ].join('\n');
}

/** Emit the RGD composition and the out-of-graph token composition as one TypeScript module. */
export function emitControlPlane(generated: GeneratedComposition, typekroImport: string): string {
  const { graph, outsideGraph } = generated;
  const resources = graph.resources.map(resourceStatement).join('\n');
  const dependsOn = graph.resources
    .flatMap((resource) =>
      resource.dependsOn.map((dependency) => `    ${resource.id}.dependsOn(${dependency});`)
    )
    .join('\n');
  const returned = graph.resources.map((resource) => resource.id).join(', ');
  const factories = [...graph.resources, ...outsideGraph.resources].map((resource) =>
    factoryFor(resource.object as Record<string, unknown>)
  );
  const imports = ['Cel', ...new Set(factories), 'toResourceGraph']
    .sort((left, right) => left.localeCompare(right))
    .join(', ');

  // A KRO status leaf must project from a resource: the endpoint's name and namespace are the API
  // Service's own metadata, which equal the spec values they were captured from.
  const statusParam: ParamSpelling = (name) => {
    if (name === 'name') return 'resources.api.metadata.name';
    if (name === 'namespace') return 'resources.api.metadata.namespace';
    throw new EmitError(`Status cannot project spec field ${name} from a resource.`);
  };
  const nodeEndpoint = expression(graph.status.nodeEndpoint, statusParam, 2);

  const secret = outsideGraph.resources[0];
  if (secret === undefined) throw new EmitError('The out-of-graph composition has no resource.');
  const secretBody = expression(
    { id: secret.id, ...(secret.object as Record<string, unknown>) },
    (name) => `schema.spec.${name}`,
    2
  );

  return `${header(generated)}
import { type } from 'arktype';
import { ${imports} } from ${quote(typekroImport)};

export const RivetControlPlaneSpec = ${arktype(graph.spec)};
export const RivetControlPlaneStatus = type({ ready: 'boolean', nodeEndpoint: 'string' });

/** The Rivet engine as one kro ResourceGraphDefinition. The admin-token Secret must exist first. */
export const rivetControlPlane = toResourceGraph(
  {
    name: ${quote(graph.name)},
    apiVersion: ${quote(graph.apiVersion)},
    kind: ${quote(graph.kind)},
    spec: RivetControlPlaneSpec,
    status: RivetControlPlaneStatus,
  },
  (schema) => {
${resources}
${dependsOn}
    return { ${returned} };
  },
  (_schema, resources) => ({
    ready: Cel.expr<boolean>(
      resources.engines.status.readyReplicas,
      ' == ',
      resources.engines.spec.replicas,
      ' && has(pool.status.succeeded) && ',
      resources.pool.status.succeeded,
      ' > 0'
    ),
    nodeEndpoint: ${nodeEndpoint},
  })
);

export const RivetControlPlaneAdminTokenSpec = ${arktype(outsideGraph.spec)};
export const RivetControlPlaneAdminTokenStatus = type({ secretName: 'string' });

/**
 * The admin-token Secret, deployed in direct mode outside the RGD. Its \`token\` comes from the
 * deployer's secret generator, never from a KRO custom resource.
 */
export const rivetControlPlaneAdminToken = toResourceGraph(
  {
    name: ${quote(outsideGraph.name)},
    apiVersion: ${quote(outsideGraph.apiVersion)},
    kind: ${quote(outsideGraph.kind)},
    spec: RivetControlPlaneAdminTokenSpec,
    status: RivetControlPlaneAdminTokenStatus,
  },
  (schema) => {
    // From ${secret.origin}.
    const ${secret.id} = ${factoryFor(secret.object as Record<string, unknown>)}(${secretBody});
    return { ${secret.id} };
  },
  (_schema, resources) => ({ secretName: resources.${secret.id}.metadata.name })
);
`;
}
