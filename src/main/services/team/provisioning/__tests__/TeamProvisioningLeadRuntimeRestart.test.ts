import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { resolveExistingLaunchRunReuse } from '../TeamProvisioningLaunchTeamFlow';
import {
  applyLeadRuntimeSettingsToTeamMeta,
  assessLeadRuntimeRestart,
  buildLeadRuntimeResumeArgs,
  type LeadRuntimeRestartPorts,
  restartLeadRuntime,
} from '../TeamProvisioningLeadRuntimeRestart';
import { TeamProvisioningRuntimeStateProjection } from '../TeamProvisioningRuntimeStateProjection';

import type { TeamMetaFile } from '../../TeamMetaStore';
import type { ProvisioningRun } from '../TeamProvisioningRunModel';
import type { ProviderModelLaunchIdentity } from '@shared/types';
import type { ChildProcess } from 'node:child_process';

function child(pid: number | null): ChildProcess {
  return Object.assign(new EventEmitter(), {
    pid,
    stdin: { writable: true },
    stdout: Object.assign(new EventEmitter(), {}),
    stderr: Object.assign(new EventEmitter(), {}),
  }) as unknown as ChildProcess;
}

function run(overrides: Partial<ProvisioningRun> = {}): ProvisioningRun {
  return {
    runId: 'run-1',
    teamName: 'alpha',
    request: { providerId: 'anthropic', model: 'old-model', effort: 'low' },
    child: child(100),
    spawnContext: {
      claudePath: '/bin/claude',
      args: [
        '--print',
        '--team-bootstrap-spec',
        '/sandbox/bootstrap.json',
        '--team-bootstrap-user-prompt-file',
        '/sandbox/prompt.txt',
        '--mcp-config',
        '/sandbox/mcp.json',
        '--model',
        'old-model',
        '--effort',
        'low',
      ],
      cwd: '/sandbox/team',
      env: { TEST_RUNTIME: '1' },
      prompt: '',
    },
    detectedSessionId: 'session-1',
    provisioningComplete: true,
    processClosed: false,
    processKilled: false,
    cancelRequested: false,
    leadActivityState: 'idle',
    activeToolCalls: new Map(),
    pendingApprovals: new Map(),
    authRetryInProgress: false,
    launchIdentity: null,
    mixedSecondaryLanes: [],
    ...overrides,
  } as unknown as ProvisioningRun;
}

function ports(targetRun: ProvisioningRun, replacements: ChildProcess[]) {
  const handleProcessExit = vi.fn(async () => undefined);
  return {
    spawn: vi.fn(() => replacements.shift()!),
    killAndWait: vi.fn(async () => undefined),
    attachStdout: vi.fn(),
    attachStderr: vi.fn(),
    startStallWatchdog: vi.fn(),
    stopStallWatchdog: vi.fn(),
    handleProcessExit,
    getAliveRunId: vi.fn((): string | null => targetRun.runId),
    getRun: vi.fn((runId: string) => (runId === targetRun.runId ? targetRun : undefined)),
    syncPersistedMetadata: vi.fn(
      async (_input: Parameters<LeadRuntimeRestartPorts['syncPersistedMetadata']>[0]) => undefined
    ),
    stopPersistentTeamMembers: vi.fn(() => true),
    hasSecondaryRuntimeRuns: vi.fn(() => targetRun.mixedSecondaryLanes.length > 0),
    stopMixedSecondaryRuntimeLanes: vi.fn(async () => undefined),
    invalidateRuntimeSnapshot: vi.fn(),
  };
}

const before = { providerId: 'anthropic' as const, model: 'old-model', effort: 'low' as const };
const after = { providerId: 'anthropic' as const, model: 'new-model', effort: 'high' as const };

function codexLaunchIdentity(
  overrides: Partial<ProviderModelLaunchIdentity> = {}
): ProviderModelLaunchIdentity {
  return {
    providerId: 'codex',
    providerBackendId: 'codex-native',
    selectedModel: null,
    selectedModelKind: 'default',
    resolvedLaunchModel: 'gpt-default',
    catalogId: 'gpt-default',
    catalogSource: 'runtime',
    catalogFetchedAt: null,
    selectedEffort: null,
    resolvedEffort: 'high',
    selectedFastMode: null,
    resolvedFastMode: null,
    ...overrides,
  };
}

