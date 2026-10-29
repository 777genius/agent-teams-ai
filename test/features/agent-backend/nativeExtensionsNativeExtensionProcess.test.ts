import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, expect, it, vi } from 'vitest';

import { NativeExtensionProcess } from '../../../packages/legacy-agent-host/src/extensions/NativeExtensionProcess';
import type { CapturedProcessPort } from '../../../packages/legacy-agent-host/src/adapters/providers/CapturedProcess';
import type { ClaudeManagementProfile } from '../../../packages/legacy-agent-host/src/management/profile';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

const cleanup: string[] = [];
afterEach(() => {
  for (const root of cleanup.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-native-extensions-')));
  cleanup.push(root);
  const home = join(root, 'home'),
    config = join(root, 'config'),
    project = join(root, 'project');
  for (const path of [home, config, project]) mkdirSync(path);
  const profile: ClaudeManagementProfile = {
    provider: 'claude',
    profileId: 'TEST-profile',
    accountBinding: 'TEST-account',
    configRevision: 'TEST-revision',
    sdkRevision: '0.3.305',
    configNamespace: 'custom-directory',
    executable: { path: '/TEST/owned-native-cli', sha256: 'a'.repeat(64) },
    environment: { HOME: home, PATH: '/TEST/private-bin', CLAUDE_CONFIG_DIR: config },
    cwd: project,
    timeoutMs: 1000,
  };
  let current = true;
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  }) as unknown as ChildProcessWithoutNullStreams;
  const launch = vi.fn(() => child),
    close = vi.fn(async () => true),
    seal = vi.fn();
  const port: CapturedProcessPort = { launch, seal, confirmStopped: close, isRunning: () => false };
  const process = new NativeExtensionProcess(
    profile,
    { panel: 'mcp', scope: 'global' },
    () => {
      if (!current) throw new Error('TEST owner revoked');
    },
    () => port
  );
  return {
    profile,
    config,
    project,
    process,
    child,
    launch,
    close,
    seal,
    revoke: () => {
      current = false;
    },
  };
}
const input = { action: 'mcp.uninstall', serverName: 'TEST-original', scope: 'global' };
it('uses only the exact captured executable, cwd and finite native scope once and confirms physical release', async () => {
  const f = fixture();
  const pending = f.process.run(f.process.targetId, input);
  expect(f.launch).toHaveBeenCalledWith(
    expect.objectContaining({
      command: f.profile.executable.path,
      cwd: f.project,
      args: ['mcp', 'remove', '-s', 'user', 'TEST-original'],
    })
  );
  f.child.emit('close', 0);
  expect(await pending).toEqual({ ok: true, settled: true });
  expect(f.seal).toHaveBeenCalledTimes(1);
  expect(f.close).toHaveBeenCalledTimes(1);
  await expect(f.process.run(f.process.targetId, input)).rejects.toThrow();
  expect(f.launch).toHaveBeenCalledTimes(1);
});
it('rejects substituted scope or target before allocation', async () => {
  const f = fixture();
  await expect(f.process.run(f.process.targetId, { ...input, scope: 'user' })).rejects.toThrow();
  await expect(f.process.run('b'.repeat(64), input)).rejects.toThrow();
  expect(f.launch).not.toHaveBeenCalled();
  await f.process.close();
});
it.each(['owner', 'inode'] as const)(
  'a changed %s cannot allocate or switch to an ambient native process',
  async (kind) => {
    const f = fixture();
    if (kind === 'owner') f.revoke();
    else {
      renameSync(f.config, `${f.config}-old`);
      mkdirSync(f.config);
    }
    await expect(f.process.run(f.process.targetId, input)).rejects.toThrow();
    expect(f.launch).not.toHaveBeenCalled();
    await f.process.close();
  }
);
it('late success after revocation is not success and uncertain physical custody stays unqualified', async () => {
  const f = fixture();
  f.close.mockResolvedValue(false);
  const pending = f.process.run(f.process.targetId, input);
  f.revoke();
  f.child.emit('close', 0);
  expect(await pending).toEqual({ ok: false, settled: false });
  expect(f.launch).toHaveBeenCalledTimes(1);
  expect(f.close).toHaveBeenCalledTimes(1);
});

it('reports a verified nonzero native exit separately from UNKNOWN after physical release', async () => {
  const f = fixture();
  const pending = f.process.run(f.process.targetId, input);
  f.child.emit('close', 1);
  expect(await pending).toEqual({ ok: false, settled: true, completed: true });
});

it('uses the same captured process for bounded native diagnostics without accepting another command', async () => {
  const f = fixture();
  const pending = f.process.diagnose(f.process.targetId);
  expect(f.launch).toHaveBeenCalledWith(
    expect.objectContaining({
      args: ['mcp', 'list'],
      cwd: f.profile.cwd,
      command: f.profile.executable.path,
    })
  );
  if (!(f.child.stdout instanceof PassThrough)) throw new Error('TEST expected writable stdout');
  f.child.stdout.write('TEST: npx -y TEST-package - ✓ Connected\n');
  f.child.emit('close', 0);
  expect(await pending).toEqual({
    ok: true,
    settled: true,
    output: 'TEST: npx -y TEST-package - ✓ Connected\n',
  });
});
