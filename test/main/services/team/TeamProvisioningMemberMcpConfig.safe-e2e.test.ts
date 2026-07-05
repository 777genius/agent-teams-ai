import {
  killTmuxPaneForCurrentPlatformSync,
  listTmuxPaneRuntimeInfoForCurrentPlatform,
  sendKeysToTmuxPaneForCurrentPlatform,
} from '@features/tmux-installer/main';
import { ClaudeBinaryResolver } from '@main/services/team/ClaudeBinaryResolver';
import { TeamProvisioningService } from '@main/services/team/TeamProvisioningService';
import { spawnCli } from '@main/utils/childProcess';
import { setAppDataBasePath } from '@main/utils/pathDecoder';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  paths: {
    claudeRoot: '',
    teamsBase: '',
    tasksBase: '',
  },
}));

let tempClaudeRoot = '';
let tempTeamsBase = '';
let tempTasksBase = '';

vi.mock('@main/services/team/ClaudeBinaryResolver', () => ({
  ClaudeBinaryResolver: { resolve: vi.fn() },
}));

vi.mock('@main/utils/childProcess', () => ({
  execCli: vi.fn(async (_binaryPath: string | null, args: string[]) => {
    if (args[0] === '-e' && args[1]?.includes('process.execPath')) {
      return {
        stdout: JSON.stringify({ execPath: process.execPath, version: process.versions.node }),
        stderr: '',
      };
    }
    if (args.includes('model') && args.includes('list')) {
      return {
        stdout: JSON.stringify({
          schemaVersion: 1,
          providers: {
            codex: {
              defaultModel: 'gpt-5.4',
              models: [{ id: 'gpt-5.4', label: 'GPT-5.4', description: 'Codex default' }],
            },
          },
        }),
        stderr: '',
      };
    }
    if (args.includes('runtime') && args.includes('status')) {
      return {
        stdout: JSON.stringify({
          providers: {
            codex: {
              runtimeCapabilities: {
                modelCatalog: { dynamic: false, source: 'runtime' },
                reasoningEffort: {
                  supported: true,
                  values: ['low', 'medium', 'high'],
                  configPassthrough: false,
                },
              },
            },
          },
        }),
        stderr: '',
      };
    }
    return { stdout: '', stderr: '' };
  }),
  spawnCli: vi.fn(),
  killProcessTree: vi.fn(),
}));

vi.mock('@features/tmux-installer/main', () => ({
  killTmuxPaneForCurrentPlatformSync: vi.fn(),
  listRuntimeProcessTableForCurrentPlatform: vi.fn(async () => []),
  listTmuxPanePidsForCurrentPlatform: vi.fn(async () => new Map()),
  listTmuxPaneRuntimeInfoForCurrentPlatform: vi.fn(async () => new Map()),
  sendKeysToTmuxPaneForCurrentPlatform: vi.fn(async () => undefined),
  isTmuxRuntimeReadyForCurrentPlatform: vi.fn(async () => true),
}));

vi.mock('@main/utils/shellEnv', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/utils/shellEnv')>();
  return {
    ...actual,
    getCachedShellEnv: () => ({ PATH: process.env.PATH ?? '', HOME: hoisted.paths.claudeRoot }),
    getShellPreferredHome: () => hoisted.paths.claudeRoot || actual.getShellPreferredHome(),
    resolveInteractiveShellEnv: vi.fn(async () => ({
      PATH: process.env.PATH ?? '',
      HOME: hoisted.paths.claudeRoot,
    })),
  };
});

vi.mock('@main/utils/pathDecoder', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/utils/pathDecoder')>();
  return {
    ...actual,
    getAutoDetectedClaudeBasePath: () => hoisted.paths.claudeRoot,
    getClaudeBasePath: () => hoisted.paths.claudeRoot,
    getTeamsBasePath: () => hoisted.paths.teamsBase,
    getTasksBasePath: () => hoisted.paths.tasksBase,
  };
});

type BootstrapSpec = {
  members?: Array<{
    name?: string;
    provider?: string;
    model?: string;
    mcpConfigPath?: string;
    mcpSettingSources?: string;
    strictMcpConfig?: boolean;
  }>;
};
type BootstrapSpecMember = NonNullable<BootstrapSpec['members']>[number];

