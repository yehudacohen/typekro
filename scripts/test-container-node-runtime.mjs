import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildContainer } from '../dist/core/containers/index.js';

const directory = await mkdtemp(join(tmpdir(), 'typekro-node-container-'));
const originalPath = process.env.PATH ?? '';

try {
  const context = join(directory, 'context');
  await mkdir(context);
  await writeFile(join(context, 'Dockerfile'), 'FROM scratch\n');
  const docker = join(directory, 'docker');
  await writeFile(
    docker,
    '#!/usr/bin/env node\n'
      + 'const args = process.argv.slice(2);\n'
      + 'if (args[0] === "version") process.stdout.write("28.0.0\\n");\n'
  );
  await chmod(docker, 0o700);
  process.env.PATH = `${directory}:${originalPath}`;

  let cleaned = false;
  const result = await buildContainer({
    context,
    imageName: 'node-runtime-proof',
    tag: 'v1',
    registry: {
      type: 'custom',
      handler: {
        async resolveImageUri(imageName, tag) {
          return `node.test/${imageName}:${tag}`;
        },
        async prepare() {
          return {
            remote: false,
            async cleanup() {
              cleaned = true;
            },
          };
        },
      },
    },
  });
  if (result.imageUri !== 'node.test/node-runtime-proof:v1' || !cleaned) {
    throw new Error(`Unexpected Node container result: ${JSON.stringify(result)}`);
  }
  console.log(`Node container runtime passed on ${process.version}.`);
} finally {
  process.env.PATH = originalPath;
  await rm(directory, { recursive: true, force: true });
}
