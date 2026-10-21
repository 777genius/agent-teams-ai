import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { CapturedClaudeProcess } from '../dist/adapters/providers/CapturedClaudeProcess.js';
import type { RuntimeMemberProfile } from '../dist/composition/runtimeProfile.js';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 20));
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

async function setup(source: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-native-custody-')));
  const executable = join(root, 'test-process');
  await writeFile(executable, source, { mode: 0o700 });
  await chmod(executable, 0o700);
  const profile: RuntimeMemberProfile = {
    provider: 'claude',
    teamId: 'TEST-team',
    memberId: 'alice',
    principalId: 'alice-session',
    sessionId: 'TEST-session',
    generation: 1,
    configRevision: 'TEST-revision',
    cwd: root,
    model: 'TEST-model',
    accountBinding: 'TEST-account',
    executable: { path: executable, sha256: sha(source) },
    environment: { HOME: root, CLAUDE_CONFIG_DIR: root, PATH: '/usr/bin:/bin' },
    nativeTools: [],
    autoAllowedTools: [],
    limits: {
      queuedInputs: 1,
      inputBytes: 1024,
      outputBytes: 1024,
      outputEvents: 10,
      pendingInteractions: 1,
      timeoutMs: 1000,
    },
  };
  return {
    root,
    profile,
    request: {
      command: executable,
      args: [],
      cwd: root,
      env: {},
      signal: new AbortController().signal,
    },
  };
}

test('captured native executable is pinned again at launch and sealing forbids late allocation', async () => {
  const { root, profile, request } = await setup('#!/bin/sh\nexit 0\n');
  try {
    const custody = new CapturedClaudeProcess(profile);
    await writeFile(profile.executable.path, '#!/bin/sh\nexit 7\n');
    assert.throws(() => custody.launch(request), /unavailable/);
    custody.seal();
    assert.throws(() => custody.launch(request), /unavailable/);
    assert.equal(await custody.confirmStopped(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'custody closes only its captured process group after parent exit, preserving a neighboring process',
  { skip: process.platform === 'win32', timeout: 15_000 },
  async () => {
    const { root, profile, request } = await setup(
      '#!/bin/sh\nsleep 30 &\necho $! > child.pid\nwait\n'
    );
    const custody = new CapturedClaudeProcess(profile);
    const neighbor = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
    const neighborExit = once(neighbor, 'exit');
    const child = custody.launch(request);
    const exit = once(child, 'exit');
    try {
      let descendant: number | undefined;
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        try {
          descendant = Number(await readFile(join(root, 'child.pid'), 'utf8'));
          break;
        } catch {
          await tick();
        }
      }
      assert.ok(descendant && Number.isSafeInteger(descendant));
      process.kill(descendant, 0);
      child.kill('SIGTERM');
      await exit;
      process.kill(descendant, 0); // The captured parent exit alone did not stop its tool child.
      assert.equal(await custody.confirmStopped(), true);
      assert.throws(() => process.kill(descendant, 0), { code: 'ESRCH' });
      assert.equal(neighbor.exitCode, null);
      assert.equal(neighbor.signalCode, null);
      assert.ok(neighbor.pid);
      process.kill(neighbor.pid, 0);
    } finally {
      await custody.confirmStopped();
      neighbor.kill('SIGTERM');
      await neighborExit;
      await rm(root, { recursive: true, force: true });
    }
  }
);
