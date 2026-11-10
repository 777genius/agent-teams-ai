import {
  extractToolPreview,
  extractToolResultPreview,
  parseAgentToolResultStatus,
} from '@shared/utils/toolSummary';

import {
  buildRestartDuplicateUnconfirmedReason,
  buildRestartStillRunningReason,
  deriveTaskActivityPauseAt,
  deriveTaskActivityResumeAt,
  parseOptionalIsoMs,
} from './TeamProvisioningMemberSpawnStatusPolicy';
import {
  buildMemberSpawnFailureMessage,
  type PendingMemberSpawnRestart,
} from './TeamProvisioningMemberSpawnTransitions';
import { boundRunProvisioningOutputParts } from './TeamProvisioningProgressBuffers';
import { normalizeMemberDiagnosticText } from './TeamProvisioningPromptBuilders';

import type {
  ActiveToolCall,
  MemberSpawnStatus,
  MemberSpawnStatusEntry,
  TeamChangeEvent,
  TeamProvisioningProgress,
  TeamProvisioningState,
  ToolActivityEventPayload,
} from '@shared/types';

export interface RuntimeToolActivityRunLike {
  teamName: string;
  runId: string;
  activeToolCalls: Map<string, ActiveToolCall>;
  memberSpawnToolUseIds: Map<string, string>;
  pendingMemberRestarts: Map<string, PendingMemberSpawnRestart>;
  provisioningOutputParts: string[];
  provisioningOutputIndexByMessageId: Map<string, number>;
  stallWarningIndex: number | null;
  apiRetryWarningIndex: number | null;
  provisioningComplete: boolean;
  progress: TeamProvisioningProgress;
  onProgress(progress: TeamProvisioningProgress): void;
}

export interface RuntimeToolActivityEmitPorts<
  TRun extends Pick<RuntimeToolActivityRunLike, 'teamName' | 'runId'>,
> {
  isCurrentTrackedRun(run: TRun): boolean;
  emitTeamChange(event: TeamChangeEvent): void;
}

export interface StartRuntimeToolActivityPorts<
  TRun extends Pick<RuntimeToolActivityRunLike, 'teamName' | 'runId'>,
> extends RuntimeToolActivityEmitPorts<TRun> {
  nowIso(): string;
}

export interface FinishRuntimeToolActivityPorts<TRun extends RuntimeToolActivityRunLike>
  extends
    StartRuntimeToolActivityPorts<TRun>,
    AppendMemberBootstrapDiagnosticPorts,
    HandleMemberSpawnFailurePorts<TRun> {
  invalidateRuntimeSnapshotCaches(teamName: string): void;
  reevaluateMemberLaunchStatus(run: TRun, memberName: string): Promise<unknown> | unknown;
  logWarn(message: string): void;
}

export interface ResetRuntimeToolActivityPorts {
  emitToolActivity(payload: ToolActivityEventPayload): void;
}

export interface ClearMemberSpawnToolTrackingPorts {
  appendMemberBootstrapDiagnostic(memberName: string, text: string): void;
}

export interface AppendMemberBootstrapDiagnosticPorts {
  logInfo(message: string): void;
}

export interface HandleMemberSpawnFailurePorts<TRun extends RuntimeToolActivityRunLike> {
  setMemberSpawnStatus(
    run: TRun,
    memberName: string,
    status: MemberSpawnStatus,
    error?: string
  ): void;
  updateProgress(
    run: TRun,
    state: Exclude<TeamProvisioningState, 'idle'>,
    message: string
  ): TeamProvisioningProgress;
}

export interface RuntimeLossTaskActivityPorts {
  pauseActiveIntervalsForMember(
    teamName: string,
    memberName: string,
    at: string
  ): { failed?: boolean };
}

export interface RuntimeTransitionTaskActivityPorts extends RuntimeLossTaskActivityPorts {
  resumeActiveIntervalsForMember(
    teamName: string,
    memberName: string,
    at: string
  ): { failed?: boolean };
  nowIso(): string;
}

