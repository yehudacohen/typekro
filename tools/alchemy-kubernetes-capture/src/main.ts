// `bun run generate`: writes the checked-in composition and its capture record.
import './offline-guard-install.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateControlPlane } from './generate.ts';
import { networkAttempts } from './offline-guard.ts';

const directory = join(import.meta.dir, '..', 'generated');
mkdirSync(directory, { recursive: true });
const generated = await generateControlPlane();
writeFileSync(join(directory, 'rivet-control-plane.capture.json'), generated.json);
writeFileSync(join(directory, 'rivet-control-plane.ts'), generated.typescript);
if (networkAttempts().length > 0) {
  console.error('The capture attempted network access:', networkAttempts());
  process.exit(1);
}
console.log(
  `Wrote ${generated.composition.graph.resources.length} RGD resources and ${generated.composition.findings.length} findings.`
);
process.exit(0);