type ProvisioningServiceOverrides = {
  buildProvisioningEnv: () => Promise<{
    env: Record<string, string>;
    authSource: string;
    geminiRuntimeAuth: null;
    providerArgs: string[];
  }>;
  resolveProviderDefaultModel: () => Promise<string>;
  normalizeTeamConfigForLaunch: () => Promise<void>;
  updateConfigProjectPath: () => Promise<void>;
  restorePrelaunchConfig: () => Promise<void>;
  assertConfigLeadOnlyForLaunch: () => Promise<void>;
  persistLaunchStateSnapshot: () => Promise<void>;
  validateAgentTeamsMcpRuntime: () => Promise<void>;
  pathExists: () => Promise<boolean>;
  startFilesystemMonitor: () => void;
};

function createFakeChild() {
  const child = Object.assign(new EventEmitter(), {
    pid: 12345,
    stdin: Object.assign(new EventEmitter(), {
      writable: true,
      write: vi.fn((_data: unknown, cb?: (err?: Error | null) => void) => {
        if (typeof cb === 'function') cb(null);
        return true;
      }),
      end: vi.fn(),
      on: vi.fn(),
      unref: vi.fn(),
    }),
    stdout: Object.assign(new EventEmitter(), {
      pipe: vi.fn(),
      unref: vi.fn(),
    }),
    stderr: Object.assign(new EventEmitter(), {
      pipe: vi.fn(),
      unref: vi.fn(),
    }),
    kill: vi.fn(),
    unref: vi.fn(),
  });
  return child;
}

function extractBootstrapSpec(): BootstrapSpec {
  const args = vi.mocked(spawnCli).mock.calls[0]?.[1] as string[] | undefined;
  const specFlagIndex = args?.indexOf('--team-bootstrap-spec') ?? -1;
  const specPath = specFlagIndex >= 0 ? args?.[specFlagIndex + 1] : null;
  if (!specPath) {
    throw new Error('Failed to extract bootstrap spec path from spawn args');
  }
  return JSON.parse(fs.readFileSync(specPath, 'utf8')) as BootstrapSpec;
}

function extractMcpConfigPathFromArgs(args: string[]): string {
  const mcpFlagIndex = args.indexOf('--mcp-config');
  if (mcpFlagIndex < 0 || !args[mcpFlagIndex + 1]) {
    throw new Error('Failed to extract MCP config path from launch args');
  }
  return args[mcpFlagIndex + 1];
}

function configureLaunchStubs(svc: TeamProvisioningService): void {
  const overrides = svc as unknown as ProvisioningServiceOverrides;
  overrides.buildProvisioningEnv = vi.fn(async () => ({
    env: { PATH: '/usr/bin', CLAUDE_TEAM_CONTROL_URL: 'http://127.0.0.1:43123' },
    authSource: 'codex_runtime',
    geminiRuntimeAuth: null,
    providerArgs: ['--settings', '{"codex":{"forced_login_method":"chatgpt"}}'],
  }));
  overrides.resolveProviderDefaultModel = vi.fn(async () => 'gpt-5.4');
  overrides.normalizeTeamConfigForLaunch = vi.fn(async () => {});
  overrides.updateConfigProjectPath = vi.fn(async () => {});
  overrides.restorePrelaunchConfig = vi.fn(async () => {});
  overrides.assertConfigLeadOnlyForLaunch = vi.fn(async () => {});
  overrides.persistLaunchStateSnapshot = vi.fn(async () => {});
  overrides.validateAgentTeamsMcpRuntime = vi.fn(async () => {});
  overrides.pathExists = vi.fn(async () => false);
  overrides.startFilesystemMonitor = vi.fn();
}

function configureCodexProviderLaunchArgs(svc: TeamProvisioningService): void {
  (
    svc as unknown as {
      buildProvisioningEnv: ProvisioningServiceOverrides['buildProvisioningEnv'];
    }
  ).buildProvisioningEnv = vi.fn(async () => ({
    env: { PATH: '/usr/bin', CLAUDE_TEAM_CONTROL_URL: 'http://127.0.0.1:43123' },
    authSource: 'codex_runtime',
    geminiRuntimeAuth: null,
    providerArgs: [
      '--settings',
      JSON.stringify({
        codex: {
          forced_login_method: 'chatgpt',
        },
      }),
    ],
  }));
}