export interface RuntimeToolActivityHandlerPorts<TRun extends RuntimeToolActivityRunLike>
  extends FinishRuntimeToolActivityPorts<TRun>, RuntimeTransitionTaskActivityPorts {}

export interface RuntimeToolActivityServiceHost<TRun extends RuntimeToolActivityRunLike> {
  teamChangeEmitter?: ((event: TeamChangeEvent) => void) | null;
  taskActivityIntervalService: Pick<
    RuntimeTransitionTaskActivityPorts,
    'pauseActiveIntervalsForMember' | 'resumeActiveIntervalsForMember'
  >;
  isCurrentTrackedRun(run: TRun): boolean;
  setMemberSpawnStatus(
    run: TRun,
    memberName: string,
    status: MemberSpawnStatus,
    error?: string
  ): void;
  invalidateRuntimeSnapshotCaches(teamName: string): void;
  reevaluateMemberLaunchStatus(run: TRun, memberName: string): Promise<unknown> | unknown;
}

export interface RuntimeToolActivityServiceHostOptions<TRun extends RuntimeToolActivityRunLike> {
  nowIso: RuntimeToolActivityHandlerPorts<TRun>['nowIso'];
  logInfo: RuntimeToolActivityHandlerPorts<TRun>['logInfo'];
  logWarn: RuntimeToolActivityHandlerPorts<TRun>['logWarn'];
  updateProgress: RuntimeToolActivityHandlerPorts<TRun>['updateProgress'];
}

export interface RuntimeToolActivityHandlers<TRun extends RuntimeToolActivityRunLike> {
  emitToolActivity(run: TRun, payload: ToolActivityEventPayload): void;
  startRuntimeToolActivity(run: TRun, memberName: string, block: Record<string, unknown>): void;
  finishRuntimeToolActivity(
    run: TRun,
    toolUseId: string,
    resultContent: unknown,
    isError: boolean
  ): void;
  appendMemberBootstrapDiagnostic(run: TRun, memberName: string, text: string): void;
  resetRuntimeToolActivity(run: TRun, memberName?: string): void;
  clearMemberSpawnToolTracking(run: TRun, memberName: string): void;
  pauseMemberTaskActivityForRuntimeLoss(
    run: TRun,
    memberName: string,
    previous: MemberSpawnStatusEntry,
    observedAt: string
  ): void;
  syncMemberTaskActivityForRuntimeTransition(
    run: TRun,
    memberName: string,
    previous: MemberSpawnStatusEntry,
    next: MemberSpawnStatusEntry,
    observedAt: string
  ): void;
}

export function createRuntimeToolActivityHandlerPortsFromService<
  TRun extends RuntimeToolActivityRunLike,
>(
  service: RuntimeToolActivityServiceHost<TRun>,
  options: RuntimeToolActivityServiceHostOptions<TRun>
): RuntimeToolActivityHandlerPorts<TRun> {
  return {
    isCurrentTrackedRun: (run) => service.isCurrentTrackedRun(run),
    emitTeamChange: (event) => {
      service.teamChangeEmitter?.(event);
    },
    nowIso: options.nowIso,
    logInfo: options.logInfo,
    logWarn: options.logWarn,
    updateProgress: options.updateProgress,
    setMemberSpawnStatus: (run, memberName, status, error) =>
      service.setMemberSpawnStatus(run, memberName, status, error),
    invalidateRuntimeSnapshotCaches: (teamName) =>
      service.invalidateRuntimeSnapshotCaches(teamName),
    reevaluateMemberLaunchStatus: (run, memberName) =>
      service.reevaluateMemberLaunchStatus(run, memberName),
    pauseActiveIntervalsForMember: (teamName, memberName, at) =>
      service.taskActivityIntervalService.pauseActiveIntervalsForMember(teamName, memberName, at),
    resumeActiveIntervalsForMember: (teamName, memberName, at) =>
      service.taskActivityIntervalService.resumeActiveIntervalsForMember(teamName, memberName, at),
  };
}

