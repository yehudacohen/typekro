import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, spyOn } from 'bun:test';

import { runIntegrationConsumer } from '../integration/shared-consumer-process.js';

const script = `
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.env.CONSUMER_PROBE_DIR;
writeFileSync(join(root, 'leader'), String(process.pid));
process.on('SIGTERM', () => {});
const descendant = spawn(process.execPath, ['-e', \`
  const { appendFileSync } = require('node:fs');
  const { join } = require('node:path');
  process.on('SIGTERM', () => {});
  const beat = () => appendFileSync(join(process.argv[1], 'heartbeat'), '.');
  beat(); setInterval(beat, 25);
\`, root], { stdio: 'ignore' });
writeFileSync(join(root, 'descendant'), String(descendant.pid));
const ready = setInterval(() => {
  if (!existsSync(join(root, 'heartbeat'))) return;
  if (['timeout', 'cancelled'].includes(process.env.CONSUMER_PROBE_MODE)) return;
  clearInterval(ready);
  process.exit(process.env.CONSUMER_PROBE_MODE === 'failure' ? 7 : 0);
}, 25);
`;

describe.skipIf(process.platform === 'win32')('integration consumer process ownership', () => {
  for (const mode of ['success', 'failure', 'timeout', 'cancelled']) {
    it(`quiesces a live descendant after ${mode} before returning`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'typekro-consumer-process-'));
      const filename = join(root, 'consumer.mjs');
      writeFileSync(filename, script);
      let cleanupFailure: unknown;
      let cancellation: ReturnType<typeof setInterval> | undefined;
      try {
        const run = runIntegrationConsumer(filename, {
          env: { ...process.env, CONSUMER_PROBE_DIR: root, CONSUMER_PROBE_MODE: mode },
          timeout: 2_000,
        });
        if (mode === 'cancelled') {
          cancellation = setInterval(() => {
            if (existsSync(join(root, 'heartbeat'))) {
              clearInterval(cancellation);
              process.emit('SIGTERM');
            }
          }, 25);
        }
        if (mode === 'success') await run;
        else if (mode === 'failure') await expect(run).rejects.toThrow('exited 7');
        else await expect(run).rejects.toMatchObject({
          code: mode === 'cancelled' ? 'ABORT_ERR' : 'ETIMEDOUT',
        });
        expect(readFileSync(join(root, 'heartbeat'), 'utf8').length).toBeGreaterThan(0);
        await Bun.sleep(100);
        const stopped = readFileSync(join(root, 'heartbeat'), 'utf8');
        await Bun.sleep(200);
        expect(readFileSync(join(root, 'heartbeat'), 'utf8')).toBe(stopped);
      } finally {
        clearInterval(cancellation);
        // Only the PID recorded by this controlled fixture owns this process group.
        try {
          const leader = Number(readFileSync(join(root, 'leader'), 'utf8'));
          if (Number.isSafeInteger(leader) && leader > 0) process.kill(-leader, 'SIGKILL');
        } catch (error) {
          if (!(error instanceof Error && 'code' in error
            && (error.code === 'ESRCH' || error.code === 'ENOENT'))) cleanupFailure = error;
        }
        rmSync(root, { recursive: true });
      }
      if (cleanupFailure) throw cleanupFailure;
    });
  }

  it.skipIf(process.platform !== 'darwin')('recognizes a verified owned zombie-only group', async () => {
    const root = mkdtempSync(join(tmpdir(), 'typekro-consumer-zombie-'));
    const filename = join(root, 'consumer.mjs');
    writeFileSync(filename, `
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.env.CONSUMER_PROBE_DIR;
writeFileSync(join(root, 'leader'), String(process.pid));
spawn('python3', ['-c', ${JSON.stringify(`
import os,sys,time,subprocess
from pathlib import Path
root=Path(sys.argv[1])
child=os.fork()
if child==0: os._exit(0)
os.setpgid(0,0)
try:
 for _ in range(100):
  state=subprocess.check_output(['ps','-p',str(child),'-o','stat='],text=True).strip()
  if state.startswith('Z'): break
  time.sleep(.01)
 else: raise RuntimeError('owned child did not exit')
 (root/'ready').write_text(str(child))
 deadline=time.monotonic()+5
 while not (root/'reap').exists() and time.monotonic()<deadline: time.sleep(.01)
finally:
 os.waitpid(child,0)
 (root/'reaped').write_text('yes')
`)}, root], { stdio: 'ignore' });
const ready = setInterval(() => {
  if (!existsSync(join(root, 'ready'))) return;
  clearInterval(ready); process.exit(0);
}, 10);
`);
    try {
      await runIntegrationConsumer(filename, {
        env: { ...process.env, CONSUMER_PROBE_DIR: root }, timeout: 2_000,
      });
    } finally {
      writeFileSync(join(root, 'reap'), 'yes');
      for (let attempt = 0; attempt < 200 && !existsSync(join(root, 'reaped')); attempt++) {
        await Bun.sleep(10);
      }
      expect(existsSync(join(root, 'reaped'))).toBe(true);
      rmSync(root, { recursive: true });
    }
  });

  it('keeps a permission failure for a group containing a live descendant', async () => {
    const root = mkdtempSync(join(tmpdir(), 'typekro-consumer-denied-'));
    const filename = join(root, 'consumer.mjs');
    writeFileSync(filename, script);
    const nativeKill = process.kill.bind(process);
    const denied = spyOn(process, 'kill').mockImplementation((pid, signal) => {
      const leaderPath = join(root, 'leader');
      if (signal === 'SIGKILL' && existsSync(leaderPath)
        && pid === -Number(readFileSync(leaderPath, 'utf8'))) {
        throw Object.assign(new Error('Controlled live-group permission failure.'), { code: 'EPERM' });
      }
      return nativeKill(pid, signal);
    });
    try {
      await expect(runIntegrationConsumer(filename, {
        env: { ...process.env, CONSUMER_PROBE_DIR: root, CONSUMER_PROBE_MODE: 'success' },
        timeout: 2_000,
      })).rejects.toMatchObject({ code: 'EPERM' });
    } finally {
      denied.mockRestore();
      const leader = Number(readFileSync(join(root, 'leader'), 'utf8'));
      if (Number.isSafeInteger(leader) && leader > 1) nativeKill(-leader, 'SIGKILL');
      rmSync(root, { recursive: true });
    }
  });
});
