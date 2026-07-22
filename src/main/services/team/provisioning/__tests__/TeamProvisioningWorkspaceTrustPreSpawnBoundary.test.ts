import { describe, expect, it, vi } from 'vitest';

import { createTeamProvisioningWorkspaceTrustPreSpawnBoundary } from '../TeamProvisioningWorkspaceTrustPreSpawnBoundary';

import type { AnthropicTeamApiKeyHelperMaterial } from '../../../runtime/anthropicTeamApiKeyHelper';
import type {
  WorkspaceTrustCoordinator,
  WorkspaceTrustExecutionResult,
  WorkspaceTrustFeatureFlags,
  WorkspaceTrustFullPlanResult,
} from '@features/workspace-trust/main';
import type { TeamProvisioningProgress } from '@shared/types';

const featureFlags: WorkspaceTrustFeatureFlags = {
  enabled: true,
  claudePty: true,
  codexArgs: true,
  retry: false,
  fileLock: false,
};

const workspaceTrustPlan: WorkspaceTrustFullPlanResult = {
  providers: ['claude'],
  workspaces: [],
  launchArgPatches: [],
};

function createRun(overrides: Partial<TestRun> = {}): TestRun {
  const progress: TeamProvisioningProgress = {
    runId: 'run-1',
    teamName: 'team-1',
    state: 'validating',
    message: 'Validating launch',
    warnings: [],
    startedAt: '2026-07-09T00:00:00.000Z',
    updatedAt: '2026-07-09T00:00:00.000Z',
  };
  return {
    runId: 'run-1',
    teamName: 'team-1',
    cancelRequested: false,
    processKilled: false,
    anthropicApiKeyHelper: null,
    anthropicApiKeyHelperCleanupPromise: null,
    progress,
    onProgress: vi.fn(),
    ...overrides,
  };
}

interface TestRun {
  runId: string;
  teamName: string;
  cancelRequested: boolean;
  processKilled: boolean;
  anthropicApiKeyHelper: AnthropicTeamApiKeyHelperMaterial | null;
  anthropicApiKeyHelperCleanupPromise: Promise<void> | null;
  progress: TeamProvisioningProgress;
  onProgress(progress: TeamProvisioningProgress): void;
  workspaceTrustPlan?: WorkspaceTrustFullPlanResult | null;
  workspaceTrustExecution?: WorkspaceTrustExecutionResult | null;
  workspaceTrustDiagnostics?: unknown;
}

function createBoundary(input: {
  coordinator: WorkspaceTrustCoordinator;
  cleanupAnthropicApiKeyHelperMaterial?: (input: { directory: string }) => Promise<unknown>;
  restorePrelaunchConfig?: (teamName: string) => Promise<unknown>;
  cleanupRun?: (run: TestRun) => void;
}) {
  return createTeamProvisioningWorkspaceTrustPreSpawnBoundary<
    TestRun,
    { anthropicApiKeyHelper?: { directory: string } | null }
  >({
    getWorkspaceTrustCoordinator: () => input.coordinator,
    getStopAllTeamsGeneration: () => 1,
    updateProgress: (run, state, message, extras) => {
      run.progress = {
        ...run.progress,
        state,
        message,
        ...extras,
        updatedAt: '2026-07-09T00:00:01.000Z',
      };
      return run.progress;
    },
    boundLaunchDiagnostics: (diagnostics) => diagnostics,
    isLaunchRunStillCurrent: () => true,
    isRunStillTracked: () => true,
    cleanupAnthropicApiKeyHelperMaterial:
      input.cleanupAnthropicApiKeyHelperMaterial ?? vi.fn(async () => undefined),
    restorePrelaunchConfig: input.restorePrelaunchConfig ?? vi.fn(async () => undefined),
    cleanupRun: input.cleanupRun ?? vi.fn(),
  });
}