export function createRuntimeToolActivityHandlers<TRun extends RuntimeToolActivityRunLike>(
  ports: RuntimeToolActivityHandlerPorts<TRun>
): RuntimeToolActivityHandlers<TRun> {
  const handlers: RuntimeToolActivityHandlers<TRun> = {
    emitToolActivity(run, payload) {
      emitToolActivity(run, payload, ports);
    },
    startRuntimeToolActivity(run, memberName, block) {
      startRuntimeToolActivity(run, memberName, block, ports);
    },
    finishRuntimeToolActivity(run, toolUseId, resultContent, isError) {
      finishRuntimeToolActivity(run, toolUseId, resultContent, isError, ports);
    },
    appendMemberBootstrapDiagnostic(run, memberName, text) {
      appendMemberBootstrapDiagnostic(run, memberName, text, ports);
    },
    resetRuntimeToolActivity(run, memberName) {
      resetRuntimeToolActivity(run, memberName, {
        emitToolActivity: (payload) => handlers.emitToolActivity(run, payload),
      });
    },
    clearMemberSpawnToolTracking(run, memberName) {
      clearMemberSpawnToolTracking(run, memberName, {
        appendMemberBootstrapDiagnostic: (targetMemberName, text) =>
          handlers.appendMemberBootstrapDiagnostic(run, targetMemberName, text),
      });
    },
    pauseMemberTaskActivityForRuntimeLoss(run, memberName, previous, observedAt) {
      pauseMemberTaskActivityForRuntimeLoss(run, memberName, previous, observedAt, ports);
    },
    syncMemberTaskActivityForRuntimeTransition(run, memberName, previous, next, observedAt) {
      syncMemberTaskActivityForRuntimeTransition(
        run,
        memberName,
        previous,
        next,
        observedAt,
        ports
      );
    },
  };

  return handlers;
}

export function emitToolActivity<
  TRun extends Pick<RuntimeToolActivityRunLike, 'teamName' | 'runId'>,
>(run: TRun, payload: ToolActivityEventPayload, ports: RuntimeToolActivityEmitPorts<TRun>): void {
  if (!ports.isCurrentTrackedRun(run)) return;
  ports.emitTeamChange({
    type: 'tool-activity',
    teamName: run.teamName,
    runId: run.runId,
    detail: JSON.stringify(payload),
  });
}

export function startRuntimeToolActivity<
  TRun extends Pick<RuntimeToolActivityRunLike, 'teamName' | 'runId' | 'activeToolCalls'>,
>(
  run: TRun,
  memberName: string,
  block: Record<string, unknown>,
  ports: StartRuntimeToolActivityPorts<TRun>
): void {
  const rawId = typeof block.id === 'string' ? block.id.trim() : '';
  if (!rawId) return;

  const toolUseId = rawId;
  if (run.activeToolCalls.has(toolUseId)) return;

  const toolName = typeof block.name === 'string' ? block.name : 'unknown';
  const input = (block.input ?? {}) as Record<string, unknown>;
  const activity: ActiveToolCall = {
    memberName,
    toolUseId,
    toolName,
    preview: extractToolPreview(toolName, input),
    startedAt: ports.nowIso(),
    state: 'running',
    source: 'runtime',
  };

  run.activeToolCalls.set(toolUseId, activity);
  emitToolActivity(
    run,
    {
      action: 'start',
      activity: {
        memberName: activity.memberName,
        toolUseId: activity.toolUseId,
        toolName: activity.toolName,
        preview: activity.preview,
        startedAt: activity.startedAt,
        source: activity.source,
      },
    },
    ports
  );
}

