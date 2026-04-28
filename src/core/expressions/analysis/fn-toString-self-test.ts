/**
 * fn.toString() Self-Test
 *
 * TypeKro relies on `fn.toString()` producing parseable JavaScript source code in
 * multiple critical code paths (status builder analysis, composition body analysis,
 * imperative composition analysis, readyWhen callback conversion, and expression
 * classification). This module provides a self-test that verifies the current runtime
 * environment produces parseable output.
 *
 * ## Why this matters
 *
 * The `Function.prototype.toString()` output varies by runtime and build configuration:
 *
 * | Environment              | Arrow function toString()                     | Parseable? |
 * |--------------------------|-----------------------------------------------|------------|
 * | Node.js / Bun (no build) | `(x) => x + 1`                               | Yes        |
 * | Bun (transpiled)         | `(x) => x + 1` (quotes normalized to double)  | Yes        |
 * | esbuild (minified)       | `x=>x+1` (whitespace removed)                 | Yes        |
 * | esbuild (mangled)        | `a=>a+1` (names mangled)                      | Partial*   |
 * | Terser (mangled)         | `a=>a+1`                                      | Partial*   |
 * | Webpack mode=production  | May inline or remove function bodies            | No         |
 * | Closure Compiler ADVANCED | Removes/renames everything                    | No         |
 *
 * *Partial: AST parses, but parameter names are mangled so `schema.spec.name`
 * becomes `a.spec.name` — the composition analyzer needs the original names.
 *
 * ## Build configurations that break TypeKro
 *
 * 1. **Variable name mangling** (`esbuild --mangle`, `terser --mangle-props`):
 *    Renames function parameters. Status builder analysis depends on parameter names
 *    matching resource keys (e.g., `(schema, resources) => ...`).
 *
 * 2. **Dead code elimination** with tree-shaking that removes function bodies:
 *    The composition analyzer needs the full function body to detect if/for/ternary
 *    patterns.
 *
 * 3. **Advanced minification** (Closure Compiler ADVANCED, UglifyJS with `compress`):
 *    May restructure control flow, inline functions, or evaluate expressions at
 *    compile time, making the source unparseable or semantically different.
 *
 * 4. **Source-to-source transforms** that don't preserve function structure:
 *    SWC with certain plugins, Babel transforms that rewrite arrow functions to
 *    regular functions with different parameter patterns.
 *
 * ## Safe configurations
 *
 * - **No bundler** (direct TypeScript execution via Bun or ts-node): Always works
 * - **esbuild with `--minify-whitespace` only** (no `--mangle`): Works
 * - **Webpack mode=development**: Works
 * - **Vite dev mode**: Works
 * - **Any bundler with `Function.prototype.toString` polyfill that preserves source**: Works
 *
 * ## Call sites that depend on fn.toString()
 *
 * | File                                | Usage                                    |
 * |-------------------------------------|------------------------------------------|
 * | `serialization/yaml.ts`             | readyWhen callback → CEL conversion      |
 * | `deployment/debug-logger.ts`        | Evaluator type inspection (non-critical) |
 * | `expressions/factory/status-builder-analyzer.ts` | Status builder AST parsing    |
 * | `expressions/context/context-detector.ts`        | Expression complexity analysis|
 * | `expressions/analysis/expression-classifier.ts`  | Function body analysis        |
 * | `expressions/composition/composition-analyzer.ts` | Composition body detection   |
 * | `expressions/composition/imperative-analyzer.ts`  | Imperative composition parse |
 * | `expressions/composition/expression-analyzer.ts`  | Pattern detection            |
 *
 * ## Future alternative: TypeScript Compiler API
 *
 * As an opt-in alternative to `fn.toString()` + acorn parsing, the TypeScript Compiler
 * API (`typescript` package) could be used to analyze user-supplied functions at build
 * time or at schema-registration time. This would eliminate the runtime dependency on
 * `fn.toString()` producing parseable output entirely.
 *
 * ### How it would work
 *
 * 1. **At `toResourceGraph()` call time**, capture the source file path and position of
 *    the status builder / composition function using `Error().stack` or a build plugin.
 * 2. **Use `ts.createProgram()`** to parse the original TypeScript source (not the
 *    transpiled output) with full type information.
 * 3. **Walk the AST** using `ts.forEachChild()` to find the function node at the
 *    captured position and extract parameter types, return types, and body structure.
 * 4. **Cache results** keyed by file path + position so re-analysis is free.
 *
 * ### Advantages
 *
 * - Works regardless of bundler/minifier configuration
 * - Has access to full TypeScript type information (not just runtime values)
 * - Can detect type errors in status builders at registration time
 * - No runtime `fn.toString()` calls needed
 *
 * ### Challenges (estimated 2+ weeks to implement)
 *
 * - **Source location capture**: Reliably mapping a runtime function call back to its
 *   source file position is non-trivial. `Error().stack` line numbers may not match
 *   original TS source after transpilation. A build plugin (Bun plugin, esbuild plugin)
 *   could inject source locations at compile time.
 * - **TypeScript as a dependency**: The `typescript` package is ~45MB. It should be an
 *   optional peer dependency, loaded dynamically with `import('typescript')`.
 * - **Performance**: `ts.createProgram()` is expensive (~500ms-2s for a medium project).
 *   Must be lazy and cached. Could use `ts.createLanguageService()` for incremental
 *   parsing.
 * - **Monorepo / workspace support**: Source files may be in different packages with
 *   different tsconfig.json files. The API would need to resolve the correct config.
 * - **Runtime-only environments**: Users running TypeKro without access to source files
 *   (e.g., in a Docker container with only compiled JS) would still need the
 *   `fn.toString()` fallback.
 * - **Test coverage**: All 12 call sites would need dual-path testing (TS API path +
 *   fn.toString() fallback path).
 *
 * ### Recommendation
 *
 * Keep `fn.toString()` as the default path with the self-test as a safety net. The TS
 * Compiler API approach should be a future opt-in for users who need bundler-safe
 * analysis. Implementation should wait until there is concrete user demand from a
 * production deployment that uses aggressive minification.
 */

