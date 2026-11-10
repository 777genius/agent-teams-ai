import { describe, expect, it, vi } from 'vitest';

import {
  clearMemberSpawnToolTracking,
  createRuntimeToolActivityHandlerPortsFromService,
  createRuntimeToolActivityHandlers,
  finishRuntimeToolActivity,
  pauseMemberTaskActivityForRuntimeLoss,
  resetRuntimeToolActivity,
  type RuntimeToolActivityRunLike,
  type RuntimeToolActivityServiceHost,
  startRuntimeToolActivity,
  syncMemberTaskActivityForRuntimeTransition,
} from '../TeamProvisioningRuntimeToolActivity';

import type {
  ActiveToolCall,
  MemberSpawnStatus,
  MemberSpawnStatusEntry,
  TeamChangeEvent,
  TeamProvisioningProgress,
  TeamProvisioningState,
  ToolActivityEventPayload,
} from '@shared/types';

const ISO = '2026-01-01T00:00:00.000Z';
const ISO_LATER = '2026-01-01T00:00:10.000Z';

function active(memberName: string, toolUseId: string): ActiveToolCall {
  return {
    memberName,
    toolUseId,
    toolName: 'Agent',
    startedAt: ISO,
    state: 'running',
    source: 'runtime',
  };
}

function status(overrides: Partial<MemberSpawnStatusEntry>): MemberSpawnStatusEntry {
  return {
    status: 'waiting',
    launchState: 'runtime_pending_bootstrap',
    updatedAt: ISO,
    agentToolAccepted: true,
    runtimeAlive: false,
    bootstrapConfirmed: false,
    hardFailure: false,
    ...overrides,
  };
}

function run(overrides: Partial<RuntimeToolActivityRunLike> = {}): RuntimeToolActivityRunLike {
  return {
    teamName: 'team',
    runId: 'run-1',
    activeToolCalls: new Map<string, ActiveToolCall>(),
    memberSpawnToolUseIds: new Map<string, string>(),
    pendingMemberRestarts: new Map(),
    provisioningOutputParts: [],
    provisioningOutputIndexByMessageId: new Map<string, number>(),
    stallWarningIndex: null,
    apiRetryWarningIndex: null,
    provisioningComplete: false,
    progress: { state: 'assembling' } as TeamProvisioningProgress,
    onProgress: vi.fn(),
    ...overrides,
  };
}

