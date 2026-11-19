// Every Kubernetes name the generated composition builds from its spec must be valid for its kind
// at the longest value each spec field admits. Runs on the checked-in capture record; no Alchemy.
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GeneratedComposition, GraphResource } from '../src/lower.ts';
import { NAME_PARAMS } from '../src/lower.ts';
import {
  checkGeneratedNames,
  DNS1123_LABEL,
  longestValue,
  NameError,
  type NameParam,
} from '../src/names.ts';

const record = JSON.parse(
  readFileSync(join(import.meta.dir, '..', 'generated', 'rivet-control-plane.capture.json'), 'utf8')
) as GeneratedComposition;
const resources: GraphResource[] = [...record.graph.resources, ...record.outsideGraph.resources];

function refusal(params: Readonly<Record<string, NameParam>>, items = resources): string {
  try {
    checkGeneratedNames(items, params);
  } catch (error) {
    expect(error).toBeInstanceOf(NameError);
    return (error as Error).message;
  }
  throw new Error('expected the names to be refused');
}

describe('generated Kubernetes names', () => {
  it('fit every kind at the longest admitted values', () => {
    expect(() => checkGeneratedNames(resources, NAME_PARAMS)).not.toThrow();
  });

  it('put the pattern and length of each name field on both spec schemas', () => {
    for (const fields of [record.graph.spec, record.outsideGraph.spec]) {
      const name = fields.find((field) => field.name === 'name');
      expect(name).toMatchObject({ pattern: '^[a-z](?:[-a-z0-9]*[a-z0-9])?$', maxLength: 32 });
    }
    const pool = record.graph.spec.find((field) => field.name === 'pool');
    expect(pool).toMatchObject({ pattern: DNS1123_LABEL.source, maxLength: 16 });
  });

  it('leave the pool Job name exactly at the 63-character limit', () => {
    const job = resources.find((resource) => resource.id === 'pool');
    const name = (job?.object as { metadata: { name: { $template: unknown[] } } }).metadata.name;
    const longest = name.$template
      .map((part) =>
        typeof part === 'string'
          ? part
          : longestValue(NAME_PARAMS[(part as { $param: string }).$param] as NameParam)
      )
      .join('');
    expect(longest).toHaveLength(63);
  });

  it('refuse a name length that would push the pool Job name over 63 characters', () => {
    const message = refusal({
      ...NAME_PARAMS,
      name: { ...NAME_PARAMS.name, maxLength: 33 } as NameParam,
    });
    expect(message).toContain(
      'pool metadata.name can be 64 characters, over the 63 allowed for a Job name'
    );
  });

  it('refuse a StatefulSet name past 52 characters', () => {
    const message = refusal({
      ...NAME_PARAMS,
      name: { ...NAME_PARAMS.name, maxLength: 53 } as NameParam,
    });
    expect(message).toContain(
      'engines metadata.name can be 53 characters, over the 52 allowed for a StatefulSet name'
    );
  });

  it('refuse a Service name that could start with a digit', () => {
    const message = refusal({ ...NAME_PARAMS, name: { pattern: DNS1123_LABEL, maxLength: 32 } });
    expect(message).toContain('api metadata.name can be "0');
    expect(message).toContain('which is not a Service name (RFC 1035 label)');
  });

  it('refuse a field in a name that has no name constraint', () => {
    const { pool: _pool, ...withoutPool } = NAME_PARAMS;
    expect(refusal(withoutPool)).toContain(
      'pool metadata.name interpolates spec field pool, which has no name constraint'
    );
  });

  it('refuse a literal that no Kubernetes name may hold', () => {
    const service = resources.find((resource) => resource.id === 'peers') as GraphResource;
    const object = service.object as { metadata: Record<string, unknown> };
    const renamed: GraphResource = {
      ...service,
      object: {
        ...object,
        metadata: { ...object.metadata, name: { $template: [{ $param: 'name' }, '_Peers'] } },
      },
    };
    expect(refusal(NAME_PARAMS, [renamed])).toContain('which is not a Service name');
  });
});
