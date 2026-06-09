// @vitest-environment node
import { setAppDataBasePath, setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CodexAccountSnapshotDto } from '@features/codex-account/contracts';
import type { ChildProcess } from 'child_process';

const mockSpawnCli = vi.fn();
const mockKillProcessTree = vi.fn();
const mockResolveBinary = vi.fn();
const mockResolveShellEnv = vi.fn();
const mockResolveAppManagedCodexRuntimeBinary = vi.fn();
const mockResolveOpenCodeRuntimeBinary = vi.fn();

vi.mock('@main/utils/childProcess', () => ({
  spawnCli: (...args: unknown[]) => mockSpawnCli(...args),
  killProcessTree: (...args: unknown[]) => mockKillProcessTree(...args),
}));

vi.mock('@main/utils/shellEnv', () => ({
  getCachedShellEnv: () => mockResolveShellEnv(),
  getShellPreferredHome: () => mockResolveShellEnv().HOME,
  resolveInteractiveShellEnv: () => mockResolveShellEnv(),
}));

vi.mock('@features/codex-runtime-installer/main', () => ({
  resolveVerifiedAppManagedCodexRuntimeBinaryPath: () =>
    mockResolveAppManagedCodexRuntimeBinary(),
}));

vi.mock('../../../../src/main/services/infrastructure/OpenCodeRuntimeInstallerService', () => ({
  resolveVerifiedOpenCodeRuntimeBinaryPath: () => mockResolveOpenCodeRuntimeBinary(),
}));

vi.mock('../../../../src/main/services/team/ClaudeBinaryResolver', () => ({
  ClaudeBinaryResolver: {
    resolve: () => mockResolveBinary(),
  },
}));

type FakeChildProcess = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  pid: number;
};

function createFakeChildProcess(): FakeChildProcess {
  const child = new EventEmitter() as FakeChildProcess;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 24680;
  return child;
}

async function waitForSpawn(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (mockSpawnCli.mock.calls.length > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(mockSpawnCli).toHaveBeenCalled();
}

function readCodexLaunchConfigOverrides(args: string[] | undefined): string[] {
  if (!args) {
    return [];
  }
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--settings') {
      continue;
    }
    const value = args[index + 1];
    if (typeof value !== 'string') {
      continue;
    }
    try {
      const parsed = JSON.parse(value) as {
        codex?: { agent_teams_launch_config?: { config_overrides?: unknown } };
      };
      const overrides = parsed.codex?.agent_teams_launch_config?.config_overrides;
      if (Array.isArray(overrides)) {
        return overrides.filter((override): override is string => typeof override === 'string');
      }
    } catch {
      // Ignore non-JSON settings values.
    }
  }
  return [];
}

function createCodexSnapshot(codexHome: string): CodexAccountSnapshotDto {
  return {
    preferredAuthMode: 'auto',
    effectiveAuthMode: 'chatgpt',
    launchAllowed: true,
    launchIssueMessage: null,
    launchReadinessState: 'ready_chatgpt',
    appServerState: 'healthy',
    appServerStatusMessage: null,
    managedAccount: {
      type: 'chatgpt',
      email: 'user@example.com',
      planType: 'pro',
    },
    apiKey: {
      available: false,
      source: null,
      sourceLabel: null,
    },
    requiresOpenaiAuth: false,
    localAccountArtifactsPresent: true,
    localActiveChatgptAccountPresent: true,
    runtimeContext: {
      binaryPath: '/mock/codex',
      codexHome,
    },
    login: {
      status: 'idle',
      error: null,
      startedAt: null,
    },
    rateLimits: null,
    updatedAt: '2026-06-09T00:00:00.000Z',
  };
}

