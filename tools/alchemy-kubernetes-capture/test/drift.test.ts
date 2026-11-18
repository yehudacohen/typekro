// Regenerates from Alchemy and fails if the checked-in output differs.
import '../src/offline-guard-install.ts';
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateControlPlane } from '../src/generate.ts';

const generated = (name: string) =>
  readFileSync(join(import.meta.dir, '..', 'generated', name), 'utf8');

describe('drift', () => {
  it('the checked-in composition and capture record match a fresh capture', async () => {
    const fresh = await generateControlPlane();
    expect(fresh.typescript).toBe(generated('rivet-control-plane.ts'));
    expect(fresh.json).toBe(generated('rivet-control-plane.capture.json'));
  });
});
