import assert from 'node:assert/strict';
import childProcess, { ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { CapturedProcess } from '../dist/adapters/providers/CapturedProcess.js';
import { createClaudeMemberProvider } from '../dist/adapters/providers/ClaudeMemberProvider.js';
import { createScheduledRunProvider } from '../dist/adapters/providers/ScheduledRunProvider.js';
import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { startTeamMcpEndpoint } from '../dist/mcp/endpoint.js';
import { observeMemberProcessStderr } from '../dist/adapters/providers/observeMemberProcessStderr.js';
import type { RuntimeMemberProfile } from '../dist/composition/runtimeProfile.js';
import type { RuntimeProcessOutput } from '../dist/runtime/providerActivityContracts.js';

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

test('the original finite captured child retains sanitized stderr and excludes its stdout protocol',
  { skip: process.platform === 'win32' }, async () => {
    const { root, profile, request } = await setup(
      '#!/bin/sh\nprintf "%s\\n" "$TEAM_MCP_TOKEN" >&2\nprintf "%s\\n" "TEST protocol stdout"\nprintf "%s" "TEST stderr tail" >&2\n'
    );
    profile.environment.TEAM_MCP_TOKEN = 'TEST_CAPTURED_STDERR_PRIVATE';
    const custody = new CapturedProcess(profile), observations: RuntimeProcessOutput[] = [];
    try {
      const child = custody.launch(request);
      observeMemberProcessStderr(child, { profile,
        endpoint: { bearerToken: profile.environment.TEAM_MCP_TOKEN },
        observeProcessOutput: value => { observations.push(value); } }, request.args);
      child.stdout.resume();
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', () => { child.removeListener('error', reject); resolve(); });
      });
      assert.deepEqual(observations, [
        { kind: 'process-output', stream: 'stderr', text: '[redacted]' },
        { kind: 'process-output', stream: 'stderr', text: 'TEST stderr tail' },
      ]);
      assert.equal(await custody.confirmStopped(), true);
    } finally {
      await custody.confirmStopped();
      await rm(root, { recursive: true, force: true });
    }
  });

test('original process exit cannot confirm cleanup before its stdio close and final stderr tail',
  { skip: process.platform === 'win32', timeout: 5000 }, async () => {
    const { root, profile, request } = await setup(`#!${process.execPath}
const { writeSync } = require('node:fs');
writeSync(2, 'TEST original process diagnostic\\n');
writeSync(2, 'TEST original process final tail');
process.exit(7);
`);
    const custody = new CapturedProcess(profile), observations: RuntimeProcessOutput[] = [];
    try {
      const child = custody.launch(request);
      assert.ok(child instanceof ChildProcess, 'POSIX fixture retains its actual original Node child');
      observeMemberProcessStderr(child, { profile,
        observeProcessOutput: value => { observations.push(value); } }, request.args);
      child.stdout.resume();
      let closed = false, stoppedAtExit: boolean | undefined, cleanupObservedClose: boolean | undefined;
      let cleanupAtExit: Promise<boolean> | undefined;
      child.once('close', () => { closed = true; });
      const close = once(child, 'close');
      child.once('exit', () => {
        // Observe synchronously at the original OS exit, before its later stdio-close event.
        stoppedAtExit = custody.observeStopped();
        cleanupAtExit = custody.confirmStopped().then(confirmed => {
          cleanupObservedClose = closed;
          return confirmed;
        });
      });
      assert.deepEqual(await close, [7, null]);
      assert.equal(await cleanupAtExit, true);
      assert.equal(stoppedAtExit, false, 'OS exit alone cannot settle original stdio ownership');
      assert.equal(cleanupObservedClose, true, 'cleanup must observe the original close');
      assert.deepEqual(observations, [
        { kind: 'process-output', stream: 'stderr', text: 'TEST original process diagnostic' },
        { kind: 'process-output', stream: 'stderr', text: 'TEST original process final tail' },
      ]);
    } finally {
      assert.equal(await custody.confirmStopped(), true);
      await rm(root, { recursive: true, force: true });
    }
  });

