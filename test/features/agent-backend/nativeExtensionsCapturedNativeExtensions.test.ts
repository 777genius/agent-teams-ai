import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import Database from 'better-sqlite3-node';
import {
  ApplicationCommandRunner,
  ApplicationCommandLedgerStatus,
} from '@features/application-command-ledger';
import {
  InternalStorageApplicationCommandLedgerStore,
  NodeApplicationCommandHasher,
} from '@features/application-command-ledger/main';
import { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import { InProcessGateway } from '../internal-storage/helpers/InProcessGateway';

import { configureDesktopBackendPersistence } from '../../../src/main/ipc/agentBackend';
import { configureCapturedExtensionCommandRunner } from '../../../src/main/services/extensions/runtime/CapturedExtensionCommandLedger';
import { CapturedNativeExtensions } from '../../../src/main/services/extensions/runtime/CapturedNativeExtensions';
import { PluginInstallService } from '../../../src/main/services/extensions/install/PluginInstallService';
import { NativeExtensionCoordinator } from '../../../packages/legacy-agent-host/src/extensions/NativeExtensionCoordinator';
import { FileManagementCommandStore } from '../../../packages/legacy-agent-host/src/adapters/providers/FileManagementCommandStore';
import { ManagementResourceFence } from '../../../packages/legacy-agent-host/src/management/ManagementResourceFence';
import type { CapturedProviderManagement } from '../../../src/features/agent-backend/main/infrastructure/CapturedProviderManagement';
import type { ClaudeManagementProfile } from '../../../packages/legacy-agent-host/src/management/profile';
import type { PluginCatalogService } from '../../../src/main/services/extensions/catalog/PluginCatalogService';

const roots: string[] = [];
const cores: InternalStorageWorkerCore[] = [];
afterEach(() => {
  configureCapturedExtensionCommandRunner(null);
  for (const core of cores.splice(0)) core.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-captured-extension-main-')));
  roots.push(root);
  const home = join(root, 'home'),
    config = join(root, 'claude'),
    project = join(root, 'project');
  for (const path of [home, config, project]) mkdirSync(path);
  let current = true;
  const profile: ClaudeManagementProfile = {
    provider: 'claude',
    profileId: 'TEST-profile',
    accountBinding: 'TEST-account',
    configRevision: 'TEST-revision',
    sdkRevision: '0.3.305',
    configNamespace: 'custom-directory',
    environment: { HOME: home, PATH: '/TEST/none', CLAUDE_CONFIG_DIR: config },
    cwd: project,
    executable: { path: '/TEST/never-executed', sha256: 'a'.repeat(64) },
    timeoutMs: 1000,
  };
  const store = new FileManagementCommandStore(root),
    commands: unknown[] = [];
  const run = vi.fn(
    async (
      _target: string,
      command: unknown
    ): Promise<{ ok: boolean; settled: boolean; completed?: boolean }> => {
      commands.push(structuredClone(command));
      return { ok: true, settled: true };
    }
  );
  const coordinator = new NativeExtensionCoordinator([profile], {
    store,
    fence: new ManagementResourceFence(store.list()),
    assertCurrent: () => {
      if (!current) throw new Error('TEST revoked');
    },
    managementTarget: () => ({
      profileId: profile.profileId,
      configRevision: profile.configRevision,
      selectionDigest: 'b'.repeat(64),
      resourceId: 'c'.repeat(64),
    }),
    createProcess: () => ({ run, close: async () => true }),
  });
  const makeCore = () => {
    const core = new InternalStorageWorkerCore({
      databasePath: join(root, 'client', 'app.db'),
      createDatabase: (file) => new Database(file),
    });
    cores.push(core);
    return core;
  };
  let core = makeCore();
  let loseNextCompletion = false;
  let clockMs = Date.UTC(2026, 9, 23);
  const runner = () => {
    const ledger = new InternalStorageApplicationCommandLedgerStore(new InProcessGateway(core));
    const complete = ledger.markCompleted.bind(ledger);
    ledger.markCompleted = async (input) => {
      if (loseNextCompletion) {
        loseNextCompletion = false;
        throw new Error('TEST Main completion write lost');
      }
      return complete(input);
    };
    return new ApplicationCommandRunner({
      ledger,
      hasher: new NodeApplicationCommandHasher(),
      clock: () => new Date((clockMs += 1000)),
    });
  };
  const reopenRunner = () => {
    core.close();
    core = makeCore();
    return runner();
  };
  const calls: string[] = [];
  const owner: CapturedProviderManagement = {
    targetId: 'd'.repeat(64),
    profileId: profile.profileId,
    configRevision: profile.configRevision,
    isCurrent: () => current,
    async request(operation, payload) {
      calls.push(operation);
      const input = {
        ...payload,
        profileId: profile.profileId,
        configRevision: profile.configRevision,
      };
      const result =
        operation === 'extension.capture'
          ? coordinator.capture(input)
          : operation === 'extension.read'
            ? coordinator.read(input)
            : operation === 'extension.pending'
              ? coordinator.mutations.pending(input)
              : operation === 'extension.mutate'
                ? await coordinator.mutations.execute(input)
                : operation === 'extension.lookup'
                  ? coordinator.mutations.lookup(input)
                  : undefined;
      if (result === undefined) throw new Error('TEST unexpected operation');
      return JSON.parse(JSON.stringify({ ok: true, value: result }));
    },
  };
  return {
    runner,
    reopenRunner,
    loseNextCompletion: () => {
      loseNextCompletion = true;
    },
    owner,
    coordinator,
    run,
    commands,
    store,
    calls,
    revoke: () => {
      current = false;
    },
  };
}

it('preserves original catalog resolution through the existing installer and uses only its captured native target', async () => {
  const f = fixture();
  configureDesktopBackendPersistence({ configureSelectedHostBackup: vi.fn() }, f.runner());
  const native = await CapturedNativeExtensions.capture(
    f.owner,
    {
      panel: 'plugins',
      scope: 'user',
    }
  );
  const resolvePlugin = vi.fn(async () => ({
    qualifiedName: 'test@verified-market',
  }));
  const service = new PluginInstallService({
    resolvePlugin,
  } as unknown as PluginCatalogService);
  expect(await service.install({ pluginId: 'TEST-public-id', scope: 'user' }, native)).toEqual({
    state: 'success',
  });
  expect(resolvePlugin).toHaveBeenCalledWith('TEST-public-id');
  expect(f.commands).toEqual([
    {
      action: 'plugin.install',
      qualifiedName: 'test@verified-market',
      scope: 'user',
    },
  ]);
  expect(f.calls).toEqual(['extension.capture', 'extension.pending', 'extension.mutate']);
  expect([...f.store.list()]).toHaveLength(1);
  await f.coordinator.close();
});

it('revocation during catalog resolution cannot dispatch a native command or select a replacement account', async () => {
  const f = fixture();
  const native = await CapturedNativeExtensions.capture(
    f.owner,
    {
      panel: 'plugins',
      scope: 'project',
    },
    f.runner()
  );
  const resolvePlugin = vi.fn(async () => {
    f.revoke();
    return { qualifiedName: 'test@verified-market' };
  });
  const service = new PluginInstallService({
    resolvePlugin,
  } as unknown as PluginCatalogService);
  await expect(
    service.install(
      {
        pluginId: 'TEST-public-id',
        scope: 'project',
        projectPath: '/TEST/selected-project',
      },
      native
    )
  ).rejects.toThrow('Original extension selection changed');
  expect(f.commands).toEqual([]);
  expect(f.calls).toEqual(['extension.capture']);
  expect([...f.store.list()]).toEqual([]);
  await f.coordinator.close();
});

it('cold unresolved native intent remains the original read-only held command and cannot dispatch a new replacement', async () => {
  const f = fixture();
  const native = await CapturedNativeExtensions.capture(
    f.owner,
    { panel: 'mcp', scope: 'global' },
    f.runner()
  );
  f.run.mockResolvedValue({ ok: false, settled: true });
  const command = {
    action: 'mcp.uninstall' as const,
    serverName: 'TEST-server',
    scope: 'global' as const,
  };
  expect(await native.execute(command)).toMatchObject({ state: 'error' });
  const original = [...f.store.list()][0]!;
  const reopened = await CapturedNativeExtensions.capture(
    f.owner,
    {
      panel: 'mcp',
      scope: 'global',
    },
    f.runner()
  );
  expect(await reopened.execute(command)).toMatchObject({ state: 'error' });
  expect(f.run).toHaveBeenCalledOnce();
  expect([...f.store.list()]).toHaveLength(1);
  expect([...f.store.list()][0]!.commandId).toBe(original.commandId);
  await f.coordinator.close();
});

// Without retained Main command identity, Host pending is null after completion and this repeats effects.
it.each([
  { ok: true, phase: 'completed', expected: 'success' },
  { ok: false, phase: 'failed', expected: 'error' },
])(
  'lost $phase Host ACK reconciles the original durable intent without repeating effects',
  async ({ ok, phase, expected }) => {
    const f = fixture();
    f.run.mockResolvedValue({ ok, settled: true, completed: true });
    const originalRequest = f.owner.request.bind(f.owner);
    let lose = true;
    const lossy = {
      ...f.owner,
      async request(...args: Parameters<typeof f.owner.request>) {
        const response = await originalRequest(...args);
        if (args[0] === 'extension.mutate' && lose) {
          lose = false;
          throw new Error('TEST original completed response lost');
        }
        return response;
      },
    };
    const selection = { panel: 'mcp' as const, scope: 'global' as const };
    const command = {
      action: 'mcp.install' as const,
      serverName: 'TEST-server',
      installSpec: { type: 'http' as const, url: 'https://example.invalid/TEST-private-url' },
      envValues: { TEST_TOKEN: 'TEST-private-env' },
      headers: [{ key: 'Authorization', value: 'Bearer TEST-private-header' }],
      scope: 'global' as const,
    };
    const first = await CapturedNativeExtensions.capture(lossy, selection, f.runner());
    expect(await first.execute(command).catch(() => ({ state: 'error' }))).toMatchObject({
      state: 'error',
    });
    const original = [...f.store.list()][0]!;
    expect(original.phase).toBe(phase);
    const reopenedRunner = f.reopenRunner();
    const reconstructed = await CapturedNativeExtensions.capture(
      f.owner,
      selection,
      reopenedRunner
    );
    expect(await reconstructed.execute(command)).toMatchObject({
      state: expected,
    });
    expect(f.run).toHaveBeenCalledOnce();
    expect([...f.store.list()]).toHaveLength(1);
    expect(f.calls.filter((call) => call === 'extension.mutate')).toHaveLength(1);
    expect(f.calls.filter((call) => call === 'extension.lookup')).toHaveLength(1);
    const rows = await reopenedRunner.readScope('captured-native-extensions', f.owner.targetId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      commandId: original.commandId,
      status: ApplicationCommandLedgerStatus.Completed,
      attemptCount: 1,
    });
    expect(JSON.parse(rows[0]!.metadataJson!)).toMatchObject({
      ownerTargetId: f.owner.targetId,
      intentDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      target: {
        profileId: f.owner.profileId,
        configRevision: f.owner.configRevision,
        panel: 'mcp',
        scope: 'global',
      },
    });
    for (const privateValue of [
      'TEST-server',
      'TEST-private-url',
      'TEST-private-env',
      'TEST-private-header',
    ])
      expect(JSON.stringify(rows)).not.toContain(privateValue);
    await f.coordinator.close();
  }
);

it('missing original lookup remains unknown across SQLite reopen and never dispatches a replacement', async () => {
  const f = fixture();
  const request = f.owner.request.bind(f.owner);
  const owner = {
    ...f.owner,
    async request(...args: Parameters<typeof f.owner.request>) {
      if (args[0] === 'extension.lookup') return { ok: true, value: null };
      const response = await request(...args);
      if (args[0] === 'extension.mutate') throw new Error('TEST response lost');
      return response;
    },
  };
  const selection = { panel: 'mcp' as const, scope: 'global' as const };
  const command = {
    action: 'mcp.uninstall' as const,
    serverName: 'TEST-server',
    scope: 'global' as const,
  };
  const first = await CapturedNativeExtensions.capture(owner, selection, f.runner());
  expect(await first.execute(command)).toMatchObject({ state: 'error' });
  const original = [...f.store.list()][0]!;
  const runner = f.reopenRunner();
  const reconstructed = await CapturedNativeExtensions.capture(owner, selection, runner);
  expect(await reconstructed.execute({ ...command, serverName: 'TEST-other' })).toMatchObject({
    state: 'error',
  });
  expect(await reconstructed.execute(command)).toMatchObject({
    state: 'error',
  });
  expect(await reconstructed.execute(command)).toMatchObject({
    state: 'error',
  });
  expect(f.run).toHaveBeenCalledOnce();
  expect([...f.store.list()]).toHaveLength(1);
  const rows = await runner.readScope('captured-native-extensions', f.owner.targetId);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    commandId: original.commandId,
    status: ApplicationCommandLedgerStatus.UnknownAfterTimeout,
    attemptCount: 1,
  });
  await f.coordinator.close();
});