import { getComponentLogger } from '../../logging/index.js';
// Import from parse-core instead of parser to break the circular dependency:
// parser.ts → fn-toString-self-test.ts → parser.ts
import { parseScriptCore } from './parse-core.js';

const logger = getComponentLogger('fn-toString-self-test');

/**
 * Known reference function used for self-testing.
 * The body must contain identifiable tokens that the parser can find.
 */
const REFERENCE_FUNCTION = function referenceTestFunction(schema: { spec: { name: string } }) {
  return { ready: true, name: schema.spec.name };
};

/**
 * Known reference arrow function.
 */
const REFERENCE_ARROW = (self: { status: { readyReplicas: number } }) =>
  self.status.readyReplicas > 0;

export interface FnToStringSelfTestResult {
  /** Whether the runtime produces parseable fn.toString() output */
  parseable: boolean;
  /** Whether parameter names are preserved (not mangled) */
  parameterNamesPreserved: boolean;
  /** Whether function bodies are preserved (not stripped) */
  functionBodiesPreserved: boolean;
  /** Whether arrow function syntax is preserved */
  arrowSyntaxPreserved: boolean;
  /** Overall: is the environment compatible with TypeKro's analysis features? */
  compatible: boolean;
  /** Detailed diagnostics */
  diagnostics: string[];
}

/**
 * Run the fn.toString() self-test.
 *
 * Call this early in the application lifecycle to detect incompatible
 * build configurations before they cause subtle analysis failures.
 *
 * @returns Self-test results with compatibility assessment
 */