describe('ScheduledTaskExecutor safe e2e', () => {
  let tempRoot = '';
  let tempClaudeRoot = '';
  let codexHome = '';
  let projectDir = '';
  let ScheduledTaskExecutor: typeof import('../../../../src/main/services/schedule/ScheduledTaskExecutor').ScheduledTaskExecutor;
  let providerConnectionService: typeof import('../../../../src/main/services/runtime/ProviderConnectionService').providerConnectionService;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduled-codex-e2e-'));
    tempClaudeRoot = path.join(tempRoot, '.claude');
    codexHome = path.join(tempRoot, '.codex');
    projectDir = path.join(tempRoot, 'project');
    fs.mkdirSync(tempClaudeRoot, { recursive: true });
    fs.mkdirSync(codexHome, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(codexHome, 'config.toml'), 'service_tier = "priority"\n', 'utf8');

    setClaudeBasePathOverride(tempClaudeRoot);
    setAppDataBasePath(path.join(tempRoot, 'app-data'));

    mockResolveBinary.mockResolvedValue('/mock/claude-multimodel');
    mockResolveShellEnv.mockReturnValue({
      PATH: '/usr/bin',
      HOME: tempRoot,
      OPENAI_API_KEY: 'should-be-removed',
      CODEX_API_KEY: 'should-also-be-removed',
    });
    mockResolveAppManagedCodexRuntimeBinary.mockResolvedValue(null);
    mockResolveOpenCodeRuntimeBinary.mockResolvedValue(null);

    const configModule = await import('../../../../src/main/services/infrastructure/ConfigManager');
    configModule.ConfigManager.resetInstance();
    const providerModule = await import(
      '../../../../src/main/services/runtime/ProviderConnectionService'
    );
    providerConnectionService = providerModule.providerConnectionService;
    providerConnectionService.setCodexAccountFeature({
      getSnapshot: vi.fn(async () => createCodexSnapshot(codexHome)),
    });
    const executorModule = await import(
      '../../../../src/main/services/schedule/ScheduledTaskExecutor'
    );
    ScheduledTaskExecutor = executorModule.ScheduledTaskExecutor;
  });

  afterEach(() => {
    providerConnectionService?.setCodexAccountFeature(null);
    setClaudeBasePathOverride(null);
    setAppDataBasePath(null);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('orders app-owned Codex flex service tier before scheduled explicit fast mode args', async () => {
    const child = createFakeChildProcess();
    mockSpawnCli.mockReturnValue(child as unknown as ChildProcess);

    const executor = new ScheduledTaskExecutor();
    const resultPromise = executor.execute({
      runId: 'scheduled-codex-fast-e2e',
      maxTurns: 3,
      config: {
        cwd: projectDir,
        prompt: 'Run scheduled Codex task',
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: 'gpt-5.4',
        fastMode: 'on',
        resolvedFastMode: true,
      },
    });

    await waitForSpawn();

    const launchArgs = mockSpawnCli.mock.calls[0]?.[1] as string[] | undefined;
    const overrides = readCodexLaunchConfigOverrides(launchArgs);
    expect(overrides).toEqual(
      expect.arrayContaining([
        'service_tier="flex"',
        'service_tier="fast"',
        'features.fast_mode=true',
      ])
    );
    const flexIndex = overrides.indexOf('service_tier="flex"');
    const fastIndex = overrides.indexOf('service_tier="fast"');
    expect(flexIndex).toBeGreaterThanOrEqual(0);
    expect(fastIndex).toBeGreaterThan(flexIndex);

    const spawnOptions = mockSpawnCli.mock.calls[0]?.[2] as
      | { env?: NodeJS.ProcessEnv; cwd?: string }
      | undefined;
    expect(spawnOptions?.cwd).toBe(projectDir);
    expect(spawnOptions?.env).toMatchObject({
      CODEX_HOME: codexHome,
      CODEX_CLI_PATH: '/mock/codex',
      CLAUDE_CODE_CODEX_FORCED_LOGIN_METHOD: 'chatgpt',
    });
    expect(spawnOptions?.env?.OPENAI_API_KEY).toBeUndefined();
    expect(spawnOptions?.env?.CODEX_API_KEY).toBeUndefined();

    child.stdout.emit(
      'data',
      Buffer.from(JSON.stringify({ type: 'assistant', content: [{ type: 'text', text: 'done' }] }))
    );
    child.emit('close', 0);

    await expect(resultPromise).resolves.toMatchObject({
      exitCode: 0,
      summary: 'done',
    });
  });
});