it('known terminal observations allow a legitimate install uninstall reinstall lifecycle', async () => {
  const f = fixture();
  const selection = { panel: 'plugins' as const, scope: 'user' as const };
  for (const action of ['plugin.install', 'plugin.uninstall', 'plugin.install'] as const) {
    const native = await CapturedNativeExtensions.capture(f.owner, selection, f.reopenRunner());
    expect(
      await native.execute({
        action,
        qualifiedName: 'test@verified-market',
        scope: 'user',
      })
    ).toEqual({ state: 'success' });
  }
  expect(f.run).toHaveBeenCalledTimes(3);
  expect(new Set([...f.store.list()].map((row) => row.commandId)).size).toBe(3);
  const rows = await f.runner().readScope('captured-native-extensions', f.owner.targetId);
  expect(rows).toHaveLength(3);
  expect(rows.every((row) => row.status === ApplicationCommandLedgerStatus.Completed)).toBe(true);
  await f.coordinator.close();
});

it('selected native mutations refuse unavailable durable storage before any Host mutation', async () => {
  const f = fixture();
  const native = await CapturedNativeExtensions.capture(
    f.owner,
    { panel: 'plugins', scope: 'user' },
    null
  );
  await expect(
    native.execute({
      action: 'plugin.install',
      qualifiedName: 'test@verified-market',
      scope: 'user',
    })
  ).rejects.toThrow('Durable extension command storage is unavailable');
  expect(f.run).not.toHaveBeenCalled();
  expect([...f.store.list()]).toHaveLength(0);
  expect(f.calls).toEqual(['extension.capture']);
  await f.coordinator.close();
});

