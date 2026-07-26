import { describe, expect, it, vi } from 'vitest';

const deterministicMocks = vi.hoisted(() => ({
  prepareCreateSetup: vi.fn(),
  runCreate: vi.fn(),
}));

vi.mock('../TeamProvisioningCreateDeterministicSetupFlow', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../TeamProvisioningCreateDeterministicSetupFlow')>()),
  prepareDeterministicCreateSetupFlow: deterministicMocks.prepareCreateSetup,
}));

vi.mock('../TeamProvisioningCreateDeterministicRunFlow', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../TeamProvisioningCreateDeterministicRunFlow')>()),
  runDeterministicCreateRunFlow: deterministicMocks.runCreate,
}));

import {
  createAnthropicApiKeyHelperCleanupRetryOwner,
  createAnthropicApiKeyHelperSetupLease,
} from '../TeamProvisioningAnthropicApiKeyHelperLease';
import {
  createTeamInnerWithService,
  launchTeamInnerWithService,
  type TeamProvisioningCreateLaunchOrchestrationServiceHost,
} from '../TeamProvisioningCreateLaunchOrchestration';

import type { TeamCreateRequest, TeamLaunchRequest, TeamProvisioningProgress } from '@shared/types';

const createRequest: TeamCreateRequest = {
  teamName: 'alpha',
  cwd: '/repo',
  providerId: 'opencode',
  model: 'gpt-5',
  effort: 'high',
  fastMode: 'off',
  skipPermissions: false,
  members: [{ name: 'Lead', role: 'Lead', providerId: 'opencode' }],
  prompt: 'start',
};

const launchRequest: TeamLaunchRequest = {
  teamName: 'alpha',
  cwd: '/repo',
  providerId: 'opencode',
  model: 'gpt-5',
  effort: 'high',
  fastMode: 'off',
  skipPermissions: false,
};