test('an original spawn error without a PID still retains stdio ownership until close',
  { skip: process.platform === 'win32', timeout: 5000 }, async () => {
    const { root, profile, request } = await setup('#!/TEST-missing-native-interpreter\n');
    const custody = new CapturedProcess(profile);
    try {
      const child = custody.launch(request);
      child.stdout.resume();
      let closed = false, stoppedAtError: boolean | undefined, cleanupObservedClose: boolean | undefined;
      let error: NodeJS.ErrnoException | undefined, cleanupAtError: Promise<boolean> | undefined;
      const close = new Promise<void>(resolve => child.once('close', () => { closed = true; resolve(); }));
      child.once('error', (value: NodeJS.ErrnoException) => {
        error = value;
        stoppedAtError = custody.observeStopped();
        cleanupAtError = custody.confirmStopped().then(confirmed => {
          cleanupObservedClose = closed;
          return confirmed;
        });
      });
      await close;
      assert.equal(child.pid, undefined);
      assert.equal(error?.code, 'ENOENT');
      assert.equal(await cleanupAtError, true);
      assert.equal(stoppedAtError, false, 'a failed allocation does not skip its original close');
      assert.equal(cleanupObservedClose, true);
    } finally {
      assert.equal(await custody.confirmStopped(), true);
      await rm(root, { recursive: true, force: true });
    }
  });