it('a crash before Main completion commit reconciles a started original without callback retry', async () => {
  const f = fixture();
  const selection = { panel: 'plugins' as const, scope: 'user' as const };
  const command = {
    action: 'plugin.install' as const,
    qualifiedName: 'test@verified-market',
    scope: 'user' as const,
  };
  const first = await CapturedNativeExtensions.capture(f.owner, selection, f.runner());
  f.loseNextCompletion();
  expect(await first.execute(command)).toMatchObject({ state: 'error' });
  const original = [...f.store.list()][0]!;
  expect(original.phase).toBe('completed');
  const runner = f.reopenRunner();
  expect((await runner.readScope('captured-native-extensions', f.owner.targetId))[0]).toMatchObject(
    {
      commandId: original.commandId,
      status: ApplicationCommandLedgerStatus.Started,
    }
  );
  const reopened = await CapturedNativeExtensions.capture(f.owner, selection, runner);
  expect(await reopened.execute(command)).toEqual({ state: 'success' });
  expect(f.run).toHaveBeenCalledOnce();
  expect(f.calls.filter((call) => call === 'extension.mutate')).toHaveLength(1);
  expect(f.calls.filter((call) => call === 'extension.lookup')).toHaveLength(1);
  expect((await runner.readScope('captured-native-extensions', f.owner.targetId))[0]).toMatchObject(
    {
      commandId: original.commandId,
      status: ApplicationCommandLedgerStatus.Completed,
      attemptCount: 1,
    }
  );
  await f.coordinator.close();
});