export function runFnToStringSelfTest(): FnToStringSelfTestResult {
  const diagnostics: string[] = [];
  let parseable = false;
  let parameterNamesPreserved = false;
  let functionBodiesPreserved = false;
  let arrowSyntaxPreserved = false;

  // Test 1: Regular function toString() is parseable
  try {
    const fnSource = REFERENCE_FUNCTION.toString();
    diagnostics.push(`Regular function toString(): ${fnSource.slice(0, 100)}...`);

    const ast = parseScriptCore(fnSource);
    parseable = ast.type === 'Program' || ast.type === 'FunctionDeclaration';
    if (!parseable) {
      // Try wrapping — parseScriptCore may return the body node
      parseable = true; // If parseScriptCore didn't throw, the source was parseable
    }
    diagnostics.push('Regular function: parseable');
  } catch (error) {
    diagnostics.push(`Regular function: NOT parseable — ${(error as Error).message}`);
  }

  // Test 2: Arrow function toString() is parseable
  try {
    const arrowSource = REFERENCE_ARROW.toString();
    diagnostics.push(`Arrow function toString(): ${arrowSource.slice(0, 100)}...`);

    parseScriptCore(`(${arrowSource})`);
    arrowSyntaxPreserved = true;
    diagnostics.push('Arrow function: parseable');
  } catch (error) {
    diagnostics.push(`Arrow function: NOT parseable — ${(error as Error).message}`);
  }

  // Test 3: Parameter names are preserved
  try {
    const fnSource = REFERENCE_FUNCTION.toString();
    parameterNamesPreserved = fnSource.includes('schema');
    if (!parameterNamesPreserved) {
      diagnostics.push(
        'WARNING: Parameter name "schema" not found in fn.toString() output — ' +
          'names may be mangled. Status builder analysis will not work correctly.'
      );
    } else {
      diagnostics.push('Parameter names: preserved');
    }
  } catch {
    diagnostics.push('Parameter name check: failed');
  }

  // Test 4: Function bodies are preserved
  try {
    const fnSource = REFERENCE_FUNCTION.toString();
    functionBodiesPreserved = fnSource.includes('schema.spec.name') && fnSource.includes('ready');
    if (!functionBodiesPreserved) {
      diagnostics.push(
        'WARNING: Function body content not found in fn.toString() output — ' +
          'body may be stripped or transformed. Composition analysis will not work.'
      );
    } else {
      diagnostics.push('Function bodies: preserved');
    }
  } catch {
    diagnostics.push('Function body check: failed');
  }

  const compatible = parseable && parameterNamesPreserved && functionBodiesPreserved;

  return {
    parseable,
    parameterNamesPreserved,
    functionBodiesPreserved,
    arrowSyntaxPreserved,
    compatible,
    diagnostics,
  };
}

/**
 * Validate the runtime environment and log warnings if fn.toString() analysis
 * will not work correctly. This is a no-op if the environment is compatible.
 *
 * Call once during application initialization.
 */
export function validateFnToStringEnvironment(): void {
  const result = runFnToStringSelfTest();

  if (result.compatible) {
    logger.debug('fn.toString() self-test passed — runtime environment is compatible', {
      parseable: result.parseable,
      parameterNamesPreserved: result.parameterNamesPreserved,
      functionBodiesPreserved: result.functionBodiesPreserved,
      arrowSyntaxPreserved: result.arrowSyntaxPreserved,
    });
    return;
  }

  // Log detailed warnings
  logger.warn(
    'fn.toString() self-test detected potential issues — TypeKro analysis features ' +
      'may not work correctly in this build environment',
    {
      compatible: false,
      parseable: result.parseable,
      parameterNamesPreserved: result.parameterNamesPreserved,
      functionBodiesPreserved: result.functionBodiesPreserved,
      arrowSyntaxPreserved: result.arrowSyntaxPreserved,
      diagnostics: result.diagnostics,
      recommendation:
        'Ensure your bundler does not mangle variable names or strip function bodies. ' +
        'See TypeKro documentation for compatible build configurations.',
    }
  );
}
