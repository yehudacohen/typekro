import { spawnSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const workspace = resolve(import.meta.dirname, '..');
const temporaryRoot = mkdtempSync(join(tmpdir(), 'typekro-packed-imports-'));
const budgets = JSON.parse(
  readFileSync(join(workspace, 'scripts', 'packed-artifact-budgets.json'), 'utf8')
);

function run(command, args, options = {}) {
  const startedAt = performance.now();
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? workspace,
    encoding: 'utf8',
    env: process.env,
  });
  const durationMilliseconds = performance.now() - startedAt;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status}).\n${result.stdout}${result.stderr}`
    );
  }
  return { ...result, durationMilliseconds };
}

function packageMetrics(root) {
  const metrics = { unpackedBytes: 0, declarationBytes: 0, fileCount: 0 };
  const visit = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const entryPath = join(path, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const size = lstatSync(entryPath).size;
      metrics.unpackedBytes += size;
      metrics.fileCount += 1;
      if (entry.name.endsWith('.d.ts')) metrics.declarationBytes += size;
    }
  };
  visit(root);
  return metrics;
}

function packageSpecifier(exportName) {
  return exportName === '.' ? 'typekro' : `typekro/${exportName.slice(2)}`;
}

function assertBudget(name, actual, maximum, failures) {
  if (!Number.isFinite(maximum) || maximum <= 0) {
    failures.push(`${name} has an invalid configured budget: ${maximum}`);
  } else if (actual > maximum) {
    failures.push(`${name} is ${actual}, exceeding its budget of ${maximum}`);
  }
}

try {
  run('bun', ['run', 'build:lib']);
  run('bun', ['pm', 'pack', '--destination', temporaryRoot, '--ignore-scripts', '--quiet']);
  const tarballName = readdirSync(temporaryRoot).find((entry) => entry.endsWith('.tgz'));
  if (!tarballName) throw new Error('bun pm pack did not produce a tarball.');

  const tarballPath = join(temporaryRoot, tarballName);
  const packageRoot = join(temporaryRoot, 'package');
  const consumerRoot = join(temporaryRoot, 'consumer');
  mkdirSync(packageRoot, { recursive: true });
  mkdirSync(join(consumerRoot, 'node_modules'), { recursive: true });
  run('tar', ['-xzf', tarballPath, '-C', packageRoot, '--strip-components=1']);

  const packedPackageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  const exportEntries = Object.entries(packedPackageJson.exports ?? {}).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  if (exportEntries.length === 0) throw new Error('Packed package contains no exports.');

  const missingExportArtifacts = [];
  for (const [exportName, targets] of exportEntries) {
    for (const field of ['import', 'types']) {
      const target = targets?.[field];
      if (typeof target !== 'string') {
        missingExportArtifacts.push(`${exportName} has no ${field} target`);
        continue;
      }
      try {
        lstatSync(join(packageRoot, target));
      } catch {
        missingExportArtifacts.push(`${exportName} ${field} target is missing: ${target}`);
      }
    }
  }
  if (missingExportArtifacts.length > 0) {
    throw new Error(`Packed export validation failed:\n- ${missingExportArtifacts.join('\n- ')}`);
  }

  const artifactMetrics = {
    tarballBytes: lstatSync(tarballPath).size,
    ...packageMetrics(packageRoot),
  };

  symlinkSync(join(workspace, 'node_modules'), join(packageRoot, 'node_modules'), 'dir');
  symlinkSync(packageRoot, join(consumerRoot, 'node_modules', 'typekro'), 'dir');

  const importProgram = exportEntries
    .map(([exportName]) => `await import(${JSON.stringify(packageSpecifier(exportName))})`)
    .join(';');
  const coldImportMilliseconds = {};
  for (const [runtimeName, label, runtime, args] of [
    [
      'node',
      `node-${process.versions.node}`,
      process.execPath,
      ['--trace-deprecation', '--input-type=module', '-e', importProgram],
    ],
    ['bun', 'bun', 'bun', ['-e', importProgram]],
  ]) {
    const result = run(runtime, args, { cwd: consumerRoot });
    if (result.stdout !== '' || result.stderr !== '') {
      throw new Error(
        `${label} packed imports emitted output.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
      );
    }
    coldImportMilliseconds[runtimeName] = Math.ceil(result.durationMilliseconds);
  }

  const failures = [];
  assertBudget('tarballBytes', artifactMetrics.tarballBytes, budgets.maxTarballBytes, failures);
  assertBudget('unpackedBytes', artifactMetrics.unpackedBytes, budgets.maxUnpackedBytes, failures);
  assertBudget(
    'declarationBytes',
    artifactMetrics.declarationBytes,
    budgets.maxDeclarationBytes,
    failures
  );
  assertBudget('fileCount', artifactMetrics.fileCount, budgets.maxFileCount, failures);
  assertBudget(
    'node cold import milliseconds',
    coldImportMilliseconds.node,
    budgets.maxColdImportMilliseconds?.node,
    failures
  );
  assertBudget(
    'bun cold import milliseconds',
    coldImportMilliseconds.bun,
    budgets.maxColdImportMilliseconds?.bun,
    failures
  );

  const evidence = {
    schemaVersion: 1,
    exportCount: exportEntries.length,
    ...artifactMetrics,
    coldImportMilliseconds,
    budgets,
  };
  if (failures.length > 0) {
    throw new Error(
      `Packed artifact budgets failed:\n- ${failures.join('\n- ')}\nEvidence: ${JSON.stringify(evidence)}`
    );
  }

  console.log(`Packed artifact evidence: ${JSON.stringify(evidence)}`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