describe('TeamProvisioningWorkspaceTrustPreSpawnBoundary', () => {
  it('fails before spawn through injected cleanup callbacks when workspace trust blocks launch', async () => {
    const run = createRun({
      anthropicApiKeyHelper: {
        teamName: 'team-1',
        directory: '/workspace/.agent-teams-ai-test/anthropic-helper',
        helperPath: '/workspace/.agent-teams-ai-test/anthropic-helper/helper.sh',
        keyPath: '/workspace/.agent-teams-ai-test/anthropic-helper/key',
        settingsPath: '/workspace/.agent-teams-ai-test/anthropic-helper/settings.json',
        settingsObject: {
          apiKeyHelper: '/workspace/.agent-teams-ai-test/anthropic-helper/helper.sh',
        },
        settingsArgs: [
          '--settings',
          '/workspace/.agent-teams-ai-test/anthropic-helper/settings.json',
        ],
        envPatch: {},
      },
    });
    const cleanupAnthropicApiKeyHelperMaterial = vi.fn(async () => undefined);
    const restorePrelaunchConfig = vi.fn(async () => undefined);
    const cleanupRun = vi.fn();
    const boundary = createBoundary({
      cleanupAnthropicApiKeyHelperMaterial,
      restorePrelaunchConfig,
      cleanupRun,
      coordinator: {
        planArgsOnly: vi.fn(),
        planFull: vi.fn(),
        execute: vi.fn(async () => ({
          id: 'workspace-trust',
          provider: 'claude',
          status: 'blocked',
          workspaceIds: [],
          errorMessage: 'Workspace trust required for /repo',
          evidence: ['trust prompt'],
        })),
      } as WorkspaceTrustCoordinator,
    });

    await expect(
      boundary.prepareWorkspaceTrustForDeterministicRun({
        mode: 'launch',
        run,
        claudePath: '/bin/claude',
        shellEnv: {},
        stopAllGenerationAtStart: 1,
        workspaceTrustPlan,
        featureFlags,
        provisioningEnv: {
          anthropicApiKeyHelper: { directory: '/workspace/.agent-teams-ai-test/anthropic-helper' },
        },
      })
    ).rejects.toThrow('Workspace trust required for /repo');

    expect(run.progress).toMatchObject({
      state: 'failed',
      message: 'Workspace trust required',
      error: 'Workspace trust required for /repo',
    });
    expect(cleanupAnthropicApiKeyHelperMaterial).toHaveBeenCalledWith({
      directory: '/workspace/.agent-teams-ai-test/anthropic-helper',
    });
    expect(run.anthropicApiKeyHelper).toBeNull();
    expect(restorePrelaunchConfig).toHaveBeenCalledWith('team-1');
    expect(cleanupRun).toHaveBeenCalledWith(run);
  });

  it('retains the failed launch run when workspace-trust helper cleanup needs retry', async () => {
    const helper = {
      teamName: 'team-1',
      directory: '/workspace/.agent-teams-ai-test/anthropic-helper',
      helperPath: '/workspace/.agent-teams-ai-test/anthropic-helper/helper.sh',
      keyPath: '/workspace/.agent-teams-ai-test/anthropic-helper/key',
      settingsPath: '/workspace/.agent-teams-ai-test/anthropic-helper/settings.json',
      settingsObject: {
        apiKeyHelper: '/workspace/.agent-teams-ai-test/anthropic-helper/helper.sh',
      },
      settingsArgs: [
        '--settings',
        '/workspace/.agent-teams-ai-test/anthropic-helper/settings.json',
      ],
      envPatch: {},
    };
    const run = createRun({ anthropicApiKeyHelper: helper });
    const cleanupError = new Error('helper cleanup failed');
    const restorePrelaunchConfig = vi.fn(async () => undefined);
    const cleanupRun = vi.fn();
    const boundary = createBoundary({
      cleanupAnthropicApiKeyHelperMaterial: vi.fn(async () => {
        throw cleanupError;
      }),
      restorePrelaunchConfig,
      cleanupRun,
      coordinator: {
        planArgsOnly: vi.fn(),
        planFull: vi.fn(),
        execute: vi.fn(async () => ({
          id: 'workspace-trust',
          provider: 'claude',
          status: 'blocked',
          workspaceIds: [],
          errorMessage: 'Workspace trust required for /repo',
          evidence: ['trust prompt'],
        })),
      } as WorkspaceTrustCoordinator,
    });

    await expect(
      boundary.prepareWorkspaceTrustForDeterministicRun({
        mode: 'launch',
        run,
        claudePath: '/bin/claude',
        shellEnv: {},
        stopAllGenerationAtStart: 1,
        workspaceTrustPlan,
        featureFlags,
        provisioningEnv: { anthropicApiKeyHelper: helper },
      })
    ).rejects.toBe(cleanupError);

    expect(run.progress.state).toBe('failed');
    expect(run.anthropicApiKeyHelper).toBe(helper);
    expect(restorePrelaunchConfig).toHaveBeenCalledWith('team-1');
    expect(cleanupRun).not.toHaveBeenCalled();
  });

  it('cancels before spawn through injected cleanup callbacks when workspace trust is cancelled', async () => {
    const run = createRun();
    const cleanupRun = vi.fn();
    const boundary = createBoundary({
      cleanupRun,
      coordinator: {
        planArgsOnly: vi.fn(),
        planFull: vi.fn(),
        execute: vi.fn(async () => ({
          id: 'workspace-trust',
          provider: 'claude',
          status: 'cancelled',
          workspaceIds: [],
          evidence: [],
        })),
      } as WorkspaceTrustCoordinator,
    });

    await expect(
      boundary.prepareWorkspaceTrustForDeterministicRun({
        mode: 'create',
        run,
        claudePath: '/bin/claude',
        shellEnv: {},
        stopAllGenerationAtStart: 1,
        workspaceTrustPlan,
        featureFlags,
        provisioningEnv: {},
      })
    ).rejects.toThrow('Team launch cancelled by app shutdown');

    expect(run.cancelRequested).toBe(true);
    expect(run.progress).toMatchObject({
      state: 'cancelled',
      message: 'Team launch cancelled',
    });
    expect(cleanupRun).toHaveBeenCalledWith(run);
  });

  it('retains the cancelled run when workspace-trust helper cleanup needs retry', async () => {
    const helper = {
      teamName: 'team-1',
      directory: '/workspace/.agent-teams-ai-test/anthropic-helper',
      helperPath: '/workspace/.agent-teams-ai-test/anthropic-helper/helper.sh',
      keyPath: '/workspace/.agent-teams-ai-test/anthropic-helper/key',
      settingsPath: '/workspace/.agent-teams-ai-test/anthropic-helper/settings.json',
      settingsObject: {
        apiKeyHelper: '/workspace/.agent-teams-ai-test/anthropic-helper/helper.sh',
      },
      settingsArgs: [
        '--settings',
        '/workspace/.agent-teams-ai-test/anthropic-helper/settings.json',
      ],
      envPatch: {},
    };
    const run = createRun({ anthropicApiKeyHelper: helper });
    const cleanupError = new Error('helper cleanup failed');
    const cleanupRun = vi.fn();
    const boundary = createBoundary({
      cleanupAnthropicApiKeyHelperMaterial: vi.fn(async () => {
        throw cleanupError;
      }),
      cleanupRun,
      coordinator: {
        planArgsOnly: vi.fn(),
        planFull: vi.fn(),
        execute: vi.fn(async () => ({
          id: 'workspace-trust',
          provider: 'claude',
          status: 'cancelled',
          workspaceIds: [],
          evidence: [],
        })),
      } as WorkspaceTrustCoordinator,
    });

    await expect(
      boundary.prepareWorkspaceTrustForDeterministicRun({
        mode: 'create',
        run,
        claudePath: '/bin/claude',
        shellEnv: {},
        stopAllGenerationAtStart: 1,
        workspaceTrustPlan,
        featureFlags,
        provisioningEnv: { anthropicApiKeyHelper: helper },
      })
    ).rejects.toBe(cleanupError);

    expect(run.progress.state).toBe('cancelled');
    expect(run.anthropicApiKeyHelper).toBe(helper);
    expect(cleanupRun).not.toHaveBeenCalled();
  });
});
