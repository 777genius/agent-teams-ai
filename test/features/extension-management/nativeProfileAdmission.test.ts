// @vitest-environment node
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { createDesktopExtensionManagement } from '../../../src/features/extension-management/main/composition/createDesktopExtensionManagement';

import type { ManagementOperation } from '../../../src/features/extension-management/contracts';
import type { startUap } from '@uap/management-sdk/node';

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
vi.mock('@uap/management-sdk/node', () => ({ startUap: f.start }));
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
  f.start.mockResolvedValue({
    client: { environment: f.environment },
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
    activeClientIds: async () => new Set(),
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