it('concurrent different UI intents cannot outrun a lost ACK and create another durable command', async () => {
  const f = fixture();
  const request = f.owner.request.bind(f.owner);
  const lossy = {
    ...f.owner,
    async request(...args: Parameters<typeof f.owner.request>) {
      const response = await request(...args);
      if (args[0] === 'extension.mutate') throw new Error('TEST original ACK lost');
      return response;
    },
  };
  const selection = { panel: 'plugins' as const, scope: 'user' as const };
  const first = await CapturedNativeExtensions.capture(lossy, selection, f.runner());
  const second = await CapturedNativeExtensions.capture(f.owner, selection, f.runner());
  const command = {
    action: 'plugin.install' as const,
    qualifiedName: 'test@verified-market',
    scope: 'user' as const,
  };
  const outcomes = await Promise.all([
    first.execute(command),
    second.execute({ ...command, action: 'plugin.uninstall' }),
  ]);
  expect(outcomes).toEqual([
    expect.objectContaining({ state: 'error' }),
    expect.objectContaining({ state: 'error' }),
  ]);
  expect(f.run).toHaveBeenCalledOnce();
  const rows = await f.runner().readScope('captured-native-extensions', f.owner.targetId);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ status: ApplicationCommandLedgerStatus.UnknownAfterTimeout });
  expect(await second.execute(command)).toEqual({ state: 'success' });
  expect(f.run).toHaveBeenCalledOnce();
  await f.coordinator.close();
});
