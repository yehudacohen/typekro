import { execFileSync, spawn } from 'node:child_process';

/** Darwin excludes zombies from group signalling, which can yield EPERM for an exited group. */
function ownedGroupHasOnlyExitedMembers(group: number): boolean {
  if (process.platform !== 'darwin' || !process.getuid) return false;
  try {
    const members = execFileSync('ps', ['-axo', 'pgid=,uid=,stat='], {
      encoding: 'utf8', timeout: 1_000,
    }).trim().split('\n').map(row => row.trim().split(/\s+/))
      .filter(([pgid]) => Number(pgid) === group);
    return members.length > 0 && members.every(([pgid, uid, state, extra]) =>
      Number(pgid) === group && Number(uid) === process.getuid?.()
      && state?.startsWith('Z') === true && extra === undefined);
  } catch {
    // An unavailable observation cannot establish that the owned group has exited.
    return false;
  }
}

/** Run a disposable integration hook and quiesce its inherited process group before teardown. */
export async function runIntegrationConsumer(
  script: string,
  options: { readonly env: NodeJS.ProcessEnv; readonly timeout: number }
): Promise<void> {
  if (process.platform === 'win32') {
    throw new Error('Integration consumer cleanup requires POSIX process groups.');
  }
  if (!Number.isSafeInteger(options.timeout) || options.timeout <= 0) {
    throw new Error('Integration consumer requires a positive, bounded timeout.');
  }
  const child = spawn('node', [script], {
    env: options.env,
    stdio: 'inherit',
    detached: true,
  });
  const group = child.pid;
  let failure: Error | undefined;
  let cleanupFailure: unknown;
  const stopGroup = () => {
    if (!group || group <= 1) return;
    try {
      process.kill(-group, 'SIGKILL');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EPERM'
        && ownedGroupHasOnlyExitedMembers(group)) return;
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
        cleanupFailure ??= error;
        try {
          child.kill('SIGKILL');
        } catch (leaderError) {
          cleanupFailure = new AggregateError([cleanupFailure, leaderError]);
        }
      }
    }
  };
  const cancel = () => {
    failure ??= Object.assign(new Error('Integration consumer cancelled.'), { code: 'ABORT_ERR' });
    stopGroup();
  };
  const deadline = setTimeout(() => {
    failure ??= Object.assign(new Error('Integration consumer deadline expired.'), {
      code: 'ETIMEDOUT',
    });
    stopGroup();
  }, options.timeout);
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        if (code !== 0) {
          failure ??= new Error(`Integration consumer exited ${signal ?? code}.`);
        }
        resolve();
      });
    });
  } catch (error) {
    if (error instanceof Error) failure ??= error;
    else throw error;
  } finally {
    clearTimeout(deadline);
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    stopGroup();
  }
  if (failure && cleanupFailure) throw new AggregateError([failure, cleanupFailure]);
  if (failure) throw failure;
  if (cleanupFailure) throw cleanupFailure;
}
