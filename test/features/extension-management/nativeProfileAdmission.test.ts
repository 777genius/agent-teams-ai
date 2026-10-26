// @vitest-environment node
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { createDesktopExtensionManagement } from '../../../src/features/extension-management/main/composition/createDesktopExtensionManagement';

import type {
  ExtensionClient,
  ManagementClient,
  ManagementOperation,
  ManagementPlan,
} from '../../../src/features/extension-management/contracts';
import type { discoverTargets, startUap } from '@uap/management-sdk/node';

const f = vi.hoisted(() => ({
  home: '',
  claudeRoot: '',
  codexRoot: '',
  openCodeRoot: '',
  claude: vi.fn<() => Promise<string | null>>(),
  codex: vi.fn<() => Promise<string | null>>(),
  openCode: vi.fn<() => Promise<string | null>>(),
  supportedOverride: vi.fn<() => Promise<boolean>>(),
  activeEnvironment: vi.fn(),
  environment: vi.fn(),
  start: vi.fn<(options: Parameters<typeof startUap>[0]) => Promise<unknown>>(),
  discover: vi.fn<typeof discoverTargets>(),
  activeClients: vi.fn<() => Promise<ReadonlySet<ExtensionClient>>>(),
  prepare: vi.fn<ManagementClient['prepare']>(),
  discard: vi.fn(async () => {}),
}));

vi.mock('@main/services/team/ClaudeBinaryResolver', () => ({
  ClaudeBinaryResolver: { resolveNative: f.claude },
}));
vi.mock('@main/services/infrastructure/codexAppServer', () => ({
  CodexBinaryResolver: { resolve: f.codex },
}));
vi.mock('@main/services/infrastructure/OpenCodeRuntimeInstallerService', () => ({
  resolveVerifiedOpenCodeRuntimeBinaryPath: f.openCode,
  isSupportedOpenCodeRuntimeBinaryPath: f.supportedOverride,
}));
vi.mock('@main/services/runtime/providerAwareCliEnv', () => ({
  buildProviderAwareCliEnv: f.activeEnvironment,
  buildPassiveProviderStatusCliEnv: () => ({
    env: { HOME: f.home, CODEX_HOME: f.codexRoot, OPENCODE_CONFIG_DIR: f.openCodeRoot },
    connectionIssues: {},
    providerArgs: [],
  }),
}));
vi.mock('@main/utils/pathDecoder', () => ({
  getHomeDir: () => f.home,
  getClaudeBasePath: () => f.claudeRoot,
}));
vi.mock('@uap/management-sdk/node', () => ({ startUap: f.start, discoverTargets: f.discover }));
vi.mock(
  '../../../src/features/extension-management/main/infrastructure/resolveUapExecutable',
  () => ({
    resolveUapExecutable: async () => process.execPath,
  })
);

let runtime: ReturnType<typeof createDesktopExtensionManagement>;

beforeEach(async () => {
  vi.resetAllMocks();
  vi.stubEnv('CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH', '');
  vi.stubEnv('OPENCODE_BIN_PATH', '');
  f.home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'uap-profile-admission-')));
  f.claudeRoot = path.join(f.home, '.claude');
  f.codexRoot = path.join(f.home, '.codex');
  f.openCodeRoot = path.join(f.home, '.config', 'opencode');
  f.claude.mockResolvedValue(process.execPath);
  f.codex.mockResolvedValue(process.execPath);
  f.openCode.mockResolvedValue(process.execPath);
  f.activeEnvironment.mockImplementation(() => {
    throw new Error('Profile capture must not prepare unrelated runtime launches');
  });
  f.environment.mockResolvedValue({ entries: [], diagnostics: [], pendingOperations: [] });
  f.discover.mockResolvedValue({ apiVersion: 1, engineVersion: 'test', targets: [] });
  f.activeClients.mockResolvedValue(new Set());
  f.start.mockResolvedValue({
    client: { environment: f.environment, prepare: f.prepare, plans: { discard: f.discard } },
    session: {
      apiVersion: 1,
      engineVersion: 'test',
      contextId: 'captured-profiles',
      environmentId: 'shared-environment',
      scope: 'user',
      targets: [],
      capabilities: [],
    },
    close: async () => {},
  });
  runtime = createDesktopExtensionManagement({
    resourceRoot: f.home,
    isLocal: () => true,
    activeClientIds: f.activeClients,
    savedRequest: async () => null,
    knownProjects: async () => [],
  });
});