export function finishRuntimeToolActivity<TRun extends RuntimeToolActivityRunLike>(
  run: TRun,
  toolUseId: string,
  resultContent: unknown,
  isError: boolean,
  ports: FinishRuntimeToolActivityPorts<TRun>
): void {
  const active = run.activeToolCalls.get(toolUseId);
  if (!active) return;

  run.activeToolCalls.delete(toolUseId);
  const resultPreview = extractToolResultPreview(resultContent);
  emitToolActivity(
    run,
    {
      action: 'finish',
      memberName: active.memberName,
      toolUseId,
      finishedAt: ports.nowIso(),
      resultPreview,
      isError,
    },
    ports
  );

  const spawnedMemberName = run.memberSpawnToolUseIds.get(toolUseId);
  if (!spawnedMemberName) {
    return;
  }

  run.memberSpawnToolUseIds.delete(toolUseId);
  const pendingRestart = run.pendingMemberRestarts.get(spawnedMemberName);
  if (isError) {
    handleMemberSpawnFailure(run, spawnedMemberName, resultPreview, ports);
    return;
  }

  if (active.toolName !== 'Agent') {
    ports.setMemberSpawnStatus(run, spawnedMemberName, 'waiting');
    return;
  }

  const parsedStatus = parseAgentToolResultStatus(resultContent);
  if (parsedStatus?.status !== 'duplicate_skipped') {
    ports.setMemberSpawnStatus(run, spawnedMemberName, 'waiting');
    return;
  }

  const detail =
    parsedStatus.reason === 'already_running'
      ? 'duplicate spawn skipped - already running'
      : parsedStatus.reason === 'bootstrap_pending'
        ? 'duplicate spawn skipped - teammate bootstrap still pending'
        : parsedStatus.rawReason
          ? `duplicate spawn skipped - unrecognized reason: ${parsedStatus.rawReason}`
          : 'duplicate spawn skipped - reason unavailable';
  appendMemberBootstrapDiagnostic(run, spawnedMemberName, detail, ports);

  if (pendingRestart && !parsedStatus.reason) {
    ports.logWarn(
      `[${run.teamName}] Restart for teammate "${spawnedMemberName}" returned duplicate_skipped without a recognized reason`
    );
    run.pendingMemberRestarts.delete(spawnedMemberName);
    ports.setMemberSpawnStatus(
      run,
      spawnedMemberName,
      'error',
      buildRestartDuplicateUnconfirmedReason(spawnedMemberName, parsedStatus.rawReason)
    );
    return;
  }

  if (parsedStatus.reason === 'already_running') {
    if (pendingRestart) {
      run.pendingMemberRestarts.delete(spawnedMemberName);
      ports.setMemberSpawnStatus(
        run,
        spawnedMemberName,
        'error',
        buildRestartStillRunningReason(spawnedMemberName)
      );
      return;
    }
    ports.invalidateRuntimeSnapshotCaches(run.teamName);
    ports.setMemberSpawnStatus(run, spawnedMemberName, 'waiting');
    appendMemberBootstrapDiagnostic(
      run,
      spawnedMemberName,
      'already_running requires strong runtime verification',
      ports
    );
    void ports.reevaluateMemberLaunchStatus(run, spawnedMemberName);
    return;
  }

  ports.setMemberSpawnStatus(run, spawnedMemberName, 'waiting');
}

export function handleMemberSpawnFailure<TRun extends RuntimeToolActivityRunLike>(
  run: TRun,
  memberName: string,
  resultPreview: string | undefined,
  ports: HandleMemberSpawnFailurePorts<TRun>
): void {
  const pendingRestart = run.pendingMemberRestarts.get(memberName);
  const message = buildMemberSpawnFailureMessage({ memberName, resultPreview, pendingRestart });

  run.pendingMemberRestarts.delete(memberName);
  ports.setMemberSpawnStatus(run, memberName, 'error', message);

  const lastIndex = run.provisioningOutputParts.length - 1;
  if (lastIndex < 0 || run.provisioningOutputParts[lastIndex]?.trim() !== message) {
    run.provisioningOutputParts.push(message);
    boundRunProvisioningOutputParts(run);
  }

  if (
    !run.provisioningComplete &&
    (run.progress.state === 'assembling' || run.progress.state === 'configuring')
  ) {
    const progress = ports.updateProgress(
      run,
      'assembling',
      `Failed to start member ${memberName}`
    );
    run.onProgress(progress);
  }
}

