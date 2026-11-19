// Runs the pool Job's shell script with stub `curl` and `sleep`, to check the bounded retry.
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Container {
  command: string[];
}

function poolScript(): string {
  const record = JSON.parse(
    readFileSync(
      join(import.meta.dir, '..', 'generated', 'rivet-control-plane.capture.json'),
      'utf8'
    )
  ) as {
    graph: {
      resources: Array<{
        id: string;
        object: { spec: { template: { spec: { containers: Container[] } } } };
      }>;
    };
  };
  const pool = record.graph.resources.find((resource) => resource.id === 'pool');
  const script = pool?.object.spec.template.spec.containers[0]?.command[2];
  if (script === undefined) throw new Error('No pool Job script in the capture record.');
  return script;
}

/** Run the script with a curl that fails `failures` times, then succeeds. */
function run(failures: number) {
  const bin = mkdtempSync(join(tmpdir(), 'tkcapture-pool-'));
  try {
    const counter = join(bin, 'count');
    writeFileSync(counter, '0');
    writeFileSync(
      join(bin, 'curl'),
      `#!/bin/sh\nn=$(cat "${counter}"); n=$((n + 1)); echo "$n" > "${counter}"\n[ "$n" -gt ${failures} ]\n`
    );
    writeFileSync(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, 'curl'), 0o755);
    chmodSync(join(bin, 'sleep'), 0o755);
    const result = spawnSync('/bin/sh', ['-c', poolScript()], {
      encoding: 'utf8',
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        RIVET_ENDPOINT: 'http://engine',
        RIVET_POOL: 'default',
        RIVET_TOKEN: 'x',
      },
    });
    return {
      status: result.status,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
      calls: Number(readFileSync(counter, 'utf8')),
    };
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
}

describe('pool Job script', () => {
  it('retries until the PUT succeeds', () => {
    expect(run(2)).toEqual({
      status: 0,
      stdout: 'rivet pool default configured after 3 tries',
      stderr: '',
      calls: 3,
    });
  });

  it('fails cleanly with a message after 30 tries', () => {
    expect(run(1000)).toEqual({
      status: 1,
      stdout: '',
      stderr: 'rivet pool default was not configured after 30 tries',
      calls: 30,
    });
  });
});