afterEach(async () => {
  await runtime.feature.close();
  await rm(f.home, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const launch = (operation: () => Promise<string>) =>
  runtime.admitLaunch(
    { teamName: 'isolated', providerId: 'anthropic', cwd: f.home, members: [] },
    operation
  );

it('retains every profile root when another native executable probe fails', async () => {
  f.openCode.mockRejectedValue(new Error('OpenCode probe timed out'));
  const operation = vi.fn(async () => 'launched');
  await expect(launch(operation)).resolves.toBe('launched');
  expect(f.environment).toHaveBeenCalled();
  expect(operation).toHaveBeenCalledOnce();
  expect(f.activeEnvironment).not.toHaveBeenCalled();
  expect(f.start.mock.calls[0][0].config.targets).toEqual([
    {
      id: 'claude',
      client: 'claude',
      configRoot: f.claudeRoot,
      executable: await realpath(process.execPath),
    },
    {
      id: 'codex',
      client: 'codex',
      configRoot: f.codexRoot,
      executable: await realpath(process.execPath),
    },
    { id: 'opencode', client: 'opencode', configRoot: f.openCodeRoot },
  ]);
});

it('does not substitute a default binary after an explicit OpenCode probe fails', async () => {
  vi.stubEnv('CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH', process.execPath);
  f.supportedOverride.mockRejectedValue(new Error('Explicit delivery is unverified'));
  await expect(launch(async () => 'launched')).resolves.toBe('launched');
  expect(f.openCode).not.toHaveBeenCalled();
  expect(
    f.start.mock.calls[0][0].config.targets.find((target) => target.id === 'opencode')
  ).toEqual({ id: 'opencode', client: 'opencode', configRoot: f.openCodeRoot });
});

it('keeps captured-root failures closed before launching or opening an engine', async () => {
  f.openCodeRoot = 'relative/not-authority';
  const operation = vi.fn(async () => 'launched');
  await expect(launch(operation)).rejects.toThrow('absolute path');
  expect(operation).not.toHaveBeenCalled();
  expect(f.start).not.toHaveBeenCalled();
});

it('still refuses launch when the shared durable environment has interrupted work', async () => {
  f.openCode.mockRejectedValue(new Error('OpenCode probe timed out'));
  const pending: ManagementOperation = {
    operationId: 'pending',
    requestId: 'accepted',
    planId: 'reviewed',
    contextId: 'old-context',
    environmentId: 'shared-environment',
    action: 'sync',
    state: 'interrupted',
    phase: 'apply',
    completed: 0,
    total: 1,
    items: [],
    diagnostics: [],
    createdAt: '2026-10-25T00:00:00Z',
    updatedAt: '2026-10-25T00:00:00Z',
  };
  f.environment.mockResolvedValue({ entries: [], diagnostics: [], pendingOperations: [pending] });
  const operation = vi.fn(async () => 'launched');
  await expect(launch(operation)).rejects.toThrow();
  expect(f.environment).toHaveBeenCalled();
  expect(operation).not.toHaveBeenCalled();
});

it('keeps failed engine startup closed even if another native client is unavailable', async () => {
  f.openCode.mockRejectedValue(new Error('OpenCode probe timed out'));
  f.start.mockRejectedValue(new Error('Staged UAP unavailable'));
  const operation = vi.fn(async () => 'launched');
  await expect(launch(operation)).rejects.toThrow('Staged UAP unavailable');
  expect(operation).not.toHaveBeenCalled();
});

it('captures Go-qualified extra targets without replacing primary profiles or adding authoring roots', async () => {
  const cursorRoot = path.join(f.home, 'custom-cursor-profile');
  const geminiRoot = path.join(f.home, 'retained-gemini-profile');
  f.discover.mockResolvedValue({
    apiVersion: 1,
    engineVersion: 'test',
    targets: [
      {
        client: 'codex',
        label: 'Codex',
        detectionStatus: 'detected',
        available: true,
        profile: { id: 'codex', client: 'codex', configRoot: path.join(f.home, 'other-codex') },
      },
      {
        client: 'cursor',
        label: 'Cursor',
        detectionStatus: 'detected',
        available: true,
        profile: { id: 'cursor', client: 'cursor', configRoot: cursorRoot },
      },
      {
        client: 'gemini',
        label: 'Gemini',
        detectionStatus: 'not_detected',
        available: false,
        profile: { id: 'gemini', client: 'gemini', configRoot: geminiRoot },
      },
      {
        client: 'vscode',
        label: 'VS Code',
        detectionStatus: 'detected',
        available: false,
        reason: 'Managed dependencies are deferred for this client.',
      },
    ],
  });
  const context = await runtime.feature.capture({ client: 'cursor', scope: 'user' });
  const config = f.start.mock.calls[0][0].config;
  expect(config.targets.find((target) => target.client === 'codex')?.configRoot).toBe(f.codexRoot);
  expect(config.targets.filter((target) => ['cursor', 'gemini'].includes(target.client))).toEqual([
    { id: 'cursor', client: 'cursor', configRoot: cursorRoot, detectionStatus: 'detected' },
    { id: 'gemini', client: 'gemini', configRoot: geminiRoot, detectionStatus: 'not_detected' },
  ]);
  expect(config.targets.some((target) => target.client === 'vscode')).toBe(false);
  expect(
    config.authoringRoots?.some(
      (root) => root.path.startsWith(cursorRoot) || root.path.startsWith(geminiRoot)
    )
  ).toBe(false);
  expect(context.unavailableTargets).toEqual([
    {
      client: 'vscode',
      label: 'VS Code',
      reason: 'Managed dependencies are deferred for this client.',
    },
  ]);
  expect(f.activeEnvironment).not.toHaveBeenCalled();
});

it('rejects a well-formed client key that the host has not captured', async () => {
  await expect(runtime.feature.capture({ client: 'forged-client', scope: 'user' })).rejects.toThrow(
    'captured native installation targets'
  );
  expect(f.start).not.toHaveBeenCalled();
});

it('refuses unsafe extra roots before opening a management session', async () => {
  f.discover.mockResolvedValue({
    apiVersion: 1,
    engineVersion: 'test',
    targets: [
      {
        client: 'cursor',
        label: 'Cursor',
        detectionStatus: 'detected',
        available: true,
        profile: { id: 'cursor', client: 'cursor', configRoot: 'relative/cursor-profile' },
      },
    ],
  });
  await expect(runtime.feature.capture({ client: 'claude', scope: 'user' })).rejects.toThrow(
    'absolute path'
  );
  expect(f.start).not.toHaveBeenCalled();
});

it('admits an extra-only plan beside an active primary but retains conservative admission for unknown targets', async () => {
  f.discover.mockResolvedValue({
    apiVersion: 1,
    engineVersion: 'test',
    targets: [
      {
        client: 'cursor',
        label: 'Cursor',
        detectionStatus: 'detected',
        available: true,
        profile: { id: 'cursor', client: 'cursor', configRoot: path.join(f.home, 'custom-cursor') },
      },
    ],
  });
  f.activeClients.mockResolvedValue(new Set(['claude']));
  const plan: ManagementPlan = {
    planId: 'extra-review',
    contextId: 'captured-profiles',
    action: 'install',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    confirmable: true,
    actions: [
      {
        action: 'install',
        alias: 'example',
        targetId: 'cursor',
        description: 'Install for Cursor.',
      },
    ],
    warnings: [],
    conflicts: [],
  };
  f.prepare.mockResolvedValue(plan);
  const context = await runtime.feature.capture({ client: 'cursor', scope: 'user' });
  const request = {
    contextId: context.contextId,
    change: { action: 'install' as const, source: 'publisher/example', targetIds: ['cursor'] },
  };
  await expect(runtime.feature.prepare(request)).resolves.toMatchObject({ planId: 'extra-review' });
  expect(f.discard).not.toHaveBeenCalled();
  f.prepare.mockResolvedValue({
    ...plan,
    planId: 'unknown-review',
    actions: [{ ...plan.actions[0], targetId: 'unknown-target' }],
  });
  await expect(runtime.feature.prepare(request)).rejects.toThrow('Stop the active run');
  expect(f.discard).toHaveBeenCalledWith('unknown-review');
});
