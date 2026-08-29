import { describe, expect, it, vi } from 'vitest';

import {
  stopTeamFlow,
  type TeamProvisioningStopRun,
  type TeamProvisioningStopTeamPorts,
} from '../TeamProvisioningStopFlow';

import type { TeamProvisioningProgress } from '@shared/types';

interface AdapterOnlyRun extends TeamProvisioningStopRun {
  child: null;
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function makePorts(
  teamName: string,
  runId: string
): TeamProvisioningStopTeamPorts<AdapterOnlyRun> & {
  runtimeAdapterRunByTeam: Map<string, { runId: string; providerId: string }>;
  persistStoppedLaunchState: ReturnType<typeof vi.fn>;
  stopOpenCodeRuntimeAdapterTeam: ReturnType<typeof vi.fn>;
} {
  const runtimeAdapterRunByTeam = new Map([[teamName, { runId, providerId: 'opencode' }]]);
  return {
    preflightMetadataMutation: vi.fn(async () => undefined),
    invalidateRuntimeSnapshotCaches: vi.fn(),
    pauseActiveIntervalsForTeam: vi.fn(),
    stopPersistentTeamMembers: vi.fn(() => true),
    openCodeRuntimeDeliveryAdvisory: { cancelTeam: vi.fn() },
    getTrackedRunId: vi.fn(() => null),
    getAliveRunId: vi.fn(() => null),
    runs: new Map(),
    runtimeAdapterProgressByRunId: new Map<string, TeamProvisioningProgress>(),
    isCancellableRuntimeAdapterProgress: vi.fn(() => false),
    cancelRuntimeAdapterProvisioning: vi.fn(),
    cleanupAnthropicApiKeyHelperMaterialForStoppedTeam: vi.fn(),
    runtimeAdapterRunByTeam,
    withTeamLock: vi.fn(async (_lockedTeamName, fn) => fn()),
    stopOpenCodeRuntimeAdapterTeam: vi.fn(async () => false),
    hasSecondaryRuntimeRuns: vi.fn(() => false),
    stopMixedSecondaryRuntimeLanes: vi.fn(),
    provisioningRunByTeam: new Map(),
    deleteAliveRunId: vi.fn(),
    killTeamProcess: vi.fn(),
    killTeamProcessAndWait: vi.fn(),
    updateProgress: vi.fn(),
    persistStoppedLaunchState: vi.fn(async () => undefined),
    cleanupRun: vi.fn(),
    logger: { info: vi.fn() },
  };
}

describe('adapter-only team stop flow', () => {
  it('fails closed and retains map-only ownership when the adapter reports false', async () => {
    const teamName = 'adapter-only-false';
    const runId = 'adapter-run-false';
    const ports = makePorts(teamName, runId);

    await expect(stopTeamFlow(teamName, ports)).rejects.toThrow(
      'Owned runtime cleanup is unconfirmed'
    );

    expect(ports.stopOpenCodeRuntimeAdapterTeam).toHaveBeenCalledWith(teamName, runId);
    expect(ports.runtimeAdapterRunByTeam.get(teamName)).toEqual({
      runId,
      providerId: 'opencode',
    });
    expect(ports.persistStoppedLaunchState).not.toHaveBeenCalled();
    expect(ports.cleanupAnthropicApiKeyHelperMaterialForStoppedTeam).not.toHaveBeenCalled();
  });

  it('preserves a replacement installed during delayed adapter cleanup', async () => {
    const teamName = 'adapter-only-replaced';
    const runId = 'adapter-run-old';
    const replacementRunId = 'adapter-run-new';
    const ports = makePorts(teamName, runId);
    const stopResult = createDeferred<boolean>();
    ports.stopOpenCodeRuntimeAdapterTeam.mockImplementation(async () => stopResult.promise);

    const stopping = stopTeamFlow(teamName, ports);
    await vi.waitFor(() => {
      expect(ports.stopOpenCodeRuntimeAdapterTeam).toHaveBeenCalledWith(teamName, runId);
    });
    ports.runtimeAdapterRunByTeam.set(teamName, {
      runId: replacementRunId,
      providerId: 'opencode',
    });
    stopResult.resolve(false);

    await expect(stopping).rejects.toThrow('Owned runtime cleanup is unconfirmed');
    expect(ports.runtimeAdapterRunByTeam.get(teamName)).toEqual({
      runId: replacementRunId,
      providerId: 'opencode',
    });
    expect(ports.persistStoppedLaunchState).not.toHaveBeenCalled();
  });

  it('persists the exact adapter owner only after confirmed cleanup', async () => {
    const teamName = 'adapter-only-success';
    const runId = 'adapter-run-success';
    const ports = makePorts(teamName, runId);
    ports.stopOpenCodeRuntimeAdapterTeam.mockImplementation(async (stoppedTeam, stoppedRunId) => {
      const current = ports.runtimeAdapterRunByTeam.get(stoppedTeam);
      if (current?.runId !== stoppedRunId) return false;
      ports.runtimeAdapterRunByTeam.delete(stoppedTeam);
      return true;
    });

    await stopTeamFlow(teamName, ports);

    expect(ports.runtimeAdapterRunByTeam.has(teamName)).toBe(false);
    expect(ports.persistStoppedLaunchState).toHaveBeenCalledWith(teamName, runId);
    expect(ports.cleanupAnthropicApiKeyHelperMaterialForStoppedTeam).toHaveBeenCalledWith(teamName);
  });

  it('does not write a stopped tombstone while adapter cleanup is unresolved', async () => {
    const teamName = 'adapter-only-delayed';
    const runId = 'adapter-run-delayed';
    const ports = makePorts(teamName, runId);
    const stopResult = createDeferred<boolean>();
    ports.stopOpenCodeRuntimeAdapterTeam.mockImplementation(async (stoppedTeam) => {
      const stopped = await stopResult.promise;
      if (stopped) ports.runtimeAdapterRunByTeam.delete(stoppedTeam);
      return stopped;
    });

    const stopping = stopTeamFlow(teamName, ports);
    await vi.waitFor(() => {
      expect(ports.stopOpenCodeRuntimeAdapterTeam).toHaveBeenCalledWith(teamName, runId);
    });
    expect(ports.persistStoppedLaunchState).not.toHaveBeenCalled();

    stopResult.resolve(true);
    await stopping;

    expect(ports.persistStoppedLaunchState).toHaveBeenCalledWith(teamName, runId);
  });
});
