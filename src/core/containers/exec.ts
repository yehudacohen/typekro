/**
 * Docker CLI Execution Helper
 *
 * Wraps Bun.spawn for Docker commands with streaming output,
 * timeout support, and actionable error messages.
 */

import { getComponentLogger } from '../logging/index.js';
import { ContainerBuildError } from './errors.js';

const logger = getComponentLogger('container-exec');

/** Valid Docker build-arg key pattern. */
const VALID_BUILD_ARG_KEY = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export interface ExecDockerOptions {
  /** Pipe this string to stdin (used for docker login --password-stdin). */
  stdin?: string;
  /** Suppress stdout streaming (only log on error). */
  quiet?: boolean;
  /** Timeout in milliseconds. */
  timeout?: number;
}

export interface ExecDockerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Validate that build arg keys are safe Docker ARG names.
 * Prevents flag injection via malicious keys like "--platform".
 */
export function validateBuildArgs(buildArgs: Record<string, string>): void {
  for (const [key, value] of Object.entries(buildArgs)) {
    if (!VALID_BUILD_ARG_KEY.test(key)) {
      throw new ContainerBuildError(
        `Invalid build arg key: "${key}". Must match ${VALID_BUILD_ARG_KEY.source}`,
        'INVALID_BUILD_ARG',
        ['Build arg keys must be valid Docker ARG names (alphanumeric + underscore, starting with letter/underscore).']
      );
    }
    if (typeof value === 'string' && value.includes('\n')) {
      throw new ContainerBuildError(
        `Build arg value for "${key}" contains newlines, which may break Docker --build-arg parsing.`,
        'INVALID_BUILD_ARG',
        ['Remove newlines from build arg values.']
      );
    }
  }
}

/**
 * Execute a Docker CLI command.
 *
 * Streams output to the logger in real-time unless `quiet` is set.
 * Throws ContainerBuildError on non-zero exit or timeout.
 */
export async function execDocker(
  args: string[],
  options: ExecDockerOptions = {}
): Promise<ExecDockerResult> {
  const { stdin, quiet = false, timeout = 300_000 } = options;

  // Redact --build-arg values in logs to prevent secret leakage
  const redactedArgs = args.map((arg, i) =>
    args[i - 1] === '--build-arg' && arg.includes('=')
      ? `${arg.split('=')[0]}=***`
      : arg
  );
  logger.debug('Executing docker command', { args: ['docker', ...redactedArgs] });

  const proc = Bun.spawn(['docker', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: stdin ? 'pipe' : undefined,
  });

  if (stdin && proc.stdin) {
    proc.stdin.write(stdin);
    proc.stdin.end();
  }

  // Start reading streams immediately (before awaiting exit) to prevent
  // resource leaks if the process is killed by timeout.
  const stdoutPromise = new Response(proc.stdout).text().catch(() => '');
  const stderrPromise = new Response(proc.stderr).text().catch(() => '');

  // Race exit against timeout. The timeout promise has a .catch() no-op to
  // prevent unhandled rejections if the timeout fires at the exact moment
  // the process exits (race condition at the boundary).
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutTimer = setTimeout(() => {
      proc.kill();
      reject(new ContainerBuildError(
        `Docker command timed out after ${timeout}ms: docker ${redactedArgs.join(' ')}`,
        'BUILD_TIMEOUT',
        ['Increase the timeout option.', 'Check network connectivity for pulls.']
      ));
    }, timeout);
  });
  timeoutPromise.catch(() => { /* Prevent unhandled rejection at race boundary */ });

  const exitCode = await Promise.race([proc.exited, timeoutPromise]).finally(() => {
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
  });

  const stdout = await stdoutPromise;
  const stderr = await stderrPromise;

  if (!quiet && stdout.trim()) {
    for (const line of stdout.trim().split('\n').slice(-20)) {
      logger.info(line);
    }
  }

  if (exitCode !== 0) {
    if (!quiet) {
      for (const line of stderr.trim().split('\n')) {
        logger.error(line);
      }
    }
    throw ContainerBuildError.buildFailed(exitCode, stderr);
  }

  return { exitCode, stdout, stderr };
}

/**
 * Check if Docker is available and the daemon is running.
 */
export async function checkDockerAvailable(): Promise<void> {
  try {
    const proc = Bun.spawn(['docker', 'version', '--format', '{{.Server.Version}}'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    // Read both streams concurrently before awaiting exit
    const stdoutPromise = new Response(proc.stdout).text().catch(() => '');
    const stderrPromise = new Response(proc.stderr).text().catch(() => '');
    const exitCode = await proc.exited;
    const stdout = await stdoutPromise;
    const stderr = await stderrPromise;

    if (exitCode !== 0) {
      throw ContainerBuildError.dockerNotAvailable(stderr.trim());
    }
    logger.debug('Docker available', { version: stdout.trim() });
  } catch (error) {
    if (error instanceof ContainerBuildError) throw error;
    throw ContainerBuildError.dockerNotAvailable(
      error instanceof Error ? error.message : String(error)
    );
  }
}