describe('lead runtime restart', () => {
  it('builds a resume command without deterministic bootstrap replay', () => {
    expect(
      buildLeadRuntimeResumeArgs({
        previousArgs: run().spawnContext!.args,
        sessionId: 'session-1',
        model: 'new-model',
        effort: 'high',
      })
    ).toEqual([
      '--print',
      '--mcp-config',
      '/sandbox/mcp.json',
      '--resume',
      'session-1',
      '--model',
      'new-model',
      '--effort',
      'high',
    ]);
  });

  it('strips owned value flags in combined equals form', () => {
    expect(
      buildLeadRuntimeResumeArgs({
        previousArgs: [
          '--print',
          '--team-bootstrap-spec=/sandbox/old.json',
          '--team-bootstrap-user-prompt-file=/sandbox/old.txt',
          '--model=old-model',
          '--effort=low',
          '--resume=old-session',
          '--session-id=old-id',
          '--mcp-config=/sandbox/mcp.json',
        ],
        sessionId: 'session-1',
        model: 'new-model',
        effort: 'high',
      })
    ).toEqual([
      '--print',
      '--mcp-config=/sandbox/mcp.json',
      '--resume',
      'session-1',
      '--model',
      'new-model',
      '--effort',
      'high',
    ]);
  });

  it('synchronizes card fields and launch identity without changing provider metadata', () => {
    const meta = applyLeadRuntimeSettingsToTeamMeta(
      {
        version: 1,
        cwd: '/sandbox/team',
        providerId: 'anthropic',
        providerBackendId: 'cli-sdk',
        model: 'old-model',
        effort: 'high',
        createdAt: 1,
        launchIdentity: {
          providerId: 'anthropic',
          providerBackendId: 'cli-sdk',
          billingMode: 'subscription',
          selectedModel: 'old-model',
          selectedModelKind: 'explicit',
          resolvedLaunchModel: 'old-model',
          catalogId: 'old-model',
          catalogSource: 'runtime',
          catalogFetchedAt: '2026-08-21T00:00:00.000Z',
          selectedEffort: 'high',
          resolvedEffort: 'high',
          selectedFastMode: 'inherit',
          resolvedFastMode: false,
        },
      },
      { providerId: 'anthropic', model: 'new-model', effort: 'medium' },
      null
    );

    expect(meta).toMatchObject({
      providerId: 'anthropic',
      providerBackendId: 'cli-sdk',
      model: 'new-model',
      effort: 'medium',
      createdAt: 1,
      launchIdentity: {
        providerId: 'anthropic',
        billingMode: 'subscription',
        selectedModel: 'new-model',
        selectedModelKind: 'explicit',
        resolvedLaunchModel: 'new-model',
        catalogId: 'new-model',
        selectedEffort: 'medium',
        resolvedEffort: 'medium',
        selectedFastMode: 'inherit',
        resolvedFastMode: false,
      },
    });
  });

  it('preserves a resolved default model identity during an effort-only update', () => {
    const meta = applyLeadRuntimeSettingsToTeamMeta(
      {
        version: 1,
        cwd: '/sandbox/team',
        providerId: 'codex',
        model: undefined,
        effort: 'high',
        createdAt: 1,
        launchIdentity: {
          providerId: 'codex',
          providerBackendId: 'codex-native',
          selectedModel: null,
          selectedModelKind: 'default',
          resolvedLaunchModel: 'gpt-default',
          catalogId: 'gpt-default',
          catalogSource: 'runtime',
          catalogFetchedAt: null,
          selectedEffort: 'high',
          resolvedEffort: 'high',
          selectedFastMode: null,
          resolvedFastMode: null,
        },
      },
      { providerId: 'codex', model: null, effort: 'medium' },
      null
    );

    expect(meta.model).toBeUndefined();
    expect(meta.launchIdentity).toMatchObject({
      selectedModel: null,
      selectedModelKind: 'default',
      resolvedLaunchModel: 'gpt-default',
      catalogId: 'gpt-default',
      selectedEffort: 'medium',
      resolvedEffort: 'medium',
    });
  });

  it('preserves a resolved default effort during a model-only update', () => {
    const meta = applyLeadRuntimeSettingsToTeamMeta(
      {
        version: 1,
        cwd: '/sandbox/team',
        providerId: 'codex',
        createdAt: 1,
        launchIdentity: codexLaunchIdentity(),
      },
      { providerId: 'codex', model: 'gpt-explicit', effort: null },
      null
    );

    expect(meta.launchIdentity).toMatchObject({
      selectedModel: 'gpt-explicit',
      selectedModelKind: 'explicit',
      resolvedLaunchModel: 'gpt-explicit',
      selectedEffort: null,
      resolvedEffort: 'high',
    });
  });

  it('clears an explicit resolved effort when the selection changes to default', () => {
    const meta = applyLeadRuntimeSettingsToTeamMeta(
      {
        version: 1,
        cwd: '/sandbox/team',
        providerId: 'codex',
        createdAt: 1,
        launchIdentity: codexLaunchIdentity({
          selectedModel: 'gpt-explicit',
          selectedModelKind: 'explicit',
          resolvedLaunchModel: 'gpt-explicit',
          catalogId: 'gpt-explicit',
          selectedEffort: 'high',
          resolvedEffort: 'high',
        }),
      },
      { providerId: 'codex', model: 'gpt-explicit', effort: null },
      null
    );

    expect(meta.launchIdentity).toMatchObject({
      selectedEffort: null,
      resolvedEffort: null,
    });
  });

  it('uses the original fallback identity when restoring metadata after a failed restart', () => {
    const originalIdentity = codexLaunchIdentity();
    const meta = applyLeadRuntimeSettingsToTeamMeta(
      {
        version: 1,
        cwd: '/sandbox/team',
        providerId: 'codex',
        model: 'gpt-rejected',
        createdAt: 1,
        launchIdentity: {
          ...originalIdentity,
          selectedModel: 'gpt-rejected',
          selectedModelKind: 'explicit',
          resolvedLaunchModel: 'gpt-rejected',
          catalogId: 'gpt-rejected',
        },
      },
      { providerId: 'codex', model: null, effort: null },
      originalIdentity
    );

    expect(meta.model).toBeUndefined();
    expect(meta.launchIdentity).toMatchObject({
      selectedModel: null,
      selectedModelKind: 'default',
      resolvedLaunchModel: 'gpt-default',
      catalogId: 'gpt-default',
      selectedEffort: null,
      resolvedEffort: 'high',
    });
  });

  it('restores the original default launch identity after a post-sync replacement failure', async () => {
    const originalIdentity = codexLaunchIdentity();
    const targetRun = run({
      request: { providerId: 'codex' } as ProvisioningRun['request'],
      launchIdentity: originalIdentity,
    });
    const replacement = child(200);
    const rollback = child(300);
    const testPorts = ports(targetRun, [replacement, rollback]);
    let meta: TeamMetaFile = {
      version: 1,
      cwd: '/sandbox/team',
      providerId: 'codex',
      createdAt: 1,
      launchIdentity: originalIdentity,
    };
    let syncCount = 0;
    testPorts.syncPersistedMetadata.mockImplementation(async (input) => {
      meta = {
        version: 1,
        ...applyLeadRuntimeSettingsToTeamMeta(meta, input.settings, input.launchIdentity),
      };
      syncCount += 1;
      if (syncCount === 1) replacement.emit('exit', 1, null);
    });

    await expect(
      restartLeadRuntime(
        {
          teamName: 'alpha',
          expectedRunId: 'run-1',
          before: { providerId: 'codex', model: null, effort: null },
          after: { providerId: 'codex', model: 'gpt-rejected', effort: null },
        },
        testPorts
      )
    ).rejects.toMatchObject({ lifecycleRestored: true });

    expect(testPorts.syncPersistedMetadata).toHaveBeenCalledTimes(2);
    expect(meta.model).toBeUndefined();
    expect(meta.launchIdentity).toMatchObject({
      selectedModel: null,
      selectedModelKind: 'default',
      resolvedLaunchModel: 'gpt-default',
      catalogId: 'gpt-default',
      selectedEffort: null,
      resolvedEffort: 'high',
    });
  });

  it('does not retain an explicit model identity when switching to default', () => {
    const meta = applyLeadRuntimeSettingsToTeamMeta(
      {
        version: 1,
        cwd: '/sandbox/team',
        providerId: 'codex',
        model: 'gpt-explicit',
        createdAt: 1,
        launchIdentity: {
          providerId: 'codex',
          providerBackendId: 'codex-native',
          selectedModel: 'gpt-explicit',
          selectedModelKind: 'explicit',
          resolvedLaunchModel: 'gpt-explicit',
          catalogId: 'gpt-explicit',
          catalogSource: 'runtime',
          catalogFetchedAt: null,
          selectedEffort: 'high',
          resolvedEffort: 'high',
          selectedFastMode: null,
          resolvedFastMode: null,
        },
      },
      { providerId: 'codex', model: null, effort: 'medium' },
      null
    );

    expect(meta.launchIdentity).toMatchObject({
      selectedModel: null,
      selectedModelKind: 'default',
      resolvedLaunchModel: null,
      catalogId: null,
    });
  });

  it.each(['anthropic', 'codex', 'gemini'] as const)(
    'admits an idle exact-owner %s lead',
    (providerId) => {
      const targetRun = run({ request: { providerId } as ProvisioningRun['request'] });
      const result = assessLeadRuntimeRestart(
        'alpha',
        { providerId, model: null, effort: null },
        {
          getAliveRunId: () => targetRun.runId,
          getRun: () => targetRun,
        }
      );
      expect(result).toEqual({ outcome: 'ready', runId: 'run-1' });
    }
  );

  it('fails closed for OpenCode, active work, and stale ownership', () => {
    const targetRun = run();
    const basePorts = { getAliveRunId: () => targetRun.runId, getRun: () => targetRun };
    expect(
      assessLeadRuntimeRestart(
        'alpha',
        { providerId: 'opencode', model: null, effort: null },
        basePorts
      ).outcome
    ).toBe('relaunch_required');
    targetRun.leadActivityState = 'active';
    expect(assessLeadRuntimeRestart('alpha', after, basePorts).outcome).toBe('busy');
    expect(
      assessLeadRuntimeRestart('alpha', after, {
        getAliveRunId: () => 'run-2',
        getRun: () => undefined,
      }).outcome
    ).toBe('relaunch_required');
  });

  it('swaps only the root child and ignores a late old-child close', async () => {
    const targetRun = run({
      launchIdentity: {
        providerId: 'anthropic',
        providerBackendId: 'cli-sdk',
        selectedModel: 'old-model',
        selectedModelKind: 'explicit',
        resolvedLaunchModel: 'old-model',
        catalogId: 'old-model',
        catalogSource: 'runtime',
        catalogFetchedAt: null,
        selectedEffort: 'low',
        resolvedEffort: 'low',
      },
      mixedSecondaryLanes: [{ laneId: 'opencode-secondary' }] as never,
    });
    const oldChild = targetRun.child!;
    const replacement = child(200);
    const testPorts = ports(targetRun, [replacement]);

    await restartLeadRuntime(
      { teamName: 'alpha', expectedRunId: 'run-1', before, after },
      testPorts
    );

    expect(testPorts.killAndWait).toHaveBeenCalledOnce();
    expect(testPorts.killAndWait).toHaveBeenCalledWith(oldChild);
    expect(targetRun.child).toBe(replacement);
    expect(targetRun.mixedSecondaryLanes).toHaveLength(1);
    expect((testPorts.spawn.mock.calls as unknown[][])[0]?.[1]).not.toContain(
      '--team-bootstrap-spec'
    );
    expect(testPorts.syncPersistedMetadata).toHaveBeenCalledWith({
      teamName: 'alpha',
      settings: after,
      launchIdentity: expect.objectContaining({ selectedEffort: 'low' }),
    });
    expect(targetRun.request).toMatchObject({ model: 'new-model', effort: 'high' });
    expect(targetRun.launchIdentity).toMatchObject({
      selectedModel: 'new-model',
      resolvedLaunchModel: 'new-model',
      selectedEffort: 'high',
      resolvedEffort: 'high',
      catalogId: 'new-model',
    });
    oldChild.emit('close', 0);
    expect(testPorts.handleProcessExit).not.toHaveBeenCalled();
  });

  it('does not mutate the runtime when the admitted run id changed', async () => {
    const targetRun = run();
    const oldChild = targetRun.child;
    const testPorts = ports(targetRun, []);

    await expect(
      restartLeadRuntime(
        { teamName: 'alpha', expectedRunId: 'superseded-run', before, after },
        testPorts
      )
    ).rejects.toMatchObject({ lifecycleRestored: true });
    expect(testPorts.killAndWait).not.toHaveBeenCalled();
    expect(testPorts.spawn).not.toHaveBeenCalled();
    expect(targetRun.child).toBe(oldChild);
  });

  it('does not spawn a replacement when stop cancels the run during termination', async () => {
    const targetRun = run();
    const testPorts = ports(targetRun, [child(200)]);
    let releaseTermination!: () => void;
    testPorts.killAndWait.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          releaseTermination = () => resolve(undefined);
        })
    );

    const restart = restartLeadRuntime(
      { teamName: 'alpha', expectedRunId: 'run-1', before, after },
      testPorts
    );
    await vi.waitFor(() => expect(testPorts.killAndWait).toHaveBeenCalledOnce());
    targetRun.cancelRequested = true;
    targetRun.processKilled = true;
    releaseTermination();

    await expect(restart).rejects.toMatchObject({ lifecycleRestored: true });
    expect(testPorts.spawn).not.toHaveBeenCalled();
    expect(testPorts.syncPersistedMetadata).not.toHaveBeenCalled();
  });

  it('reports replacement termination exactly once across error and close', async () => {
    const targetRun = run();
    const replacement = child(200);
    const testPorts = ports(targetRun, [replacement]);

    await restartLeadRuntime(
      { teamName: 'alpha', expectedRunId: 'run-1', before, after },
      testPorts
    );
    replacement.emit('error', new Error('runtime failed'));
    replacement.emit('close', 1);
    await Promise.resolve();

    expect(testPorts.handleProcessExit).toHaveBeenCalledOnce();
  });

  it('retains a still-running previous process as degraded when termination is unconfirmed', async () => {
    const targetRun = run();
    const previousChild = targetRun.child;
    const testPorts = ports(targetRun, []);
    testPorts.killAndWait.mockRejectedValueOnce(new Error('kill timed out'));

    await expect(
      restartLeadRuntime({ teamName: 'alpha', expectedRunId: 'run-1', before, after }, testPorts)
    ).rejects.toMatchObject({ lifecycleRestored: false });
    expect(testPorts.attachStdout).toHaveBeenCalledWith(targetRun);
    expect(testPorts.attachStderr).toHaveBeenCalledWith(targetRun);
    expect(targetRun.child).toBe(previousChild);
    expect(targetRun.processKilled).toBe(false);
    expect(targetRun.processClosed).toBe(true);
    expect(targetRun.leadActivityState).toBe('offline');
    expect(testPorts.spawn).not.toHaveBeenCalled();
    expect(
      resolveExistingLaunchRunReuse({
        teamName: 'alpha',
        cwd: '/sandbox/team',
        existingAliveRunId: 'run-1',
        existingRun: targetRun,
        existingRunCwd: '/sandbox/team',
        configProjectPath: null,
      })
    ).toMatchObject({ kind: 'blocked' });
  });

  it('retains an exited previous process as degraded when tree termination is unconfirmed', async () => {
    const targetRun = run();
    const previousChild = targetRun.child!;
    const testPorts = ports(targetRun, []);
    let rejectTermination!: (error: Error) => void;
    testPorts.killAndWait.mockImplementationOnce(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectTermination = reject;
        })
    );

    const restart = restartLeadRuntime(
      { teamName: 'alpha', expectedRunId: 'run-1', before, after },
      testPorts
    );
    await vi.waitFor(() => expect(testPorts.killAndWait).toHaveBeenCalledWith(previousChild));
    previousChild.emit('exit', 0, null);
    rejectTermination(new Error('process tree stop unconfirmed'));

    await expect(restart).rejects.toMatchObject({ lifecycleRestored: false });
    expect(targetRun.child).toBe(previousChild);
    expect(targetRun.processKilled).toBe(false);
    expect(targetRun.processClosed).toBe(true);
    expect(targetRun.leadActivityState).toBe('offline');
    expect(testPorts.startStallWatchdog).not.toHaveBeenCalled();
    expect(testPorts.spawn).not.toHaveBeenCalled();
    expect(
      resolveExistingLaunchRunReuse({
        teamName: 'alpha',
        cwd: '/sandbox/team',
        existingAliveRunId: 'run-1',
        existingRun: targetRun,
        existingRunCwd: '/sandbox/team',
        configProjectPath: null,
      })
    ).toMatchObject({ kind: 'blocked' });
  });

  it('kills the replacement and restores the old runtime when metadata sync fails', async () => {
    const targetRun = run();
    const replacement = child(200);
    const rollback = child(300);
    const testPorts = ports(targetRun, [replacement, rollback]);
    testPorts.syncPersistedMetadata.mockRejectedValueOnce(new Error('metadata write failed'));

    await expect(
      restartLeadRuntime({ teamName: 'alpha', expectedRunId: 'run-1', before, after }, testPorts)
    ).rejects.toMatchObject({ lifecycleRestored: true });
    expect(testPorts.killAndWait).toHaveBeenNthCalledWith(1, expect.objectContaining({ pid: 100 }));
    expect(testPorts.killAndWait).toHaveBeenNthCalledWith(2, replacement);
    expect(targetRun.child).toBe(rollback);
    expect(targetRun.request).toMatchObject({ model: 'old-model', effort: 'low' });
    expect(testPorts.syncPersistedMetadata).toHaveBeenNthCalledWith(2, {
      teamName: 'alpha',
      settings: before,
      launchIdentity: targetRun.launchIdentity,
    });
  });

  it('observes replacement exit before close while metadata sync is pending', async () => {
    const targetRun = run();
    const replacement = child(200);
    const rollback = child(300);
    const testPorts = ports(targetRun, [replacement, rollback]);
    let releaseMetadata!: () => void;
    testPorts.syncPersistedMetadata.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          releaseMetadata = () => resolve(undefined);
        })
    );

    const restart = restartLeadRuntime(
      { teamName: 'alpha', expectedRunId: 'run-1', before, after },
      testPorts
    );
    await vi.waitFor(() => expect(testPorts.syncPersistedMetadata).toHaveBeenCalledOnce());
    replacement.emit('exit', 1, null);
    releaseMetadata();

    await expect(restart).rejects.toMatchObject({ lifecycleRestored: true });
    expect(testPorts.spawn).toHaveBeenCalledTimes(2);
    expect(targetRun.child).toBe(rollback);
    expect(testPorts.syncPersistedMetadata).toHaveBeenNthCalledWith(2, {
      teamName: 'alpha',
      settings: before,
      launchIdentity: targetRun.launchIdentity,
    });
    expect(testPorts.handleProcessExit).not.toHaveBeenCalled();
  });

  it('retains degraded rollback ownership when old metadata restoration is unconfirmed', async () => {
    const targetRun = run();
    const replacement = child(200);
    const rollback = child(300);
    const testPorts = ports(targetRun, [replacement, rollback]);
    let releaseMetadataCheck!: () => void;
    testPorts.syncPersistedMetadata
      .mockImplementationOnce(
        () =>
          new Promise<undefined>((resolve) => {
            releaseMetadataCheck = () => resolve(undefined);
          })
      )
      .mockRejectedValueOnce(new Error('metadata rollback failed'));

    const restart = restartLeadRuntime(
      { teamName: 'alpha', expectedRunId: 'run-1', before, after },
      testPorts
    );
    await vi.waitFor(() => expect(testPorts.syncPersistedMetadata).toHaveBeenCalledOnce());
    replacement.emit('exit', 1, null);
    releaseMetadataCheck();

    await expect(restart).rejects.toMatchObject({ lifecycleRestored: false });
    expect(testPorts.syncPersistedMetadata).toHaveBeenNthCalledWith(2, {
      teamName: 'alpha',
      settings: before,
      launchIdentity: targetRun.launchIdentity,
    });
    expect(targetRun.child).toBe(rollback);
    expect(targetRun.processKilled).toBe(false);
    expect(targetRun.processClosed).toBe(true);
    expect(targetRun.leadActivityState).toBe('offline');
    expect(testPorts.killAndWait).toHaveBeenCalledTimes(2);
  });

  it('does not restore lifecycle when rollback exits before metadata close', async () => {
    const targetRun = run();
    const replacement = child(200);
    const rollback = child(300);
    const testPorts = ports(targetRun, [replacement, rollback]);
    let releaseReplacementMetadata!: () => void;
    let releaseRollbackMetadata!: () => void;
    testPorts.syncPersistedMetadata
      .mockImplementationOnce(
        () =>
          new Promise<undefined>((resolve) => {
            releaseReplacementMetadata = () => resolve(undefined);
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<undefined>((resolve) => {
            releaseRollbackMetadata = () => resolve(undefined);
          })
      );

    const restart = restartLeadRuntime(
      { teamName: 'alpha', expectedRunId: 'run-1', before, after },
      testPorts
    );
    await vi.waitFor(() => expect(testPorts.syncPersistedMetadata).toHaveBeenCalledOnce());
    replacement.emit('exit', 1, null);
    releaseReplacementMetadata();
    await vi.waitFor(() => expect(testPorts.syncPersistedMetadata).toHaveBeenCalledTimes(2));
    rollback.emit('exit', 1, null);
    releaseRollbackMetadata();

    await expect(restart).rejects.toMatchObject({ lifecycleRestored: false });
    expect(testPorts.syncPersistedMetadata).toHaveBeenNthCalledWith(2, {
      teamName: 'alpha',
      settings: before,
      launchIdentity: targetRun.launchIdentity,
    });
    expect(testPorts.handleProcessExit).not.toHaveBeenCalled();
    expect(targetRun.child).toBeNull();
    expect(targetRun.processClosed).toBe(true);
    expect(targetRun.leadActivityState).toBe('offline');
  });

  it('does not report success or spawn a stale rollback when ownership is lost during metadata sync', async () => {
    const targetRun = run();
    const replacement = child(200);
    const rollback = child(300);
    const testPorts = ports(targetRun, [replacement, rollback]);
    let releaseMetadata!: () => void;
    testPorts.syncPersistedMetadata.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          releaseMetadata = () => resolve(undefined);
        })
    );
    replacement.once('close', () => {
      testPorts.getAliveRunId.mockReturnValue(null);
      testPorts.getRun.mockReturnValue(undefined);
    });

    const restart = restartLeadRuntime(
      { teamName: 'alpha', expectedRunId: 'run-1', before, after },
      testPorts
    );
    await vi.waitFor(() => expect(testPorts.syncPersistedMetadata).toHaveBeenCalledOnce());
    replacement.emit('close', 1);
    releaseMetadata();

    await expect(restart).rejects.toMatchObject({ lifecycleRestored: false });
    expect(testPorts.spawn).toHaveBeenCalledOnce();
    expect(testPorts.handleProcessExit).not.toHaveBeenCalled();
    expect(targetRun.child).toBeNull();
  });

  it('rolls back the lead process when replacement startup fails', async () => {
    const targetRun = run();
    const rollback = child(300);
    const testPorts = ports(targetRun, [child(null), rollback]);

    await expect(
      restartLeadRuntime({ teamName: 'alpha', expectedRunId: 'run-1', before, after }, testPorts)
    ).rejects.toMatchObject({ lifecycleRestored: true });
    expect(targetRun.child).toBe(rollback);
    expect(testPorts.spawn).toHaveBeenCalledTimes(2);
    expect((testPorts.spawn.mock.calls as unknown[][])[1]?.[1]).toContain('old-model');
  });

  it('rolls back without metadata writes when replacement exits during startup confirmation', async () => {
    const targetRun = run();
    const replacement = child(200);
    const rollback = child(300);
    const testPorts = ports(targetRun, [replacement, rollback]);

    const restart = restartLeadRuntime(
      { teamName: 'alpha', expectedRunId: 'run-1', before, after },
      testPorts
    );
    await vi.waitFor(() => expect(testPorts.spawn).toHaveBeenCalledOnce());
    replacement.emit('exit', 1, null);

    await expect(restart).rejects.toMatchObject({ lifecycleRestored: true });
    expect(testPorts.spawn).toHaveBeenCalledTimes(2);
    expect(testPorts.syncPersistedMetadata).not.toHaveBeenCalled();
    expect(targetRun.child).toBe(rollback);
    expect(targetRun.processClosed).toBe(false);
    expect(targetRun.leadActivityState).toBe('idle');
  });

  it('retains an unconfirmed failed candidate for explicit stop', async () => {
    const targetRun = run();
    const candidate = child(null);
    const testPorts = ports(targetRun, [candidate]);
    testPorts.killAndWait
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('candidate kill timed out'));

    await expect(
      restartLeadRuntime({ teamName: 'alpha', expectedRunId: 'run-1', before, after }, testPorts)
    ).rejects.toMatchObject({ lifecycleRestored: false });

    expect(targetRun.child).toBe(candidate);
    expect(targetRun.processKilled).toBe(false);
    expect(targetRun.processClosed).toBe(true);
    expect(targetRun.leadActivityState).toBe('offline');
    expect(testPorts.spawn).toHaveBeenCalledOnce();
    expect(testPorts.killAndWait).toHaveBeenNthCalledWith(2, candidate);
    expect(testPorts.stopPersistentTeamMembers).not.toHaveBeenCalled();
    expect(testPorts.stopMixedSecondaryRuntimeLanes).not.toHaveBeenCalled();
    expect(
      resolveExistingLaunchRunReuse({
        teamName: 'alpha',
        cwd: '/sandbox/team',
        existingAliveRunId: 'run-1',
        existingRun: targetRun,
        existingRunCwd: '/sandbox/team',
        configProjectPath: null,
      })
    ).toMatchObject({ kind: 'blocked' });
  });

  it('keeps a successful rollback restored when snapshot invalidation fails', async () => {
    const targetRun = run();
    const rollback = child(300);
    const testPorts = ports(targetRun, [child(null), rollback]);
    testPorts.invalidateRuntimeSnapshot.mockImplementationOnce(() => {
      throw new Error('cache unavailable');
    });

    await expect(
      restartLeadRuntime({ teamName: 'alpha', expectedRunId: 'run-1', before, after }, testPorts)
    ).rejects.toMatchObject({ lifecycleRestored: true });
    expect(targetRun.child).toBe(rollback);
    expect(targetRun.leadActivityState).toBe('idle');
  });

  it('requires recovery when replacement and rollback both fail', async () => {
    const targetRun = run({ mixedSecondaryLanes: [{ laneId: 'secondary-1' }] as never });
    const testPorts = ports(targetRun, [child(null), child(null)]);

    await expect(
      restartLeadRuntime({ teamName: 'alpha', expectedRunId: 'run-1', before, after }, testPorts)
    ).rejects.toMatchObject({ lifecycleRestored: false });
    const runtimeState = new TeamProvisioningRuntimeStateProjection({
      state: {
        provisioningRunByTeam: new Map([['alpha', 'run-1']]),
        runs: new Map([['run-1', targetRun]]),
        runtimeAdapterRunByTeam: new Map(),
        runtimeAdapterProgressByRunId: new Map(),
        getRetainedProvisioningProgressMap: () => new Map(),
      },
      ports: {
        getAliveRunId: () => 'run-1',
        getTrackedRunId: () => 'run-1',
        getAliveTeamNames: () => ['alpha'],
        hasSecondaryRuntimeRuns: () => true,
        readBootstrapRuntimeState: async () => null,
      },
    });

    expect(targetRun.child).toBeNull();
    expect(targetRun.processKilled).toBe(true);
    expect(targetRun.processClosed).toBe(true);
    expect(targetRun.leadActivityState).toBe('offline');
    expect(testPorts.killAndWait).toHaveBeenCalledTimes(3);
    expect(testPorts.stopPersistentTeamMembers).toHaveBeenCalledWith('alpha');
    expect(testPorts.stopMixedSecondaryRuntimeLanes).toHaveBeenCalledWith('alpha');
    expect(testPorts.invalidateRuntimeSnapshot).toHaveBeenCalledWith('alpha');
    expect(runtimeState.isTeamAlive('alpha')).toBe(false);
  });

  it('retains degraded ownership when mixed-lane cleanup is unconfirmed', async () => {
    const rollbackCandidate = child(null);
    const targetRun = run({ mixedSecondaryLanes: [{ laneId: 'secondary-1' }] as never });
    const testPorts = ports(targetRun, [child(null), rollbackCandidate]);
    testPorts.stopMixedSecondaryRuntimeLanes.mockRejectedValueOnce(
      new Error('secondary stop timed out')
    );

    await expect(
      restartLeadRuntime({ teamName: 'alpha', expectedRunId: 'run-1', before, after }, testPorts)
    ).rejects.toMatchObject({ lifecycleRestored: false });

    expect(targetRun.child).toBe(rollbackCandidate);
    expect(targetRun.processKilled).toBe(false);
    expect(targetRun.processClosed).toBe(true);
    expect(testPorts.stopPersistentTeamMembers).toHaveBeenCalledWith('alpha');
    expect(testPorts.stopMixedSecondaryRuntimeLanes).toHaveBeenCalledWith('alpha');
  });

  it('retains degraded ownership when persistent teammate cleanup is unconfirmed', async () => {
    const rollbackCandidate = child(null);
    const targetRun = run({ mixedSecondaryLanes: [{ laneId: 'secondary-1' }] as never });
    const testPorts = ports(targetRun, [child(null), rollbackCandidate]);
    testPorts.stopPersistentTeamMembers.mockReturnValueOnce(false);

    await expect(
      restartLeadRuntime({ teamName: 'alpha', expectedRunId: 'run-1', before, after }, testPorts)
    ).rejects.toMatchObject({ lifecycleRestored: false });

    expect(targetRun.child).toBe(rollbackCandidate);
    expect(targetRun.processKilled).toBe(false);
    expect(targetRun.processClosed).toBe(true);
    expect(testPorts.stopMixedSecondaryRuntimeLanes).toHaveBeenCalledWith('alpha');
    expect(
      resolveExistingLaunchRunReuse({
        teamName: 'alpha',
        cwd: '/sandbox/team',
        existingAliveRunId: 'run-1',
        existingRun: targetRun,
        existingRunCwd: '/sandbox/team',
        configProjectPath: null,
      })
    ).toMatchObject({ kind: 'blocked' });
  });
});