function buildCodexLaunchConfigSettingsArgs(overrides: string[]): string[] {
  return [
    '--settings',
    JSON.stringify({
      codex: {
        agent_teams_launch_config: {
          config_overrides: overrides,
        },
      },
    }),
  ];
}

function createCodexFastLaunchIdentity() {
  return {
    providerId: 'codex',
    providerBackendId: 'codex-native',
    selectedModel: 'gpt-5.4',
    selectedModelKind: 'explicit',
    resolvedLaunchModel: 'gpt-5.4',
    catalogId: 'gpt-5.4',
    catalogSource: 'app-server',
    catalogFetchedAt: '2026-04-21T00:00:00.000Z',
    selectedEffort: 'xhigh',
    resolvedEffort: 'xhigh',
    selectedFastMode: 'on',
    resolvedFastMode: true,
    fastResolutionReason: null,
  } as const;
}

function configureCodexFastLaunchIdentity(svc: TeamProvisioningService): void {
  const fastLaunchIdentity = createCodexFastLaunchIdentity();
  (
    svc as unknown as {
      resolveAndValidateLaunchIdentity: () => Promise<typeof fastLaunchIdentity>;
    }
  ).resolveAndValidateLaunchIdentity = vi.fn(async () => fastLaunchIdentity);
}

function expectExplicitFastModeWithoutFlex(args: string[] | undefined): void {
  const overrides = readCodexLaunchConfigOverrides(args);
  expect(overrides).toEqual(
    expect.arrayContaining(['service_tier="fast"', 'features.fast_mode=true'])
  );
  expect(overrides).not.toContain('service_tier="flex"');
  expect(args).not.toContain('-c');
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

function expectExplicitFastModeWithoutFlexCommand(command: string | undefined): void {
  expect(command).toContain('features.fast_mode=true');
  expect(command).not.toContain("'-c'");
  const escapedFastIndex = command?.indexOf('service_tier=\\"fast\\"') ?? -1;
  const plainFastIndex = command?.indexOf('service_tier="fast"') ?? -1;
  const fastIndex = escapedFastIndex >= 0 ? escapedFastIndex : plainFastIndex;
  expect(fastIndex).toBeGreaterThanOrEqual(0);
  expect(command).not.toContain('service_tier=\\"flex\\"');
  expect(command).not.toContain('service_tier="flex"');
}

function configureExplicitFastRuntimeArgsPlan(svc: TeamProvisioningService): void {
  (
    svc as unknown as {
      buildTeamRuntimeLaunchArgsPlan: () => Promise<{
        fastModeArgs: string[];
        runtimeTurnSettledHookArgs: string[];
        providerArgs: string[];
        settingsArgs: string[];
        extraArgs: string[];
        inheritedProviderArgs: string[];
        appManagedSettingsPath: string | null;
      }>;
    }
  ).buildTeamRuntimeLaunchArgsPlan = vi.fn(async () => ({
    fastModeArgs: buildCodexLaunchConfigSettingsArgs([
      'service_tier="fast"',
      'features.fast_mode=true',
    ]),
    runtimeTurnSettledHookArgs: [],
    providerArgs: [
      '--settings',
      JSON.stringify({
        codex: {
          forced_login_method: 'chatgpt',
        },
      }),
    ],
    settingsArgs: [],
    extraArgs: [],
    inheritedProviderArgs: [],
    appManagedSettingsPath: null,
  }));
}

function writeProjectMcpConfig(projectDir: string): void {
  fs.writeFileSync(
    path.join(projectDir, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        tavily: { command: 'node', args: ['tavily.js'] },
        'brave-real-browser': { command: 'node', args: ['brave.js'] },
      },
    }),
    'utf8'
  );
}

function expectAppOnlyMcpConfigPath(mcpConfigPath: string): void {
  const memberMcpConfig = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8')) as {
    mcpServers: Record<
      string,
      { command?: string; args?: string[]; enabled?: boolean; env?: Record<string, string> }
    >;
  };
  expect(Object.keys(memberMcpConfig.mcpServers)).toEqual(['agent-teams']);
  expect(memberMcpConfig.mcpServers['agent-teams']).toMatchObject({
    enabled: true,
    env: {
      AGENT_TEAMS_MCP_CLAUDE_DIR: tempClaudeRoot,
      CLAUDE_TEAM_CONTROL_URL: 'http://127.0.0.1:43123',
    },
  });
  expect(memberMcpConfig.mcpServers.tavily).toBeUndefined();
  expect(memberMcpConfig.mcpServers['brave-real-browser']).toBeUndefined();
}

