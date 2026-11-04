// @vitest-environment node
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  isNativeProbeFatal,
  NATIVE_PROBE_CLEANUP_UNCONFIRMED,
  runOpenCodeNativeProbe,
} from '@main/services/runtime/openCodeNativeProbe';
import { afterEach, expect, it } from 'vitest';

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});
const fixture = `const fs=require('node:fs'); process.on('SIGTERM',()=>fs.writeFileSync(process.argv[2],'ignored')); fs.writeFileSync(process.argv[1],String(process.pid)); setTimeout(()=>process.exit(0),6000); setInterval(()=>{},100);`;
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}
async function fixtureReady(file: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (true) {
    try {
      await access(file);
      return;
    } catch {
      if (Date.now() >= deadline) throw new Error('Fixture did not become ready');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}
it.skipIf(process.platform === 'win32')(
  'observes physical closure after a finite child ignores the timeout TERM',
  async () => {
    root = await mkdtemp(join(tmpdir(), 'TEST-native-probe-'));
    const pidFile = join(root, 'pid'),
      termFile = join(root, 'term');
    await expect(
      runOpenCodeNativeProbe(process.execPath, ['-e', fixture, pidFile, termFile], {
        timeoutMs: 1000,
      })
    ).rejects.toThrow('timed out');
    expect(await readFile(termFile, 'utf8')).toBe('ignored');
    expect(alive(Number(await readFile(pidFile, 'utf8')))).toBe(false);
  }
);
it.skipIf(process.platform === 'win32')(
  'cancellation waits for owned child closure before rejecting',
  async () => {
    root = await mkdtemp(join(tmpdir(), 'TEST-native-probe-abort-'));
    const pidFile = join(root, 'pid'),
      termFile = join(root, 'term'),
      controller = new AbortController();
    const result = runOpenCodeNativeProbe(process.execPath, ['-e', fixture, pidFile, termFile], {
      signal: controller.signal,
    });
    const failure = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await fixtureReady(pidFile);
    controller.abort();
    await failure;
    expect(await readFile(termFile, 'utf8')).toBe('ignored');
    expect(alive(Number(await readFile(pidFile, 'utf8')))).toBe(false);
  }
);

it.skipIf(process.platform === 'win32')(
  'refuses probe authority when a finite descendant still holds its pipes',
  async () => {
    root = await mkdtemp(join(tmpdir(), 'TEST-native-probe-pipes-'));
    const pidFile = join(root, 'holder'),
      releaseFile = join(root, 'release');
    const holder = `const fs=require('node:fs');setInterval(()=>{if(fs.existsSync(process.argv[1]))process.exit(0)},20);setTimeout(()=>process.exit(0),15000);`;
    const script = `const fs=require('node:fs'),{spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',process.argv[2],process.argv[3]],{stdio:['ignore',process.stdout,process.stderr]});fs.writeFileSync(process.argv[1],String(child.pid));child.unref();process.exit(0);`;
    const result = runOpenCodeNativeProbe(
      process.execPath,
      ['-e', script, pidFile, holder, releaseFile],
      { timeoutMs: 1000 }
    ).catch((error) => error as unknown);
    await fixtureReady(pidFile);
    const pid = Number(await readFile(pidFile, 'utf8'));
    try {
      const failure = await result;
      expect(failure).toMatchObject({ code: NATIVE_PROBE_CLEANUP_UNCONFIRMED });
      expect(isNativeProbeFatal(failure)).toBe(true);
    } finally {
      await writeFile(releaseFile, 'release');
      const deadline = Date.now() + 5000;
      while (alive(pid) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(alive(pid)).toBe(false);
    }
  }
);