describe('runtime tool activity helpers', () => {
  it('starts runtime tool activity and emits a start event for the current run', () => {
    const emitTeamChange = vi.fn<(event: TeamChangeEvent) => void>();
    const targetRun = run();

    startRuntimeToolActivity(
      targetRun,
      'api',
      { id: ' tool-api ', name: 'Read', input: { file_path: 'src/index.ts' } },
      {
        isCurrentTrackedRun: () => true,
        emitTeamChange,
        nowIso: () => ISO,
      }
    );

    expect(targetRun.activeToolCalls.get('tool-api')).toMatchObject({
      memberName: 'api',
      toolUseId: 'tool-api',
      toolName: 'Read',
      preview: 'index.ts',
      startedAt: ISO,
      state: 'running',
      source: 'runtime',
    });
    expect(emitTeamChange).toHaveBeenCalledWith({
      type: 'tool-activity',
      teamName: 'team',
      runId: 'run-1',
      detail: JSON.stringify({
        action: 'start',
        activity: {
          memberName: 'api',
          toolUseId: 'tool-api',
          toolName: 'Read',
          preview: 'index.ts',
          startedAt: ISO,
          source: 'runtime',
        },
      }),
    });
  });

  it('finishes runtime tool activity and marks accepted spawn tools as waiting', () => {
    const emitTeamChange = vi.fn<(event: TeamChangeEvent) => void>();
    const setMemberSpawnStatus =
      vi.fn<
        (targetRun: ReturnType<typeof run>, memberName: string, state: MemberSpawnStatus) => void
      >();
    const targetRun = run({
      activeToolCalls: new Map([['tool-api', active('lead', 'tool-api')]]),
      memberSpawnToolUseIds: new Map([['tool-api', 'api']]),
    });

    finishRuntimeToolActivity(
      targetRun,
      'tool-api',
      [{ type: 'text', text: 'spawn accepted' }],
      false,
      {
        isCurrentTrackedRun: () => true,
        emitTeamChange,
        nowIso: () => ISO_LATER,
        logInfo: vi.fn(),
        logWarn: vi.fn(),
        updateProgress: vi.fn(),
        setMemberSpawnStatus,
        invalidateRuntimeSnapshotCaches: vi.fn(),
        reevaluateMemberLaunchStatus: vi.fn(),
      }
    );

    expect(targetRun.activeToolCalls.size).toBe(0);
    expect(targetRun.memberSpawnToolUseIds.size).toBe(0);
    expect(setMemberSpawnStatus).toHaveBeenCalledWith(targetRun, 'api', 'waiting');
    expect(JSON.parse(emitTeamChange.mock.calls[0]?.[0].detail ?? '{}')).toMatchObject({
      action: 'finish',
      memberName: 'lead',
      toolUseId: 'tool-api',
      finishedAt: ISO_LATER,
      isError: false,
    });
  });

  it('records spawn failures and updates progress through ports', () => {
    const setMemberSpawnStatus = vi.fn();
    const updateProgress = vi.fn(
      (
        targetRun: RuntimeToolActivityRunLike,
        state: Exclude<TeamProvisioningState, 'idle'>,
        message: string
      ): TeamProvisioningProgress =>
        ({
          ...targetRun.progress,
          state,
          message,
        }) as TeamProvisioningProgress
    );
    const targetRun = run({
      activeToolCalls: new Map([['tool-api', active('lead', 'tool-api')]]),
      memberSpawnToolUseIds: new Map([['tool-api', 'api']]),
    });

    finishRuntimeToolActivity(targetRun, 'tool-api', 'permission denied', true, {
      isCurrentTrackedRun: () => true,
      emitTeamChange: vi.fn(),
      nowIso: () => ISO_LATER,
      logInfo: vi.fn(),
      logWarn: vi.fn(),
      updateProgress,
      setMemberSpawnStatus,
      invalidateRuntimeSnapshotCaches: vi.fn(),
      reevaluateMemberLaunchStatus: vi.fn(),
    });

    expect(setMemberSpawnStatus).toHaveBeenCalledWith(
      targetRun,
      'api',
      'error',
      'Teammate "api" failed to start: permission denied'
    );
    expect(targetRun.provisioningOutputParts).toEqual([
      'Teammate "api" failed to start: permission denied',
    ]);
    expect(updateProgress).toHaveBeenCalledWith(
      targetRun,
      'assembling',
      'Failed to start member api'
    );
    expect(targetRun.onProgress).toHaveBeenCalledWith({
      state: 'assembling',
      message: 'Failed to start member api',
    });
  });

  it('clears all active tool calls and emits a reset event', () => {
    const emitToolActivity = vi.fn<(payload: ToolActivityEventPayload) => void>();
    const run = {
      activeToolCalls: new Map([
        ['tool-api', active('api', 'tool-api')],
        ['tool-web', active('web', 'tool-web')],
      ]),
    };

    resetRuntimeToolActivity(run, undefined, { emitToolActivity });

    expect(run.activeToolCalls.size).toBe(0);
    expect(emitToolActivity).toHaveBeenCalledWith({ action: 'reset' });
  });

  it('clears only the requested member active tool calls', () => {
    const emitToolActivity = vi.fn<(payload: ToolActivityEventPayload) => void>();
    const run = {
      activeToolCalls: new Map([
        ['tool-api-1', active('api', 'tool-api-1')],
        ['tool-api-2', active('api', 'tool-api-2')],
        ['tool-web', active('web', 'tool-web')],
      ]),
    };

    resetRuntimeToolActivity(run, 'api', { emitToolActivity });

    expect([...run.activeToolCalls.keys()]).toEqual(['tool-web']);
    expect(emitToolActivity).toHaveBeenCalledWith({ action: 'reset', memberName: 'api' });
  });

  it('does not emit when no matching member tool calls are removed', () => {
    const emitToolActivity = vi.fn<(payload: ToolActivityEventPayload) => void>();
    const run = {
      activeToolCalls: new Map([['tool-web', active('web', 'tool-web')]]),
    };

    resetRuntimeToolActivity(run, 'api', { emitToolActivity });

    expect([...run.activeToolCalls.keys()]).toEqual(['tool-web']);
    expect(emitToolActivity).not.toHaveBeenCalled();
  });

  it('clears member spawn tool tracking and emits a diagnostic only when entries are removed', () => {
    const appendMemberBootstrapDiagnostic = vi.fn<(memberName: string, text: string) => void>();
    const run = {
      memberSpawnToolUseIds: new Map([
        ['tool-api-1', 'api'],
        ['tool-api-2', 'api'],
        ['tool-web', 'web'],
      ]),
    };

    clearMemberSpawnToolTracking(run, 'api', { appendMemberBootstrapDiagnostic });

    expect([...run.memberSpawnToolUseIds.entries()]).toEqual([['tool-web', 'web']]);
    expect(appendMemberBootstrapDiagnostic).toHaveBeenCalledWith(
      'api',
      'cleared stale spawn tool tracking before manual restart'
    );

    appendMemberBootstrapDiagnostic.mockClear();
    clearMemberSpawnToolTracking(run, 'api', { appendMemberBootstrapDiagnostic });
    expect(appendMemberBootstrapDiagnostic).not.toHaveBeenCalled();
  });

  it('pauses active task intervals at the bounded runtime-loss timestamp', () => {
    const pauseActiveIntervalsForMember = vi.fn();
    const previous = status({
      runtimeAlive: true,
      lastHeartbeatAt: ISO,
      updatedAt: ISO,
    });

    pauseMemberTaskActivityForRuntimeLoss({ teamName: 'team' }, 'api', previous, ISO_LATER, {
      pauseActiveIntervalsForMember,
    });

    expect(pauseActiveIntervalsForMember).toHaveBeenCalledWith(
      'team',
      'api',
      '2026-01-01T00:00:05.000Z'
    );
  });

  it('resumes active task intervals when runtime transitions to alive', () => {
    const resumeActiveIntervalsForMember = vi.fn();
    const previous = status({ runtimeAlive: false, updatedAt: ISO });
    const next = status({ runtimeAlive: true, updatedAt: ISO_LATER });

    syncMemberTaskActivityForRuntimeTransition(
      { teamName: 'team' },
      'api',
      previous,
      next,
      '2026-01-01T00:00:08.000Z',
      {
        pauseActiveIntervalsForMember: vi.fn(),
        resumeActiveIntervalsForMember,
        nowIso: () => '2026-01-01T00:00:12.000Z',
      }
    );

    expect(resumeActiveIntervalsForMember).toHaveBeenCalledWith(
      'team',
      'api',
      '2026-01-01T00:00:08.000Z'
    );
  });

  it('builds runtime tool activity handler ports from service-shaped dependencies', async () => {
    const targetRun = run();
    const emitTeamChange = vi.fn<(event: TeamChangeEvent) => void>();
    const pauseActiveIntervalsForMember = vi.fn(() => ({ failed: false }));
    const resumeActiveIntervalsForMember = vi.fn(() => ({ failed: false }));
    const service = {
      teamChangeEmitter: emitTeamChange,
      taskActivityIntervalService: {
        pauseActiveIntervalsForMember,
        resumeActiveIntervalsForMember,
      },
      isCurrentTrackedRun: vi.fn(() => true),
      setMemberSpawnStatus: vi.fn(),
      invalidateRuntimeSnapshotCaches: vi.fn(),
      reevaluateMemberLaunchStatus: vi.fn(async () => undefined),
    } satisfies RuntimeToolActivityServiceHost<RuntimeToolActivityRunLike>;
    const updateProgress = vi.fn((targetRun: RuntimeToolActivityRunLike) => targetRun.progress);
    const ports = createRuntimeToolActivityHandlerPortsFromService(service, {
      nowIso: () => ISO_LATER,
      logInfo: vi.fn(),
      logWarn: vi.fn(),
      updateProgress,
    });

    expect(ports.isCurrentTrackedRun(targetRun)).toBe(true);
    ports.emitTeamChange({ type: 'process', teamName: 'team', detail: 'ready' });
    ports.setMemberSpawnStatus(targetRun, 'api', 'error', 'boom');
    ports.invalidateRuntimeSnapshotCaches('team');
    await ports.reevaluateMemberLaunchStatus(targetRun, 'api');
    ports.pauseActiveIntervalsForMember('team', 'api', ISO);
    ports.resumeActiveIntervalsForMember('team', 'api', ISO_LATER);

    expect(ports.nowIso()).toBe(ISO_LATER);
    expect(emitTeamChange).toHaveBeenCalledWith({
      type: 'process',
      teamName: 'team',
      detail: 'ready',
    });
    expect(service.setMemberSpawnStatus).toHaveBeenCalledWith(targetRun, 'api', 'error', 'boom');
    expect(service.invalidateRuntimeSnapshotCaches).toHaveBeenCalledWith('team');
    expect(service.reevaluateMemberLaunchStatus).toHaveBeenCalledWith(targetRun, 'api');
    expect(pauseActiveIntervalsForMember).toHaveBeenCalledWith('team', 'api', ISO);
    expect(resumeActiveIntervalsForMember).toHaveBeenCalledWith('team', 'api', ISO_LATER);
  });

  it('wires runtime tool activity handler ports for reset and spawn tracking cleanup', () => {
    const emitTeamChange = vi.fn<(event: TeamChangeEvent) => void>();
    const logInfo = vi.fn();
    const targetRun = run({
      activeToolCalls: new Map([['tool-api', active('api', 'tool-api')]]),
      memberSpawnToolUseIds: new Map([['tool-api', 'api']]),
    });
    const handlers = createRuntimeToolActivityHandlers({
      isCurrentTrackedRun: () => true,
      emitTeamChange,
      nowIso: () => ISO_LATER,
      logInfo,
      logWarn: vi.fn(),
      updateProgress: vi.fn(),
      setMemberSpawnStatus: vi.fn(),
      invalidateRuntimeSnapshotCaches: vi.fn(),
      reevaluateMemberLaunchStatus: vi.fn(),
      pauseActiveIntervalsForMember: vi.fn(),
      resumeActiveIntervalsForMember: vi.fn(),
    });

    handlers.resetRuntimeToolActivity(targetRun, 'api');
    handlers.clearMemberSpawnToolTracking(targetRun, 'api');

    expect(targetRun.activeToolCalls.size).toBe(0);
    expect(targetRun.memberSpawnToolUseIds.size).toBe(0);
    expect(JSON.parse(emitTeamChange.mock.calls[0]?.[0].detail ?? '{}')).toEqual({
      action: 'reset',
      memberName: 'api',
    });
    expect(logInfo).toHaveBeenCalledWith(
      '[team] [bootstrap] api: cleared stale spawn tool tracking before manual restart'
    );
  });
});
