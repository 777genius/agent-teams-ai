import type { TeamChangeEvent } from '@shared/types';

export type LeadActivityState = 'active' | 'idle' | 'offline';

export interface LeadActivityRunLike {
  teamName: string;
  runId: string;
  leadActivityState: LeadActivityState;
}

export interface LeadActivityAccessorRunLike extends LeadActivityRunLike {
  processKilled: boolean;
  cancelRequested: boolean;
}

export interface LeadActivityAccessorPorts<TRun extends LeadActivityAccessorRunLike> {
  getTrackedRunId(teamName: string): string | null;
  getRun(runId: string): TRun | undefined;
  getRuntimeAdapterRun(teamName: string): { runId: string } | null | undefined;
  getRuntimeAdapterProgress(runId: string): { state?: string } | null | undefined;
  syncLeadTaskActivityForState(
    run: TRun,
    state: LeadActivityState,
    previousState: LeadActivityState
  ): void;
}

export interface LeadTaskActivityIntervalPorts<TRun extends LeadActivityRunLike> {
  syncedRunKeys: Set<string>;
  getRunLeadName(run: TRun): string;
  resumeActiveIntervalsForMember(
    teamName: string,
    memberName: string,
    at: string
  ): { failed?: boolean };
  pauseActiveIntervalsForMember(
    teamName: string,
    memberName: string,
    at: string
  ): { failed?: boolean };
}

export interface SetLeadActivityPorts<TRun extends LeadActivityRunLike>
  extends LeadTaskActivityIntervalPorts<TRun> {
  isCurrentTrackedRun(run: TRun): boolean;
  nowIso(): string;
  emitTeamChange(event: TeamChangeEvent): void;
}

export function getLeadTaskActivityRunKey(run: Pick<LeadActivityRunLike, 'teamName' | 'runId'>): string {
  return `${run.teamName}\u0000${run.runId}`;
}

export function getLeadActivityStateForTeam<TRun extends LeadActivityAccessorRunLike>(
  teamName: string,
  ports: LeadActivityAccessorPorts<TRun>
): { state: LeadActivityState; runId: string | null } {
  const runId = ports.getTrackedRunId(teamName);
  if (!runId) return { state: 'offline', runId: null };

  const run = ports.getRun(runId);
  if (!run) {
    const runtimeAdapterRun = ports.getRuntimeAdapterRun(teamName);
    const runtimeProgress = ports.getRuntimeAdapterProgress(runId);
    if (
      runtimeAdapterRun?.runId === runId &&
      !['cancelled', 'disconnected', 'failed'].includes(runtimeProgress?.state ?? '')
    ) {
      return { state: 'idle', runId };
    }
    return { state: 'offline', runId: null };
  }

  if (run.processKilled || run.cancelRequested) return { state: 'offline', runId: null };

  ports.syncLeadTaskActivityForState(run, run.leadActivityState, run.leadActivityState);
  return { state: run.leadActivityState, runId };
}

export function syncLeadTaskActivityForState<TRun extends LeadActivityRunLike>(
  run: TRun,
  state: LeadActivityState,
  previousState: LeadActivityState,
  ports: LeadTaskActivityIntervalPorts<TRun>,
  at: string
): void {
  const key = getLeadTaskActivityRunKey(run);
  if (state === 'active') {
    if (ports.syncedRunKeys.has(key)) return;
    const result = ports.resumeActiveIntervalsForMember(run.teamName, ports.getRunLeadName(run), at);
    if (result.failed) return;
    ports.syncedRunKeys.add(key);
    return;
  }

  const wasSynced = ports.syncedRunKeys.has(key);
  if (previousState !== 'active' && !wasSynced) return;
  const result = ports.pauseActiveIntervalsForMember(run.teamName, ports.getRunLeadName(run), at);
  if (result.failed) {
    ports.syncedRunKeys.add(key);
    return;
  }
  ports.syncedRunKeys.delete(key);
}

export function setLeadActivity<TRun extends LeadActivityRunLike>(
  run: TRun,
  state: LeadActivityState,
  ports: SetLeadActivityPorts<TRun>
): void {
  const previousState = run.leadActivityState;
  const isCurrentRun = ports.isCurrentTrackedRun(run);
  if (isCurrentRun) {
    syncLeadTaskActivityForState(run, state, previousState, ports, ports.nowIso());
  } else {
    ports.syncedRunKeys.delete(getLeadTaskActivityRunKey(run));
  }
  if (previousState === state) return;
  run.leadActivityState = state;
  if (!isCurrentRun) return;
  ports.emitTeamChange({
    type: 'lead-activity',
    teamName: run.teamName,
    runId: run.runId,
    detail: state,
  });
}
