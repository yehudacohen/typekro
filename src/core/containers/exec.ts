import { spawn } from 'node:child_process';

import { getComponentLogger } from '../logging/index.js';
import { ContainerBuildError } from './errors.js';

const logger = getComponentLogger('container-exec');
const VALID_BUILD_ARG_KEY = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const MAX_CAPTURED_OUTPUT_CHARS = 1_048_576;
const FORCE_KILL_GRACE_MS = 1_000;

export interface ExecDockerOptions {
  stdin?: string;
  quiet?: boolean;
  timeout?: number;
  signal?: AbortSignal;
  environment?: Readonly<Record<string, string>>;
  /** Additional exact values to redact from errors and diagnostics. */
  sensitiveValues?: readonly string[];
}

export interface ExecDockerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function validateBuildArgs(buildArgs: Record<string, string>): void {
  for (const [key, value] of Object.entries(buildArgs)) {
    if (!VALID_BUILD_ARG_KEY.test(key)) {
      throw new ContainerBuildError(
        `Invalid build arg key: "${key}". Must match ${VALID_BUILD_ARG_KEY.source}`,
        'INVALID_BUILD_ARG',
        ['Build arg keys must be valid Docker ARG names.']
      );
    }
    if (value.includes('\n')) {
      throw new ContainerBuildError(
        `Build arg value for "${key}" contains newlines.`,
        'INVALID_BUILD_ARG',
        ['Remove newlines from build arg values.']
      );
    }
  }
}

function redact(value: string, sensitiveValues: readonly string[]): string {
  return sensitiveValues.reduce(
    (current, sensitive) => (sensitive ? current.split(sensitive).join('***') : current),
    value
  );
}

function redactedDockerArgs(args: readonly string[]): string[] {
  return args.map((arg, index) => {
    if (args[index - 1] === '--build-arg' && arg.includes('=')) {
      return `${arg.slice(0, arg.indexOf('='))}=***`;
    }
    if (args[index - 1] === '--password') return '***';
    return arg;
  });
}

function appendBounded(current: string, chunk: string): string {
  const combined = current + chunk;
  return combined.length <= MAX_CAPTURED_OUTPUT_CHARS
    ? combined
    : combined.slice(-MAX_CAPTURED_OUTPUT_CHARS);
}

/** Execute Docker through a Node-compatible process boundary with timeout and cancellation. */
export async function execDocker(
  args: string[],
  options: ExecDockerOptions = {}
): Promise<ExecDockerResult> {
  const {
    stdin,
    quiet = false,
    timeout = 300_000,
    signal,
    environment = {},
    sensitiveValues = [],
  } = options;
  if (signal?.aborted) throw ContainerBuildError.cancelled();

  const safeArgs = redactedDockerArgs(args);
  logger.debug('Executing docker command', { args: ['docker', ...safeArgs] });

  const child = spawn('docker', args, {
    env: { ...process.env, ...environment },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout = appendBounded(stdout, chunk);
  });
  child.stderr.on('data', (chunk: string) => {
    stderr = appendBounded(stderr, chunk);
  });
  child.stdin.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE')
      logger.debug('Docker stdin closed unexpectedly', { error: error.message });
  });
  if (stdin !== undefined) child.stdin.end(stdin);
  else child.stdin.end();

  let timedOut = false;
  let cancelled = false;
  let forceKillHandle: ReturnType<typeof setTimeout> | undefined;
  const terminate = () => {
    child.kill('SIGTERM');
    forceKillHandle ??= setTimeout(() => child.kill('SIGKILL'), FORCE_KILL_GRACE_MS);
  };
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    terminate();
  }, timeout);
  const abort = () => {
    cancelled = true;
    terminate();
  };
  signal?.addEventListener('abort', abort, { once: true });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  }).finally(() => {
    clearTimeout(timeoutHandle);
    if (forceKillHandle) clearTimeout(forceKillHandle);
    signal?.removeEventListener('abort', abort);
  });

  if (cancelled) throw ContainerBuildError.cancelled();
  if (timedOut) {
    throw ContainerBuildError.timeout(timeout, `docker ${safeArgs.join(' ')}`);
  }

  const safeStdout = redact(stdout, sensitiveValues);
  const safeStderr = redact(stderr, sensitiveValues);
  if (!quiet && safeStdout.trim()) {
    for (const line of safeStdout.trim().split('\n').slice(-20)) logger.info(line);
  }
  if (exitCode !== 0) {
    if (!quiet) {
      for (const line of safeStderr.trim().split('\n').slice(-40)) logger.error(line);
    }
    throw ContainerBuildError.commandFailed(exitCode, safeArgs, safeStderr);
  }
  return { exitCode, stdout: safeStdout, stderr: safeStderr };
}

export async function checkDockerAvailable(signal?: AbortSignal): Promise<void> {
  try {
    const result = await execDocker(['version', '--format', '{{.Server.Version}}'], {
      quiet: true,
      timeout: 15_000,
      ...(signal ? { signal } : {}),
    });
    logger.debug('Docker available', { version: result.stdout.trim() });
  } catch (error) {
    if (error instanceof ContainerBuildError && error.code === 'BUILD_CANCELLED') throw error;
    throw ContainerBuildError.dockerNotAvailable(
      error instanceof Error ? error.message : String(error)
    );
  }
}