export function appendMemberBootstrapDiagnostic<TRun extends RuntimeToolActivityRunLike>(
  run: TRun,
  memberName: string,
  text: string,
  ports: AppendMemberBootstrapDiagnosticPorts
): void {
  const line = normalizeMemberDiagnosticText(memberName, text);
  const lastIndex = run.provisioningOutputParts.length - 1;
  if (lastIndex >= 0 && run.provisioningOutputParts[lastIndex]?.trim() === line) {
    return;
  }
  run.provisioningOutputParts.push(line);
  boundRunProvisioningOutputParts(run);
  ports.logInfo(`[${run.teamName}] [bootstrap] ${line}`);
}

export function resetRuntimeToolActivity(
  run: Pick<RuntimeToolActivityRunLike, 'activeToolCalls'>,
  memberName: string | undefined,
  ports: ResetRuntimeToolActivityPorts
): void {
  if (run.activeToolCalls.size === 0) {
    return;
  }

  if (!memberName) {
    run.activeToolCalls.clear();
    ports.emitToolActivity({ action: 'reset' });
    return;
  }

  let removed = false;
  for (const [toolUseId, active] of run.activeToolCalls.entries()) {
    if (active.memberName !== memberName) {
      continue;
    }
    run.activeToolCalls.delete(toolUseId);
    removed = true;
  }

  if (removed) {
    ports.emitToolActivity({ action: 'reset', memberName });
  }
}

export function clearMemberSpawnToolTracking(
  run: Pick<RuntimeToolActivityRunLike, 'memberSpawnToolUseIds'>,
  memberName: string,
  ports: ClearMemberSpawnToolTrackingPorts
): void {
  let removed = false;
  for (const [toolUseId, trackedMemberName] of run.memberSpawnToolUseIds.entries()) {
    if (trackedMemberName !== memberName) {
      continue;
    }
    run.memberSpawnToolUseIds.delete(toolUseId);
    removed = true;
  }

  if (removed) {
    ports.appendMemberBootstrapDiagnostic(
      memberName,
      'cleared stale spawn tool tracking before manual restart'
    );
  }
}

export function pauseMemberTaskActivityForRuntimeLoss(
  run: Pick<RuntimeToolActivityRunLike, 'teamName'>,
  memberName: string,
  previous: MemberSpawnStatusEntry,
  observedAt: string,
  ports: RuntimeLossTaskActivityPorts
): void {
  if (previous.runtimeAlive !== true) return;
  ports.pauseActiveIntervalsForMember(
    run.teamName,
    memberName,
    deriveTaskActivityPauseAt(previous, observedAt)
  );
}

export function syncMemberTaskActivityForRuntimeTransition(
  run: Pick<RuntimeToolActivityRunLike, 'teamName'>,
  memberName: string,
  previous: MemberSpawnStatusEntry,
  next: MemberSpawnStatusEntry,
  observedAt: string,
  ports: RuntimeTransitionTaskActivityPorts
): void {
  if (previous.runtimeAlive === true && next.runtimeAlive !== true) {
    pauseMemberTaskActivityForRuntimeLoss(run, memberName, previous, observedAt, ports);
    return;
  }

  if (previous.runtimeAlive === true || next.runtimeAlive !== true) {
    return;
  }

  const nextUpdatedMs = parseOptionalIsoMs(next.updatedAt);
  const previousUpdatedMs = parseOptionalIsoMs(previous.updatedAt);
  const resumeFallbackAt =
    nextUpdatedMs > 0 && (previousUpdatedMs <= 0 || nextUpdatedMs > previousUpdatedMs)
      ? next.updatedAt
      : ports.nowIso();
  ports.resumeActiveIntervalsForMember(
    run.teamName,
    memberName,
    deriveTaskActivityResumeAt(previous, observedAt, resumeFallbackAt)
  );
}
