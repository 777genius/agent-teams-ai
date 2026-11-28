import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { FileManagementCommandStore } from '../../../packages/legacy-agent-host/src/adapters/providers/FileManagementCommandStore';
import { NativeExtensionCoordinator } from '../../../packages/legacy-agent-host/src/extensions/NativeExtensionCoordinator';
import { ManagementResourceFence } from '../../../packages/legacy-agent-host/src/management/ManagementResourceFence';
import type { ClaudeManagementProfile } from '../../../packages/legacy-agent-host/src/management/profile';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const resourceId = 'a'.repeat(64),
  selectionDigest = 'b'.repeat(64);
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-extension-composition-')));
  roots.push(root);
  const home = join(root, 'home'),
    config = join(root, 'claude'),
    project = join(root, 'project');
  for (const path of [home, config, project]) mkdirSync(path);
  const profile: ClaudeManagementProfile = {
    provider: 'claude',
    profileId: 'TEST-original-profile',
    accountBinding: 'TEST-original-account',
    configRevision: 'TEST-original-revision',
    sdkRevision: '0.3.305',
    configNamespace: 'custom-directory',
    environment: { HOME: home, PATH: '/TEST/private', CLAUDE_CONFIG_DIR: config },
    cwd: project,
    executable: { path: '/TEST/never-executed', sha256: 'c'.repeat(64) },
    timeoutMs: 1000,
  };
  const store = new FileManagementCommandStore(root),
    fence = new ManagementResourceFence(store.list());
  const run = vi.fn(async () => ({ ok: true, settled: true })),
    close = vi.fn(async () => true);
  const createProcess = vi.fn(() => ({ run, close }));
  const coordinator = new NativeExtensionCoordinator(
    [
      profile,
      {
        ...profile,
        profileId: 'TEST-unrelated-profile',
        environment: { ...profile.environment, CLAUDE_CONFIG_DIR: '/TEST/absent-unrelated' },
      },
    ],
    {
      store,
      fence,
      assertCurrent: () => {},
      managementTarget: (profileId, configRevision) => ({
        profileId,
        configRevision,
        selectionDigest,
        resourceId,
      }),
      createProcess,
    }
  );
  const capture = () =>
    coordinator.capture({
      profileId: profile.profileId,
      configRevision: profile.configRevision,
      panel: 'mcp',
      scope: 'global',
    });
  const input = (targetId: string) => ({
    profileId: profile.profileId,
    configRevision: profile.configRevision,
    targetId,
    panel: 'mcp',
    scope: 'global',
    commandId: 'TEST-original-command',
    command: { action: 'mcp.uninstall', serverName: 'TEST-original-server', scope: 'global' },
  });
  return { profile, config, store, fence, coordinator, capture, input, createProcess, run, close };
}
it('captures without allocation and dispatches only the exact original profile rather than probing unrelated owners', async () => {
  const f = fixture(),
    original = f.capture();
  expect(f.createProcess).not.toHaveBeenCalled();
  expect(await f.coordinator.mutations.execute(f.input(original.targetId))).toMatchObject({
    phase: 'completed',
    targetId: original.targetId,
  });
  expect(f.createProcess).toHaveBeenCalledWith(
    expect.objectContaining({
      profileId: f.profile.profileId,
      environment: f.profile.environment,
      cwd: f.profile.cwd,
    }),
    { panel: 'mcp', scope: 'global' },
    expect.any(Function)
  );
  expect(f.run).toHaveBeenCalledWith(original.targetId, f.input(original.targetId).command);
  expect(f.createProcess).toHaveBeenCalledTimes(1);
  await f.coordinator.close();
});
it('a changed native file choice cannot redirect an original capture or publish a replacement command', async () => {
  const f = fixture(),
    original = f.capture();
  writeFileSync(join(f.config, '.config.json'), '{}');
  await expect(f.coordinator.mutations.execute(f.input(original.targetId))).rejects.toThrow();
  expect([...f.store.list()]).toEqual([]);
  expect(f.createProcess).not.toHaveBeenCalled();
  await f.coordinator.close();
});
it('an unconfirmed process close overrides a nominal success instead of releasing the original namespace', async () => {
  const f = fixture(),
    original = f.capture();
  f.close.mockResolvedValue(false);
  expect(await f.coordinator.mutations.execute(f.input(original.targetId))).toMatchObject({
    phase: 'held',
  });
  expect(f.store.read('TEST-original-command')).toMatchObject({
    phase: 'held',
    resourceHeld: true,
  });
  await expect(f.coordinator.close()).rejects.toThrow();
  expect(f.createProcess).toHaveBeenCalledTimes(1);
});
it('uses the same namespace fence as an already active auth command before durable or native mutation', async () => {
  const f = fixture(),
    original = f.capture();
  f.fence.reserve(resourceId, 'TEST-original-auth');
  await expect(f.coordinator.mutations.execute(f.input(original.targetId))).rejects.toThrow();
  expect([...f.store.list()]).toEqual([]);
  expect(f.createProcess).not.toHaveBeenCalled();
  f.fence.release(resourceId, 'TEST-original-auth', true);
  await f.coordinator.close();
});

it('does not inspect an unrelated project plugin root when resolving an explicit user MCP target', async () => {
  const f = fixture(),
    captured = f.capture();
  const { symlinkSync } = await import('node:fs');
  symlinkSync('/TEST/unrelated-missing', join(f.profile.cwd, '.claude'));
  expect(await f.coordinator.mutations.execute(f.input(captured.targetId))).toMatchObject({
    phase: 'completed',
  });
  expect(f.run).toHaveBeenCalledOnce();
  await f.coordinator.close();
});