function expectAppOnlyMemberMcpConfig(member: BootstrapSpecMember | undefined): void {
  expect(member?.mcpConfigPath).toEqual(expect.any(String));
  expectAppOnlyMcpConfigPath(member?.mcpConfigPath ?? '');
}

async function expectPathRemovedEventually(targetPath: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!fs.existsSync(targetPath)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(fs.existsSync(targetPath)).toBe(false);
}

function writeCodexTeamWithAppOnlyMeta(teamName: string): void {
  const teamDir = path.join(tempTeamsBase, teamName);
  fs.mkdirSync(teamDir, { recursive: true });
  fs.writeFileSync(
    path.join(teamDir, 'config.json'),
    JSON.stringify({
      name: teamName,
      members: [
        { name: 'team-lead', agentType: 'team-lead', providerId: 'codex' },
        { name: 'alice', agentType: 'teammate', role: 'developer', providerId: 'codex' },
      ],
    }),
    'utf8'
  );
  fs.writeFileSync(
    path.join(teamDir, 'members.meta.json'),
    JSON.stringify({
      version: 1,
      providerBackendId: 'codex-native',
      members: [
        {
          name: 'alice',
          role: 'developer',
          providerId: 'codex',
          model: 'gpt-5.4',
          mcpPolicy: { mode: 'appOnly' },
        },
      ],
    }),
    'utf8'
  );
}

