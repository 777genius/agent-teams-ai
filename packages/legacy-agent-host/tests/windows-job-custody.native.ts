import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { CapturedProcess } from '../dist/adapters/providers/CapturedProcess.js';
import { assertNativeV1Build, buildNativeV1Host } from './opencode-v1-version-source.ts';

const enabled = process.env.OPENCODE_V2_EMBEDDED_WINDOWS_CUSTODY_GO === '1';
const until = async (predicate: () => Promise<boolean>, label: string) => {
  const deadline = Date.now() + 20_000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, label);
    await delay(25);
  }
};

test('actual Windows job captures original Bun before input, contains descendants after root exit and preserves a neighbor',
  { skip: !enabled, timeout: 240_000 }, async () => {
    assert.equal(process.platform, 'win32');
    assert.ok(['x64', 'arm64'].includes(process.arch));
    assert.equal(process.version, 'v24.21.0');
    assert.equal(`${process.platform}-${process.arch}`, process.env.OPENCODE_V2_TEST_PLATFORM);
    const sourceHead = process.env.OPENCODE_V2_TEST_SOURCE_HEAD!;
    assert.match(sourceHead, /^[a-f0-9]{40}$/);
    const repo = path.resolve(import.meta.dirname, '../../..');
    const hostBuild = await buildNativeV1Host(repo, sourceHead);
    const { CapturedProcess } = await import('../dist/adapters/providers/CapturedProcess.js');
    const { createWindowsJobCustody } = await import('../dist/adapters/providers/WindowsJobCustody.js');
    const receiptPath = process.env.OPENCODE_V2_EMBEDDED_WINDOWS_CUSTODY_RECEIPT!;
    assert.ok(receiptPath && path.isAbsolute(receiptPath));
    const bun = await realpath(process.env.OPENCODE_V2_EMBEDDED_BUN!);
    const bunSha256 = process.env.OPENCODE_V2_EMBEDDED_BUN_SHA256!;
    assert.match(bunSha256, /^[a-f0-9]{64}$/);
    const selection = {
      directory: await realpath(process.env.OPENCODE_V2_EMBEDDED_GRAPH!),
      manifestSha256: process.env.OPENCODE_V2_EMBEDDED_MANIFEST_SHA256!,
      version: '2.1.4' as const, platform: process.platform, arch: process.arch,
    };
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'TEST-windows-native-job-')));
    const receipt: Record<string, unknown> = { kind: 'TEST_WINDOWS_ORIGINAL_JOB_CUSTODY',
      status: 'HOLD', cleanup: false, sourceHead, platform: `${process.platform}-${process.arch}`,
      nodeVersion: process.version, bunSha256, manifestSha256: selection.manifestSha256, hostBuild,
      productQualified: false, desktopQualified: false };
    let original: CapturedProcess | undefined, neighbor: CapturedProcess | undefined;
    let passed = false, originalFailure: unknown;
    const cleanupErrors: unknown[] = [];
    try {
      for (const name of ['home', 'temp']) await mkdir(path.join(root, name));
      const actor = path.join(root, 'TEST-private-actor.mjs');
      await writeFile(actor, `
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const [mode, root] = process.argv.slice(2);
if (process.env.TEST_AMBIENT_JOB_ENV) throw new Error('TEST ambient environment loaded');
const watchdog = setTimeout(() => process.exit(91), 45000);
if (mode === 'descendant') {
  writeFileSync(path.join(root, 'TEST-descendant-ready'), String(process.pid));
  setInterval(() => writeFileSync(path.join(root, 'TEST-descendant-heartbeat'), String(Date.now())), 25);
} else {
  let input = '';
  process.stdin.on('data', chunk => {
    input += chunk;
    if (input !== 'TEST-start\\n') return;
    input = 'consumed';
    if (mode === 'neighbor') {
      writeFileSync(path.join(root, 'TEST-neighbor-ready'), String(process.pid));
      setInterval(() => writeFileSync(path.join(root, 'TEST-neighbor-heartbeat'), String(Date.now())), 25);
    } else {
      const child = spawn(process.execPath, ['--no-env-file', '--config=NUL', '--no-install',
        import.meta.filename, 'descendant', root], { cwd: root, env: process.env,
        stdio: 'ignore', detached: true, windowsHide: true });
      child.once('error', () => process.exit(92));
      child.unref();
      const waiting = setInterval(() => {
        if (!existsSync(path.join(root, 'TEST-descendant-ready'))) return;
        clearInterval(waiting); clearTimeout(watchdog); process.exit(0);
      }, 20);
    }
  });
  process.stdin.once('end', () => process.exit(0));
}
`, { flag: 'wx' });
      await writeFile(path.join(root, 'bunfig.toml'), 'preload = ["./TEST-untrusted-preload.mjs"]\n');
      await writeFile(path.join(root, 'TEST-untrusted-preload.mjs'), 'throw new Error("TEST ambient preload loaded");\n');
      await writeFile(path.join(root, '.env'), 'TEST_AMBIENT_JOB_ENV=1\n');
      const source = await createWindowsJobCustody(selection);
      const environment: Record<string, string> = { HOME: path.join(root, 'home'),
        USERPROFILE: path.join(root, 'home'), TEMP: path.join(root, 'temp'), TMP: path.join(root, 'temp'),
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}) };
      const profile = { provider: 'opencode' as const, cwd: root,
        executable: { path: bun, sha256: bunSha256 }, environment };
      original = new CapturedProcess(profile, () => true, undefined, () => true, source);
      neighbor = new CapturedProcess(profile, () => true, undefined, () => true, source);
      const request = (mode: string) => ({ command: bun, cwd: root,
        args: ['--no-env-file', '--config=NUL', '--no-install', actor, mode, root] });
      const child = original.launch(request('root')), sibling = neighbor.launch(request('neighbor'));
      assert.ok(child instanceof ChildProcess, 'Existing V2 trusted bootstrap owns a real Node child');
      child.stdin.on('error', () => {}); sibling.stdin.on('error', () => {});
      child.stdout.resume(); sibling.stdout.resume();
      const rootExit = once(child, 'exit');
      const observed = original.readNativeExecutable(child);
      const adjacent = neighbor.readNativeExecutable(sibling);
      assert.equal(observed.pid, child.pid); assert.equal(adjacent.pid, sibling.pid);
      assert.notEqual(observed.pid, adjacent.pid);
      assert.equal(observed.executableSha256, bunSha256);
      await assert.rejects(access(path.join(root, 'TEST-descendant-ready')), { code: 'ENOENT' });
      receipt.captureBeforeInput = true;
      sibling.stdin.write('TEST-start\n'); child.stdin.write('TEST-start\n');
      const [exitCode] = await rootExit;
      assert.equal(exitCode, 0);
      const heartbeat = async (name: string) => {
        try { return await readFile(path.join(root, name), 'utf8'); } catch { return undefined; }
      };
      await until(async () => Boolean(await heartbeat('TEST-descendant-heartbeat')), 'detached descendant stayed in original job');
      const first = await heartbeat('TEST-descendant-heartbeat');
      await until(async () => {
        const current = await heartbeat('TEST-descendant-heartbeat');
        return Boolean(current) && current !== first;
      }, 'descendant survives original root exit');
      receipt.descendantSurvivedRootExit = true;
      assert.equal(await original.confirmStopped(), true);
      assert.equal(await original.confirmStopped(), true);
      const stopped = await heartbeat('TEST-descendant-heartbeat');
      await delay(100);
      assert.equal(await heartbeat('TEST-descendant-heartbeat'), stopped, 'job termination stopped descendant effect');
      receipt.originalJobCleanup = 'confirmed';
      assert.deepEqual(neighbor.readNativeExecutable(sibling), adjacent);
      const other = await heartbeat('TEST-neighbor-heartbeat');
      await until(async () => Boolean(await heartbeat('TEST-neighbor-heartbeat'))
        && (await heartbeat('TEST-neighbor-heartbeat')) !== other, 'neighbor is still live');
      receipt.neighborSurvivedTargetStop = true;
      assert.equal(await neighbor.confirmStopped(), true);
      receipt.neighborJobCleanup = 'confirmed';
      await assertNativeV1Build(repo, sourceHead, hostBuild);
      passed = true;
    } catch (error) {
      originalFailure = error;
    } finally {
      // Each original owner must settle independently, including after an earlier
      // cleanup error. Preserve the initial failure and never publish PASS early.
      for (const owner of [original, neighbor]) {
        try {
          assert.equal(await owner?.confirmStopped() ?? true, true,
            'native job cleanup must be observed, never inferred from root exit');
        } catch (error) { cleanupErrors.push(error); }
      }
      if (cleanupErrors.length === 0) {
        try { await rm(root, { recursive: true, force: true }); }
        catch (error) { cleanupErrors.push(error); }
      }
      receipt.cleanup = cleanupErrors.length === 0;
      receipt.status = passed && receipt.cleanup ? 'PASS' : 'INCOMPLETE';
      try { await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 }); }
      catch (error) { cleanupErrors.push(error); }
    }
    if (originalFailure !== undefined) throw originalFailure;
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'TEST Windows job cleanup or receipt failed');
    assert.equal(passed, true);
  });
