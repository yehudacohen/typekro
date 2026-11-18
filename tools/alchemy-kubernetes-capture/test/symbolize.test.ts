// Sentinel and differential rewriting against real Alchemy code: Alchemy's own control-plane
// layer for strings and numbers, and a Kubernetes.Manifest program for booleans and numbers,
// since the control plane takes no boolean props.
import '../src/offline-guard-install.ts';
import { describe, expect, it } from 'bun:test';
import * as Kubernetes from '@alchemy.run/kubernetes';
import * as Effect from 'effect/Effect';
import {
  captureConnection,
  captureProgram,
  captureStatefulSetControlPlane,
} from '../src/capture.ts';
import { CONTROL_PLANE_PARAMS, captureControlPlaneValues } from '../src/generate.ts';
import { type Param, symbolize } from '../src/symbolize.ts';

function at(value: unknown, path: readonly (string | number)[]): unknown {
  return path.reduce<unknown>(
    (node, part) => (node as Record<string | number, unknown>)[part],
    value
  );
}

describe('control-plane layer', () => {
  it('binds string props as templates and reports the number prop that branches', async () => {
    const { value, findings } = await symbolize(CONTROL_PLANE_PARAMS, captureControlPlaneValues);
    const engines = (
      value as { manifests: Array<{ logicalId: string; manifest: unknown }> }
    ).manifests.find((item) => item.logicalId === 'RivetEngines')?.manifest;
    expect(at(engines, ['metadata', 'name'])).toEqual({ $param: 'name' });
    expect(at(engines, ['spec', 'serviceName'])).toEqual({
      $template: [{ $param: 'name' }, '-peers'],
    });
    expect(at(engines, ['spec', 'template', 'spec', 'containers', 0, 'image'])).toEqual({
      $param: 'image',
    });
    // `instances` stays the literal 1: a second engine requires objectStorage, so Alchemy dies.
    expect(at(engines, ['spec', 'replicas'])).toBe(1);
    expect(findings).toEqual([
      {
        kind: 'capture-failed',
        param: 'instances',
        detail:
          'RivetKubernetes.StatefulSetControlPlane("Rivet") runs 2 engines, which share actor data through objectStorage.',
      },
    ]);
  });

  it('reports an optional prop, present or absent, as a branch', async () => {
    const params: Param[] = [
      { name: 'withStorageClass', kind: 'boolean', base: false, alternate: true },
    ];
    const { findings } = await symbolize(params, (values) =>
      captureStatefulSetControlPlane({
        name: 'engine',
        expose: { type: 'ClusterIP', endpoint: 'ep' },
        ...(values.withStorageClass === true ? { storageClassName: 'fast' } : {}),
      })
    );
    expect(findings).toContainEqual(
      expect.objectContaining({ kind: 'branch', param: 'withStorageClass' })
    );
  });
});

/** A program with one Manifest whose fields use a boolean and a number in the common ways. */
function probe(values: Readonly<Record<string, unknown>>) {
  const flag = values.flag as boolean;
  const port = values.port as number;
  return captureProgram(
    Effect.gen(function* () {
      yield* Kubernetes.Manifest('Probe', {
        cluster: captureConnection,
        manifest: {
          apiVersion: 'v1',
          kind: 'Pod',
          metadata: { name: 'probe' },
          spec: {
            automountServiceAccountToken: flag,
            hostNetwork: false,
            containers: [
              {
                name: 'probe',
                image: 'busybox',
                ports: [{ containerPort: port }],
                args: [`--enabled=${flag}`, `--listen=:${port}`],
                env: [
                  { name: 'FLAG', value: String(flag) },
                  { name: 'PORT', value: String(port) },
                  { name: 'DOUBLE', value: String(port * 2) },
                  { name: 'CLAMPED', value: String(Math.max(port, 1)) },
                ],
                ...(flag ? { stdin: true } : {}),
              },
            ],
          },
        },
      });
    })
  ).then((capture) => capture.manifests[0]?.manifest);
}

describe('numbers and booleans', () => {
  const params: Param[] = [
    { name: 'flag', kind: 'boolean', base: true, alternate: false },
    { name: 'port', kind: 'number', base: 8080, alternate: 8081, third: 0 },
  ];

  it('binds whole values and their string forms', async () => {
    const { value } = await symbolize(params, probe);
    const container = ['spec', 'containers', 0];
    expect(at(value, ['spec', 'automountServiceAccountToken'])).toEqual({ $param: 'flag' });
    expect(at(value, [...container, 'ports', 0, 'containerPort'])).toEqual({ $param: 'port' });
    expect(at(value, [...container, 'env', 0, 'value'])).toEqual({ $string: 'flag' });
    expect(at(value, [...container, 'env', 1, 'value'])).toEqual({ $string: 'port' });
    // A constant equal to the alternate is left alone: only leaves that move are bound.
    expect(at(value, ['spec', 'hostNetwork'])).toBe(false);
  });

  it('breaks on embedded values, arithmetic and boolean-selected structure', async () => {
    const { findings } = await symbolize(params, probe);
    const summary = findings.map(
      (finding) => `${finding.kind}:${finding.param}:${'path' in finding ? finding.path : ''}`
    );
    expect(summary).toContain('derived:flag:$.spec.containers[0].args[0]');
    expect(summary).toContain('derived:port:$.spec.containers[0].args[1]');
    expect(summary).toContain('derived:port:$.spec.containers[0].env[2].value');
    expect(summary).toContain('branch:flag:$.spec.containers[0].stdin');
  });

  it('a third probe stops a near-identity function from being bound as the prop', async () => {
    // Math.max(port, 1) equals port at 8080 and 8081 but not at 0, so it is reported as derived.
    const { value, findings } = await symbolize(params, probe);
    expect(at(value, ['spec', 'containers', 0, 'env', 3, 'value'])).toBe('8080');
    expect(findings).toContainEqual(
      expect.objectContaining({
        kind: 'derived',
        param: 'port',
        path: '$.spec.containers[0].env[3].value',
      })
    );
  });

  it('without the third probe, two points bind the near-identity function', async () => {
    const twoPoint: Param[] = [
      { name: 'flag', kind: 'boolean', base: true, alternate: false },
      { name: 'port', kind: 'number', base: 8080, alternate: 8081 },
    ];
    const { value } = await symbolize(twoPoint, probe);
    expect(at(value, ['spec', 'containers', 0, 'env', 3, 'value'])).toEqual({ $string: 'port' });
  });
});