describe('TeamProvisioningService member MCP config safe e2e', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(killTmuxPaneForCurrentPlatformSync).mockReset();
    vi.mocked(listTmuxPaneRuntimeInfoForCurrentPlatform).mockReset();
    vi.mocked(listTmuxPaneRuntimeInfoForCurrentPlatform).mockResolvedValue(new Map());
    vi.mocked(sendKeysToTmuxPaneForCurrentPlatform).mockReset();
    vi.mocked(sendKeysToTmuxPaneForCurrentPlatform).mockResolvedValue(undefined);
    tempClaudeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude team member mcp-'));
    tempTeamsBase = path.join(tempClaudeRoot, 'teams');
    tempTasksBase = path.join(tempClaudeRoot, 'tasks');
    hoisted.paths.claudeRoot = tempClaudeRoot;
    hoisted.paths.teamsBase = tempTeamsBase;
    hoisted.paths.tasksBase = tempTasksBase;
    setAppDataBasePath(tempClaudeRoot);
    fs.mkdirSync(tempTeamsBase, { recursive: true });
    fs.mkdirSync(tempTasksBase, { recursive: true });
  });

  afterEach(() => {
    setAppDataBasePath(null);
    fs.rmSync(tempClaudeRoot, { recursive: true, force: true });
  });

  it('createTeam preserves request Agent Teams MCP only in the real member MCP config', async () => {
    const teamName = 'codex-app-only-create';
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex app-only project-'));
    writeProjectMcpConfig(projectDir);

    vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/fake/codex');
    vi.mocked(spawnCli).mockReturnValue(createFakeChild() as never);

    const svc = new TeamProvisioningService();
    configureLaunchStubs(svc);
    svc.setControlApiBaseUrlResolver(async () => 'http://127.0.0.1:43123');

    let runId: string | undefined;
    try {
      const created = await svc.createTeam(
        {
          teamName,
          cwd: projectDir,
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5.4',
          members: [
            {
              name: 'alice',
              role: 'developer',
              providerId: 'codex',
              model: 'gpt-5.4',
              mcpPolicy: { mode: 'appOnly' },
            },
          ],
        },
        () => {}
      );
      runId = created.runId;

      const member = extractBootstrapSpec().members?.[0];
      expect(member).toEqual(
        expect.objectContaining({
          name: 'alice',
          provider: 'codex',
          model: 'gpt-5.4',
          mcpSettingSources: 'user,project,local',
          strictMcpConfig: true,
        })
      );
      expectAppOnlyMemberMcpConfig(member);

      const memberMcpConfigPath = member?.mcpConfigPath ?? '';
      await svc.cancelProvisioning(runId);
      runId = undefined;
      await expectPathRemovedEventually(memberMcpConfigPath);
    } finally {
      if (runId) {
        await svc.cancelProvisioning(runId);
      }
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('createTeam sends explicit Codex fast mode args without obsolete flex tier', async () => {
    const teamName = 'codex-fast-tier-order-create';
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex fast tier project-'));

    vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/fake/codex');
    vi.mocked(spawnCli).mockReturnValue(createFakeChild() as never);

    const svc = new TeamProvisioningService();
    configureLaunchStubs(svc);
    configureCodexProviderLaunchArgs(svc);
    configureCodexFastLaunchIdentity(svc);
    svc.setControlApiBaseUrlResolver(async () => 'http://127.0.0.1:43123');

    let runId: string | undefined;
    try {
      const created = await svc.createTeam(
        {
          teamName,
          cwd: projectDir,
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5.4',
          effort: 'xhigh',
          fastMode: 'on',
          members: [{ name: 'alice', role: 'developer', providerId: 'codex', model: 'gpt-5.4' }],
        },
        () => {}
      );
      runId = created.runId;

      const launchArgs = vi.mocked(spawnCli).mock.calls[0]?.[1] as string[] | undefined;
      expectExplicitFastModeWithoutFlex(launchArgs);

      await svc.cancelProvisioning(runId);
      runId = undefined;
    } finally {
      if (runId) {
        await svc.cancelProvisioning(runId);
      }
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('launchTeam sends explicit Codex fast mode args without obsolete flex tier', async () => {
    const teamName = 'codex-fast-tier-order-launch';
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex fast tier launch project-'));
    writeCodexTeamWithAppOnlyMeta(teamName);

    vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/fake/codex');
    vi.mocked(spawnCli).mockReturnValue(createFakeChild() as never);

    const svc = new TeamProvisioningService();
    configureLaunchStubs(svc);
    configureCodexProviderLaunchArgs(svc);
    configureCodexFastLaunchIdentity(svc);
    svc.setControlApiBaseUrlResolver(async () => 'http://127.0.0.1:43123');

    let runId: string | undefined;
    try {
      const launched = await svc.launchTeam(
        {
          teamName,
          cwd: projectDir,
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5.4',
          effort: 'xhigh',
          fastMode: 'on',
          clearContext: true,
        },
        () => {}
      );
      runId = launched.runId;

      const launchArgs = vi.mocked(spawnCli).mock.calls[0]?.[1] as string[] | undefined;
      expectExplicitFastModeWithoutFlex(launchArgs);

      await svc.cancelProvisioning(runId);
      runId = undefined;
    } finally {
      if (runId) {
        await svc.cancelProvisioning(runId);
      }
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('launchTeam preserves members.meta Agent Teams MCP only in the real member MCP config', async () => {
    const teamName = 'codex-app-only-meta-launch';
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-app-only-project-'));
    writeCodexTeamWithAppOnlyMeta(teamName);
    writeProjectMcpConfig(projectDir);

    vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/fake/codex');
    vi.mocked(spawnCli).mockReturnValue(createFakeChild() as never);

    const svc = new TeamProvisioningService();
    configureLaunchStubs(svc);
    svc.setControlApiBaseUrlResolver(async () => 'http://127.0.0.1:43123');

    let runId: string | undefined;
    try {
      const launched = await svc.launchTeam(
        {
          teamName,
          cwd: projectDir,
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5.4',
          clearContext: true,
        },
        () => {}
      );
      runId = launched.runId;

      const member = extractBootstrapSpec().members?.[0];
      expect(member).toEqual(
        expect.objectContaining({
          name: 'alice',
          provider: 'codex',
          model: 'gpt-5.4',
          mcpSettingSources: 'user,project,local',
          strictMcpConfig: true,
        })
      );
      expectAppOnlyMemberMcpConfig(member);

      const memberMcpConfigPath = member?.mcpConfigPath ?? '';
      await svc.cancelProvisioning(runId);
      runId = undefined;
      await expectPathRemovedEventually(memberMcpConfigPath);
    } finally {
      if (runId) {
        await svc.cancelProvisioning(runId);
      }
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('live add-member MCP prep writes and discards a real Agent Teams MCP only config', async () => {
    const teamName = 'codex-app-only-live-add';
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex live add project-'));
    writeProjectMcpConfig(projectDir);

    vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/fake/codex');
    vi.mocked(spawnCli).mockReturnValue(createFakeChild() as never);

    const svc = new TeamProvisioningService();
    configureLaunchStubs(svc);
    svc.setControlApiBaseUrlResolver(async () => 'http://127.0.0.1:43123');

    let runId: string | undefined;
    let liveMcpConfigPath = '';
    try {
      const created = await svc.createTeam(
        {
          teamName,
          cwd: projectDir,
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5.4',
          members: [{ name: 'alice', role: 'developer', providerId: 'codex', model: 'gpt-5.4' }],
        },
        () => {}
      );
      runId = created.runId;
      (svc as unknown as { aliveRunByTeam: Map<string, string> }).aliveRunByTeam.set(
        teamName,
        runId
      );

      const liveMcpConfig = await svc.prepareLiveMemberMcpLaunchConfig({
        teamName,
        cwd: projectDir,
        mcpPolicy: { mode: 'appOnly' },
      });

      expect(liveMcpConfig).toEqual(
        expect.objectContaining({
          mcpConfigPath: expect.any(String),
          mcpSettingSources: 'user,project,local',
          strictMcpConfig: true,
        })
      );
      liveMcpConfigPath = liveMcpConfig?.mcpConfigPath ?? '';
      expectAppOnlyMcpConfigPath(liveMcpConfigPath);

      await svc.discardLiveMemberMcpLaunchConfig({
        teamName,
        mcpLaunchConfig: liveMcpConfig,
      });
      await expectPathRemovedEventually(liveMcpConfigPath);

      await svc.cancelProvisioning(runId);
      runId = undefined;
    } finally {
      if (runId) {
        await svc.cancelProvisioning(runId);
      }
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('restartMember direct process preserves Agent Teams MCP only and orders Codex provider args in the real restart args', async () => {
    const teamName = 'codex-app-only-process-restart';
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex restart project-'));
    writeProjectMcpConfig(projectDir);

    vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/fake/codex');
    vi.mocked(spawnCli).mockReturnValue(createFakeChild() as never);

    const svc = new TeamProvisioningService();
    configureLaunchStubs(svc);

    let runId: string | undefined;
    let restartMcpConfigPath = '';
    try {
      const created = await svc.createTeam(
        {
          teamName,
          cwd: projectDir,
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5.4',
          members: [
            {
              name: 'alice',
              role: 'developer',
              providerId: 'codex',
              model: 'gpt-5.4',
              mcpPolicy: { mode: 'appOnly' },
            },
          ],
        },
        () => {}
      );
      runId = created.runId;
      (svc as unknown as { aliveRunByTeam: Map<string, string> }).aliveRunByTeam.set(
        teamName,
        runId
      );

      (svc as unknown as { readConfigForStrictDecision: () => Promise<unknown> }).readConfigForStrictDecision =
        vi.fn(async () => ({
          name: teamName,
          projectPath: projectDir,
          members: [
            { name: 'team-lead', agentType: 'team-lead', providerId: 'codex' },
            {
              name: 'alice',
              role: 'developer',
              providerId: 'codex',
              model: 'gpt-5.4',
              mcpPolicy: { mode: 'appOnly' },
            },
          ],
        }));
      (svc as unknown as { readPersistedRuntimeMembers: () => unknown[] }).readPersistedRuntimeMembers =
        vi.fn(() => [{ name: 'alice', backendType: 'process', cwd: projectDir }]);
      (
        svc as unknown as { getLiveTeamAgentRuntimeMetadata: () => Promise<Map<string, unknown>> }
      ).getLiveTeamAgentRuntimeMetadata = vi.fn(async () => new Map());
      configureExplicitFastRuntimeArgsPlan(svc);
      (
        svc as unknown as { updateDirectTmuxRestartMemberConfig: () => Promise<void> }
      ).updateDirectTmuxRestartMemberConfig = vi.fn(async () => {});
      (svc as unknown as { enqueueDirectRestartPrompt: () => void }).enqueueDirectRestartPrompt =
        vi.fn();

      vi.mocked(spawnCli).mockClear();
      await svc.restartMember(teamName, 'alice');

      const restartArgs = vi.mocked(spawnCli).mock.calls[0]?.[1] as string[] | undefined;
      expect(restartArgs).toEqual(
        expect.arrayContaining([
          '--teammate-runtime',
          'headless',
          '--setting-sources',
          'user,project,local',
          '--strict-mcp-config',
        ])
      );
      expectExplicitFastModeWithoutFlex(restartArgs);
      restartMcpConfigPath = extractMcpConfigPathFromArgs(restartArgs ?? []);
      expectAppOnlyMcpConfigPath(restartMcpConfigPath);

      await svc.cancelProvisioning(runId);
      runId = undefined;
      await expectPathRemovedEventually(restartMcpConfigPath);
    } finally {
      if (runId) {
        await svc.cancelProvisioning(runId);
      }
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('restartMember direct tmux sends explicit Codex fast mode args without obsolete flex tier', async () => {
    const teamName = 'codex-fast-tier-tmux-restart';
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex tmux restart project-'));
    writeProjectMcpConfig(projectDir);

    vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/fake/codex');
    vi.mocked(spawnCli).mockReturnValue(createFakeChild() as never);
    vi.mocked(listTmuxPaneRuntimeInfoForCurrentPlatform).mockResolvedValue(
      new Map([
        [
          '%7',
          {
            paneId: '%7',
            panePid: 777,
            currentCommand: 'zsh',
            currentPath: projectDir,
          },
        ],
      ])
    );

    const svc = new TeamProvisioningService();
    configureLaunchStubs(svc);

    let runId: string | undefined;
    try {
      const created = await svc.createTeam(
        {
          teamName,
          cwd: projectDir,
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5.4',
          members: [
            {
              name: 'alice',
              role: 'developer',
              providerId: 'codex',
              model: 'gpt-5.4',
              mcpPolicy: { mode: 'appOnly' },
            },
          ],
        },
        () => {}
      );
      runId = created.runId;
      (svc as unknown as { aliveRunByTeam: Map<string, string> }).aliveRunByTeam.set(
        teamName,
        runId
      );

      (svc as unknown as { readConfigForStrictDecision: () => Promise<unknown> }).readConfigForStrictDecision =
        vi.fn(async () => ({
          name: teamName,
          projectPath: projectDir,
          members: [
            { name: 'team-lead', agentType: 'team-lead', providerId: 'codex' },
            {
              name: 'alice',
              role: 'developer',
              providerId: 'codex',
              model: 'gpt-5.4',
              mcpPolicy: { mode: 'appOnly' },
            },
          ],
        }));
      (svc as unknown as { readPersistedRuntimeMembers: () => unknown[] }).readPersistedRuntimeMembers =
        vi.fn(() => [
          {
            name: 'alice',
            agentId: 'alice@codex-fast-tier-tmux-restart',
            backendType: 'tmux',
            tmuxPaneId: '%7',
            cwd: projectDir,
          },
        ]);
      (
        svc as unknown as { getLiveTeamAgentRuntimeMetadata: () => Promise<Map<string, unknown>> }
      ).getLiveTeamAgentRuntimeMetadata = vi.fn(async () => new Map());
      configureExplicitFastRuntimeArgsPlan(svc);
      (
        svc as unknown as { updateDirectTmuxRestartMemberConfig: () => Promise<void> }
      ).updateDirectTmuxRestartMemberConfig = vi.fn(async () => {});
      (svc as unknown as { enqueueDirectRestartPrompt: () => void }).enqueueDirectRestartPrompt =
        vi.fn();

      vi.mocked(sendKeysToTmuxPaneForCurrentPlatform).mockClear();
      await svc.restartMember(teamName, 'alice');

      expect(killTmuxPaneForCurrentPlatformSync).not.toHaveBeenCalled();
      expect(sendKeysToTmuxPaneForCurrentPlatform).toHaveBeenCalledTimes(1);
      const [paneId, command] =
        vi.mocked(sendKeysToTmuxPaneForCurrentPlatform).mock.calls[0] ?? [];
      expect(paneId).toBe('%7');
      expect(command).toContain("'--agent-id' 'alice@codex-fast-tier-tmux-restart'");
      expect(command).toContain("'--mcp-config'");
      expectExplicitFastModeWithoutFlexCommand(command);

      await svc.cancelProvisioning(runId);
      runId = undefined;
    } finally {
      if (runId) {
        await svc.cancelProvisioning(runId);
      }
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