test('original Claude SDK child stderr reaches the member observer before failed startup and flushes its final tail',
  { skip: process.platform === 'win32' }, async t => {
    const { root, profile } = await setup(`#!${process.execPath}
const { writeSync } = require('node:fs');
writeSync(2, 'TEST original Claude startup diagnostic\\n');
writeSync(2, 'TEST original Claude final tail');
process.exit(7);
`);
    try {
      const binding = { backendId: 'TEST-backend', teamId: profile.teamId, teamName: 'test-claude-stderr' };
      const delivery = { ...binding, runId: 'TEST-run', memberId: profile.memberId, generation: '1' };
      const owner = createFilesystemTeamOwner({
        root, binding,
        members: [{ memberId: profile.memberId, name: 'alice', role: 'lead', delivery }],
        grants: [{ principalId: profile.principalId, memberName: 'alice',
          permissions: ['read', 'task.write', 'message.write'] }],
      });
      const connection = owner.connect(profile.principalId);
      const endpoint = await startTeamMcpEndpoint({ connection, binding: delivery,
        expiresAtMs: Date.now() + profile.limits.timeoutMs, isCurrentBinding: () => true });
      try {
        const request = { tenantId: 'TEST-tenant', projectId: 'TEST-project',
          sessionId: profile.sessionId, generation: profile.generation,
          configRevision: profile.configRevision, requiredCapabilities: ['session.conversation'] };
        const observations: RuntimeProcessOutput[] = [];
        let progress = 0;
        const provider = createClaudeMemberProvider({
          profile, request, endpoint, connection, instructions: 'TEST finite selected Node child only',
          isCurrent: () => true, canAllocate: () => true,
          readCheckpoint: async () => { throw new Error('TEST checkpoint must not be read'); },
          observeProcessOutput: value => observations.push(value), onProgress: () => { progress++; },
        });
        const originalSpawn = childProcess.spawn;
        let originalClose: Promise<void> | undefined;
        t.mock.method(childProcess, 'spawn', ((...args: Parameters<typeof spawn>) => {
          assert.equal(args[0], profile.executable.path, 'only the original finite selected child');
          assert.equal(originalClose, undefined, 'one original SDK child, never a replacement');
          const child = originalSpawn(...args);
          originalClose = new Promise<void>((resolve, reject) => {
            child.once('error', reject);
            child.once('close', () => { child.removeListener('error', reject); resolve(); });
          });
          void originalClose.catch(() => {}); // The original await below still reports any launch failure.
          return child;
        }) as typeof spawn);
        syncBuiltinESMExports();
        try {
          await assert.rejects(provider.factory.open(request));
          assert.equal(await provider.cleanup(), true, 'the original finite child is physically stopped');
          assert.ok(originalClose, 'the original child was captured before its output events');
          // Physical process absence and the original pipe's final close are separate observations.
          await originalClose;
          assert.deepEqual(observations, [
            { kind: 'process-output', stream: 'stderr', text: 'TEST original Claude startup diagnostic' },
            { kind: 'process-output', stream: 'stderr', text: 'TEST original Claude final tail' },
          ]);
          assert.equal(provider.isReady(), false); assert.equal(progress, 0);
        } finally {
          t.mock.restoreAll(); syncBuiltinESMExports();
          provider.seal(); assert.equal(await provider.cleanup(), true);
        }
      } finally { await endpoint.close(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

for (const providerName of ['claude', 'codex'] as const) test(
  `original standalone ${providerName} child retains startup stderr and its closing tail without an endpoint`,
  { skip: process.platform === 'win32' }, async () => {
    const { root, profile } = await setup(`#!${process.execPath}
const { writeSync } = require('node:fs');
writeSync(2, 'TEST standalone startup diagnostic\\n');
writeSync(1, 'TEST_STANDALONE_PROTOCOL_ONLY\\n');
writeSync(2, process.env.TEST_SECRET_KEY + '\\n');
writeSync(2, 'TEST standalone closing tail');
process.exit(7);
`);
    profile.environment.TEST_SECRET_KEY = 'TEST_STANDALONE_PRIVATE_CANARY';
    const selected: RuntimeMemberProfile = providerName === 'claude' ? profile : {
      provider: 'codex', protocolRevision: '0.162.0',
      teamId: profile.teamId, memberId: profile.memberId, principalId: profile.principalId,
      sessionId: profile.sessionId, generation: profile.generation, configRevision: profile.configRevision,
      cwd: profile.cwd, model: profile.model, accountBinding: profile.accountBinding,
      executable: profile.executable, limits: profile.limits,
      environment: { ...profile.environment, CODEX_HOME: root },
      nativeOptions: { approvalPolicy: 'never', sandbox: 'read-only' },
    };
    const request = { tenantId: 'TEST-tenant', projectId: 'TEST-project',
      sessionId: selected.sessionId, generation: selected.generation, configRevision: selected.configRevision,
      requiredCapabilities: providerName === 'claude' ? ['session.conversation'] : ['text', 'tools'] };
    const observations: RuntimeProcessOutput[] = [];
    let progress = 0;
    const context = { profile: selected, request,
      binding: { backendId: 'TEST-backend', teamId: selected.teamId, runId: 'scheduled-standalone',
        memberId: 'TEST-scheduled-member', generation: 'TEST-occurrence' },
      isCurrent: () => true, onProgress: () => { progress++; },
      observeProcessOutput: (value: RuntimeProcessOutput) => { observations.push(value); },
    };
    assert.equal('endpoint' in context, false);
    const provider = createScheduledRunProvider(context);
    try {
      await assert.rejects(provider.factory.open(request), /Scheduled native session unavailable/);
      assert.equal(await provider.cleanup(), true, 'the original finite child is physically stopped');
      assert.deepEqual(observations, [
        { kind: 'process-output', stream: 'stderr', text: 'TEST standalone startup diagnostic' },
        { kind: 'process-output', stream: 'stderr', text: '[redacted]' },
        { kind: 'process-output', stream: 'stderr', text: 'TEST standalone closing tail' },
      ]);
      assert.equal(progress, 0, 'startup diagnostics do not synthesize Session observations');
    } finally {
      provider.seal();
      assert.equal(await provider.cleanup(), true);
      await rm(root, { recursive: true, force: true });
    }
  }
);

test('captured native executable pins bytes beyond one MiB again before launch and sealing forbids late allocation', async t => {
  const source = `#!/bin/sh\nexit 0\n#${'TEST original bytes '.repeat(60_000)}original tail\n`;
  const { root, profile, request } = await setup(source);
  let allocations = 0;
  t.mock.method(childProcess, 'spawn', (() => {
    allocations++;
    throw new Error('TEST process allocation must remain unreachable');
  }) as typeof childProcess.spawn);
  syncBuiltinESMExports();
  try {
    const custody = new CapturedProcess(profile);
    await writeFile(profile.executable.path, `${source.slice(0, -2)}X\n`);
    assert.throws(() => custody.launch(request), /Native executable unavailable/);
    assert.throws(() => new CapturedProcess(profile), /Native executable unavailable/);
    custody.seal();
    assert.throws(() => custody.launch(request), /unavailable/);
    assert.equal(allocations, 0, 'changed trailing bytes must refuse before any process allocation');
    assert.equal(await custody.confirmStopped(), true);
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});

for (const changed of ['inode', 'mtime', 'ctime'] as const) test(
  `captured launch rejects exact ${changed} changes hidden by numeric file metadata before spawning`,
  async (t) => {
    const { root, profile, request } = await setup('#!/bin/sh\nexit 0\n');
    const custody = new CapturedProcess(profile);
    const originalLstat = fs.lstatSync;
    const original = changed === 'inode' ? 9_007_199_254_740_992n : 1_800_000_000_000_000_000n;
    const replacement = original + 1n;
    assert.equal(Number(original), Number(replacement), 'numeric Stats conceal the exact change');
    let observations = 0, allocations = 0;
    t.mock.method(fs, 'lstatSync', ((file, options) => {
      const stat = originalLstat(file, options);
      if (stat && file === profile.executable.path) {
        const value = ++observations === 1 ? original : replacement;
        if (changed === 'inode')
          Object.defineProperty(stat, 'ino', { value: typeof stat.ino === 'bigint' ? value : Number(value) });
        else {
          Object.defineProperty(stat, `${changed}Ms`, {
            value: typeof stat.ino === 'bigint' ? value / 1_000_000n : Number(value) / 1_000_000,
          });
          if (typeof stat.ino === 'bigint') Object.defineProperty(stat, `${changed}Ns`, { value });
        }
      }
      return stat;
    }) as typeof fs.lstatSync);
    t.mock.method(childProcess, 'spawn', (() => {
      allocations++;
      throw new Error('TEST process allocation must remain unreachable');
    }) as typeof childProcess.spawn);
    syncBuiltinESMExports();
    try {
      assert.throws(() => custody.launch(request), /Native executable changed/);
      assert.equal(observations, 2);
      assert.equal(allocations, 0);
      assert.equal(await custody.confirmStopped(), true);
    } finally {
      t.mock.restoreAll(); syncBuiltinESMExports();
      await rm(root, { recursive: true, force: true });
    }
  }
);

for (const parentExited of [false, true]) test(
  parentExited
    ? 'custody holds an unverified group after parent exit until TEST descendants leave naturally'
    : 'custody closes its live original process group, preserving a neighboring process',
  { skip: process.platform === 'win32', timeout: 30_000 },
  async (t) => {
    const { root, profile, request } = await setup(
      `#!/bin/sh\n'${process.execPath.replaceAll("'", "'\\''")}' ./TEST-descendant.ts &\nwait\n`
    );
    await writeFile(join(root, 'TEST-descendant.ts'), `
import { existsSync, writeFileSync } from 'node:fs';
writeFileSync('child.pid', String(process.pid));
const deadline = Date.now() + 20000;
const timer = setInterval(() => {
  if (existsSync('TEST-release') || Date.now() >= deadline) clearInterval(timer);
}, 20);
`);
    const custody = new CapturedProcess(profile);
    const neighbor = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
    const neighborExit = once(neighbor, 'exit');
    const child = custody.launch(request);
    assert.ok(child instanceof ChildProcess, 'POSIX fixture retains its actual original Node child');
    const exit = once(child, 'exit');
    try {
      let descendant: number | undefined;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        try {
          const candidate = Number((await readFile(join(root, 'child.pid'), 'utf8')).trim());
          if (Number.isSafeInteger(candidate) && candidate > 0) { descendant = candidate; break; }
        } catch { /* The fixture may not have published its PID yet under load. */ }
        await tick();
      }
      assert.ok(descendant && Number.isSafeInteger(descendant));
      process.kill(descendant, 0);
      if (parentExited) {
        child.kill('SIGTERM');
        await exit;
        process.kill(descendant, 0); // Parent exit does not prove descendant absence or group identity.
      }
      const cleanupConfirmed = await custody.confirmStopped();
      assert.equal(cleanupConfirmed, !parentExited);
      if (parentExited) {
        process.kill(descendant, 0);
        await writeFile(join(root, 'TEST-release'), 'TEST-owned natural exit');
        assert.equal(await custody.confirmStopped(), true);
      }
      assert.throws(() => process.kill(descendant, 0), { code: 'ESRCH' });
      assert.equal(neighbor.exitCode, null);
      assert.equal(neighbor.signalCode, null);
      assert.ok(neighbor.pid);
      process.kill(neighbor.pid, 0);
      t.diagnostic(JSON.stringify({ cleanupConfirmed, descendantAbsent: true, neighborPreserved: true }));
    } finally {
      await writeFile(join(root, 'TEST-release'), 'TEST-owned cleanup');
      await custody.confirmStopped();
      neighbor.kill('SIGTERM');
      await neighborExit;
      await rm(root, { recursive: true, force: true });
    }
  }
);

test('an exited original cannot signal a positively probed replacement group',
  { skip: process.platform === 'win32', timeout: 15_000 }, async (t) => {
    const { root, profile, request } = await setup('#!/bin/sh\nexit 0\n');
    const custody = new CapturedProcess(profile);
    const child = custody.launch(request);
    assert.ok(child instanceof ChildProcess, 'POSIX fixture retains its actual original Node child');
    await once(child, 'exit');
    assert.ok(child.pid);
    const calls: (NodeJS.Signals | number | undefined)[] = [];
    // A positive numeric probe deliberately represents a reused PGID. Never send
    // real signals or attempt to force OS identifier reuse to exercise this race.
    const kill = t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
      assert.equal(pid, -child.pid!);
      calls.push(signal);
      return true;
    });
    try {
      assert.equal(await custody.confirmStopped(), false, 'presence alone retains cleanup debt');
      assert.ok(calls.length > 0, 'the replacement group was observed');
      assert.deepEqual(calls.filter(signal => signal !== 0), [], 'no TERM/KILL for a reaped root');
      kill.mock.restore();
      assert.equal(custody.observeStopped(), true, 'fresh read-only original absence settles an unknown stop');
    } finally {
      kill.mock.restore();
      await rm(root, { recursive: true, force: true });
    }
  });

test('captured launch revalidates selected cwd before any process allocation', async () => {
  const { root, profile, request } = await setup('#!/bin/sh\nexit 0\n');
  const workspace = join(root, 'workspace');
  const outside = join(root, 'other-test-workspace');
  await mkdir(workspace);
  await mkdir(outside);
  profile.cwd = workspace;
  request.cwd = workspace;
  const custody = new CapturedProcess(profile);
  try {
    await rename(workspace, join(root, 'original-workspace'));
    await symlink(outside, workspace, 'dir');
    assert.throws(() => custody.launch(request), /Invalid native directory/);
    assert.equal(await custody.confirmStopped(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