function unexpected(): never {
  throw new Error('unexpected deterministic flow call');
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function createHost(
  overrides: Partial<TeamProvisioningCreateLaunchOrchestrationServiceHost> = {}
): TeamProvisioningCreateLaunchOrchestrationServiceHost {
  return {
    cleanedStoppedTeamOpenCodeRuntimeLanes: new Set(['alpha']),
    runTracking: {
      getResolvableProvisioningRunId: vi.fn(() => null),
    },
    configTaskActivityBoundary: {
      readTaskActivityRepairLaunchSnapshot: vi.fn(async () => null),
      repairStaleTaskActivityIntervalsOnce: vi.fn(),
    },
    initializeToolApprovalSettingsForLaunch: vi.fn(),
    stopAllTeamsGeneration: 7,
    provisioningRunByTeam: new Map(),
    shouldRouteOpenCodeToRuntimeAdapter: vi.fn(() => true),
    createOpenCodeTeamThroughRuntimeAdapter: vi.fn(async () => ({
      runId: 'opencode-create-run',
    })),
    launchOpenCodeTeamThroughRuntimeAdapter: vi.fn(async () => ({
      runId: 'opencode-launch-run',
    })),
    createDeterministicCreateSetupFlowPorts: vi.fn(unexpected),
    createDeterministicCreateRunFlowPorts: vi.fn(unexpected),
    createDeterministicCreateSpawnFlowPorts: vi.fn(unexpected),
    deterministicLaunchFlowBoundary: {
      createSetupPorts: vi.fn(unexpected),
      createRunFlowPorts: vi.fn(unexpected),
    },
    ...overrides,
    anthropicApiKeyHelperCleanupRetryOwner:
      overrides.anthropicApiKeyHelperCleanupRetryOwner ??
      createAnthropicApiKeyHelperCleanupRetryOwner(),
  };
}

describe('TeamProvisioningCreateLaunchOrchestration', () => {
  it('returns an in-flight create run before preparing launch state when no cleanup is pending', async () => {
    const host = createHost({
      runTracking: {
        getResolvableProvisioningRunId: vi.fn(() => 'run-active'),
      },
    });
    const onProgress = vi.fn<(progress: TeamProvisioningProgress) => void>();

    await expect(createTeamInnerWithService(host, createRequest, onProgress)).resolves.toEqual({
      runId: 'run-active',
      launchStatus: 'already_launching',
      alreadyLaunching: true,
    });

    expect(host.cleanedStoppedTeamOpenCodeRuntimeLanes.has('alpha')).toBe(false);
    expect(
      host.configTaskActivityBoundary.readTaskActivityRepairLaunchSnapshot
    ).not.toHaveBeenCalled();
    expect(host.shouldRouteOpenCodeToRuntimeAdapter).not.toHaveBeenCalled();
    expect(host.initializeToolApprovalSettingsForLaunch).toHaveBeenCalledWith('alpha', false);
  });

  it.each([
    {
      name: 'create',
      invoke: (host: TeamProvisioningCreateLaunchOrchestrationServiceHost) =>
        createTeamInnerWithService(host, { ...createRequest, teamName: 'beta' }, vi.fn()),
    },
    {
      name: 'launch',
      invoke: (host: TeamProvisioningCreateLaunchOrchestrationServiceHost) =>
        launchTeamInnerWithService(host, { ...launchRequest, teamName: 'beta' }, vi.fn()),
    },
  ])(
    'does not let exhausted cleanup for team A block production team B $name admission',
    async ({ invoke }) => {
      vi.useFakeTimers();
      const cleanupMaterial = vi
        .fn<(input: { directory: string }) => Promise<void>>()
        .mockRejectedValue(new Error('team A cleanup remains busy'));
      const lease = createAnthropicApiKeyHelperSetupLease(cleanupMaterial);
      lease.coalesce({
        teamName: 'team-a',
        directory: '/test-artifacts/team-a/exhausted-helper',
        helperPath: '/test-artifacts/team-a/exhausted-helper/helper.sh',
        keyPath: '/test-artifacts/team-a/exhausted-helper/key',
        settingsPath: '/test-artifacts/team-a/exhausted-helper/settings.json',
        settingsObject: {
          apiKeyHelper: '/test-artifacts/team-a/exhausted-helper/helper.sh',
        },
        settingsArgs: ['--settings', '/test-artifacts/team-a/exhausted-helper/settings.json'],
        envPatch: {},
      });
      const retryOwner = createAnthropicApiKeyHelperCleanupRetryOwner({
        maxPendingOwners: 1,
        retryDelaysMs: [10],
      });
      try {
        await expect(lease.cleanup()).rejects.toThrow('team A cleanup remains busy');
        await retryOwner.retainSetupLease(lease);
        await vi.advanceTimersByTimeAsync(10);
        expect(cleanupMaterial).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);

        const host = createHost({
          anthropicApiKeyHelperCleanupRetryOwner: retryOwner,
          runTracking: {
            getResolvableProvisioningRunId: vi.fn(() => 'run-active'),
          },
        });

        await expect(invoke(host)).resolves.toMatchObject({
          runId: 'run-active',
          launchStatus: 'already_launching',
        });

        expect(cleanupMaterial).toHaveBeenCalledTimes(2);
        expect(retryOwner.getPendingOwnerCount()).toBe(1);
        expect(retryOwner.hasPendingForTeam('team-a')).toBe(true);
        expect(retryOwner.hasPendingForTeam('beta')).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it('routes create requests to the OpenCode runtime adapter after stale activity repair', async () => {
    const host = createHost();
    const onProgress = vi.fn<(progress: TeamProvisioningProgress) => void>();

    await expect(createTeamInnerWithService(host, createRequest, onProgress)).resolves.toEqual({
      runId: 'opencode-create-run',
    });

    expect(
      host.configTaskActivityBoundary.readTaskActivityRepairLaunchSnapshot
    ).toHaveBeenCalledWith('alpha');
    expect(
      host.configTaskActivityBoundary.repairStaleTaskActivityIntervalsOnce
    ).toHaveBeenCalledWith('alpha', null);
    expect(host.initializeToolApprovalSettingsForLaunch).toHaveBeenCalledWith('alpha', false);
    expect(
      vi.mocked(host.initializeToolApprovalSettingsForLaunch).mock.invocationCallOrder[0]
    ).toBeLessThan(vi.mocked(host.shouldRouteOpenCodeToRuntimeAdapter).mock.invocationCallOrder[0]);
    expect(host.shouldRouteOpenCodeToRuntimeAdapter).toHaveBeenCalledWith(createRequest);
    expect(host.createOpenCodeTeamThroughRuntimeAdapter).toHaveBeenCalledWith(
      createRequest,
      onProgress
    );
    expect(host.provisioningRunByTeam.has('alpha')).toBe(false);
  });

  it('retries an explicitly retained setup owner before production orchestration continues', async () => {
    const cleanupMaterial = vi
      .fn<(input: { directory: string }) => Promise<void>>()
      .mockRejectedValueOnce(new Error('cleanup busy'))
      .mockResolvedValueOnce(undefined);
    const lease = createAnthropicApiKeyHelperSetupLease(cleanupMaterial);
    lease.coalesce({
      teamName: 'alpha',
      directory: '/test-artifacts/alpha/helper',
      helperPath: '/test-artifacts/alpha/helper/helper.sh',
      keyPath: '/test-artifacts/alpha/helper/key',
      settingsPath: '/test-artifacts/alpha/helper/settings.json',
      settingsObject: { apiKeyHelper: '/test-artifacts/alpha/helper/helper.sh' },
      settingsArgs: ['--settings', '/test-artifacts/alpha/helper/settings.json'],
      envPatch: {},
    });
    const retryOwner = createAnthropicApiKeyHelperCleanupRetryOwner();
    await expect(lease.cleanup()).rejects.toThrow('cleanup busy');
    await retryOwner.retainSetupLease(lease);
    const host = createHost({ anthropicApiKeyHelperCleanupRetryOwner: retryOwner });

    await createTeamInnerWithService(host, createRequest, vi.fn());

    expect(cleanupMaterial).toHaveBeenCalledTimes(2);
    expect(retryOwner.getPendingOwnerCount()).toBe(0);
    expect(host.createOpenCodeTeamThroughRuntimeAdapter).toHaveBeenCalledOnce();
  });

  it('retains the setup lease when orchestration cleanup fails', async () => {
    const cleanupMaterial = vi
      .fn<(input: { directory: string }) => Promise<void>>()
      .mockRejectedValueOnce(new Error('cleanup busy'))
      .mockResolvedValueOnce(undefined);
    const lease = createAnthropicApiKeyHelperSetupLease(cleanupMaterial);
    lease.coalesce({
      teamName: 'alpha',
      directory: '/test-artifacts/alpha/orchestration-helper',
      helperPath: '/test-artifacts/alpha/orchestration-helper/helper.sh',
      keyPath: '/test-artifacts/alpha/orchestration-helper/key',
      settingsPath: '/test-artifacts/alpha/orchestration-helper/settings.json',
      settingsObject: {
        apiKeyHelper: '/test-artifacts/alpha/orchestration-helper/helper.sh',
      },
      settingsArgs: ['--settings', '/test-artifacts/alpha/orchestration-helper/settings.json'],
      envPatch: {},
    });
    deterministicMocks.prepareCreateSetup.mockResolvedValueOnce({
      anthropicApiKeyHelperLease: lease,
      claudePath: '/bin/claude',
      shellEnv: {},
    });
    deterministicMocks.runCreate.mockRejectedValueOnce(new Error('run setup failed'));
    const retryOwner = createAnthropicApiKeyHelperCleanupRetryOwner();
    const host = createHost({
      anthropicApiKeyHelperCleanupRetryOwner: retryOwner,
      shouldRouteOpenCodeToRuntimeAdapter: vi.fn(() => false),
      createDeterministicCreateSetupFlowPorts: vi.fn(() => ({}) as never),
      createDeterministicCreateRunFlowPorts: vi.fn(() => ({}) as never),
      createDeterministicCreateSpawnFlowPorts: vi.fn(() => ({}) as never),
    });

    await expect(
      createTeamInnerWithService(
        {
          ...host,
          shouldRouteOpenCodeToRuntimeAdapter: vi.fn(() => false),
        },
        {
          ...createRequest,
          providerId: 'codex',
          members: [{ name: 'Lead', role: 'Lead', providerId: 'codex' }],
        },
        vi.fn()
      )
    ).rejects.toThrow('run setup failed');

    expect(retryOwner.getPendingOwnerCount()).toBe(1);
    await retryOwner.retryPendingForTeam('alpha');
    expect(cleanupMaterial).toHaveBeenCalledTimes(2);
    expect(retryOwner.getPendingOwnerCount()).toBe(0);
  });

  it('cancels create when stop-all occurs during the launch snapshot preflight', async () => {
    const snapshotRead = deferred<null>();
    const host = createHost({
      configTaskActivityBoundary: {
        readTaskActivityRepairLaunchSnapshot: vi.fn(() => snapshotRead.promise),
        repairStaleTaskActivityIntervalsOnce: vi.fn(),
      },
    });
    const onProgress = vi.fn<(progress: TeamProvisioningProgress) => void>();

    const create = createTeamInnerWithService(host, createRequest, onProgress);
    await vi.waitFor(() => {
      expect(
        host.configTaskActivityBoundary.readTaskActivityRepairLaunchSnapshot
      ).toHaveBeenCalledWith('alpha');
    });

    host.stopAllTeamsGeneration += 1;
    snapshotRead.resolve(null);

    await expect(create).rejects.toThrow('Team launch cancelled by app shutdown');
    expect(
      host.configTaskActivityBoundary.repairStaleTaskActivityIntervalsOnce
    ).not.toHaveBeenCalled();
    expect(host.shouldRouteOpenCodeToRuntimeAdapter).not.toHaveBeenCalled();
    expect(host.createOpenCodeTeamThroughRuntimeAdapter).not.toHaveBeenCalled();
    expect(host.initializeToolApprovalSettingsForLaunch).not.toHaveBeenCalled();
    expect(host.provisioningRunByTeam.has('alpha')).toBe(false);
  });

  it('returns an in-flight launch run before selecting a runtime path', async () => {
    const host = createHost({
      runTracking: {
        getResolvableProvisioningRunId: vi.fn(() => 'run-active'),
      },
    });
    const onProgress = vi.fn<(progress: TeamProvisioningProgress) => void>();

    await expect(launchTeamInnerWithService(host, launchRequest, onProgress)).resolves.toEqual({
      runId: 'run-active',
      launchStatus: 'already_launching',
      alreadyLaunching: true,
    });

    expect(host.shouldRouteOpenCodeToRuntimeAdapter).not.toHaveBeenCalled();
    expect(host.launchOpenCodeTeamThroughRuntimeAdapter).not.toHaveBeenCalled();
    expect(host.initializeToolApprovalSettingsForLaunch).toHaveBeenCalledWith('alpha', false);
  });

  it('routes launch requests to the OpenCode runtime adapter without creating a pending legacy run', async () => {
    const host = createHost();
    const onProgress = vi.fn<(progress: TeamProvisioningProgress) => void>();

    await expect(launchTeamInnerWithService(host, launchRequest, onProgress)).resolves.toEqual({
      runId: 'opencode-launch-run',
    });

    expect(host.shouldRouteOpenCodeToRuntimeAdapter).toHaveBeenCalledWith(launchRequest);
    expect(host.initializeToolApprovalSettingsForLaunch).toHaveBeenCalledWith('alpha', false);
    expect(
      vi.mocked(host.initializeToolApprovalSettingsForLaunch).mock.invocationCallOrder[0]
    ).toBeLessThan(vi.mocked(host.shouldRouteOpenCodeToRuntimeAdapter).mock.invocationCallOrder[0]);
    expect(host.launchOpenCodeTeamThroughRuntimeAdapter).toHaveBeenCalledWith(
      launchRequest,
      onProgress
    );
    expect(host.provisioningRunByTeam.has('alpha')).toBe(false);
  });
});
