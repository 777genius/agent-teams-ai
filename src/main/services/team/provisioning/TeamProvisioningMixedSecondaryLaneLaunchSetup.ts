import { appendDiagnosticOnce } from './TeamProvisioningOpenCodeRuntimeEvidencePolicy';

import type { TeamLaunchRuntimeAdapter } from '../runtime/TeamRuntimeAdapter';
import type { MixedSecondaryRuntimeLaneState } from './TeamProvisioningSecondaryRuntimeRuns';
import type { PersistedTeamLaunchSnapshot, TeamCreateRequest } from '@shared/types';

export interface MixedSecondaryLaneLaunchSetupRun {
  teamName: string;
  cancelRequested: boolean;
  processKilled: boolean;
  request: Pick<TeamCreateRequest, 'cwd'>;
}

export interface MixedSecondaryLaneLaunchSetupMigration {
  degraded: boolean;
  diagnostics: string[];
}

export interface MixedSecondaryLaneLaunchSetupPorts<TRun extends MixedSecondaryLaneLaunchSetupRun> {
  nowMs(): number;
  randomUuid(): string;
  teamsBasePath(): string;
  isStoppingSecondaryRuntimeTeam(teamName: string): boolean;
  clearOpenCodeRuntimeLaneStorage(input: {
    teamsBasePath: string;
    teamName: string;
    laneId: string;
  }): Promise<unknown>;
  deleteSecondaryRuntimeRun(teamName: string, laneId: string): void;
  getOpenCodeRuntimeAdapter(): TeamLaunchRuntimeAdapter | null;
  migrateLegacyOpenCodeRuntimeState(input: {
    teamsBasePath: string;
    teamName: string;
    laneId: string;
  }): Promise<MixedSecondaryLaneLaunchSetupMigration>;
  upsertOpenCodeRuntimeLaneIndexEntry(input: {
    teamsBasePath: string;
    teamName: string;
    laneId: string;
    state: 'active' | 'degraded';
    diagnostics: string[];
  }): Promise<unknown>;
  buildOpenCodeSecondaryLaneTimingDiagnostic(lane: MixedSecondaryRuntimeLaneState): string | null;
  publishMixedSecondaryLaneStatusChange(
    run: TRun,
    lane: MixedSecondaryRuntimeLaneState
  ): Promise<void>;
  readLaunchState(teamName: string): Promise<PersistedTeamLaunchSnapshot | null>;
  setSecondaryRuntimeRun(input: {
    teamName: string;
    runId: string;
    providerId: 'opencode';
    laneId: string;
    memberName: string;
    cwd: string;
  }): void;
}

export interface MixedSecondaryLaneLaunchSetupBaseResult {
  requestedDiagnostics: string[];
  shouldAbortLaunch(): boolean;
  finishCancelledLane(): Promise<void>;
}

export type MixedSecondaryLaneLaunchSetupResult =
  | (MixedSecondaryLaneLaunchSetupBaseResult & { outcome: 'cancelled' })
  | (MixedSecondaryLaneLaunchSetupBaseResult & { outcome: 'handled' })
  | (MixedSecondaryLaneLaunchSetupBaseResult & {
      outcome: 'ready';
      adapter: TeamLaunchRuntimeAdapter;
      migration: MixedSecondaryLaneLaunchSetupMigration;
      laneRunId: string;
      laneCwd: string;
      previousLaunchState: PersistedTeamLaunchSnapshot | null;
    });

export async function setupMixedSecondaryLaneLaunch<TRun extends MixedSecondaryLaneLaunchSetupRun>(
  run: TRun,
  lane: MixedSecondaryRuntimeLaneState,
  ports: MixedSecondaryLaneLaunchSetupPorts<TRun>
): Promise<MixedSecondaryLaneLaunchSetupResult> {
  lane.launchStartedAtMs = ports.nowMs();
  lane.queuedAtMs = lane.queuedAtMs ?? lane.launchStartedAtMs;
  const requestedDiagnostics = [...lane.diagnostics];
  const shouldAbortLaunch = (): boolean =>
    run.cancelRequested || run.processKilled || ports.isStoppingSecondaryRuntimeTeam(run.teamName);
  const finishCancelledLane = async (): Promise<void> => {
    await ports
      .clearOpenCodeRuntimeLaneStorage({
        teamsBasePath: ports.teamsBasePath(),
        teamName: run.teamName,
        laneId: lane.laneId,
      })
      .catch(() => undefined);
    ports.deleteSecondaryRuntimeRun(run.teamName, lane.laneId);
    lane.state = 'finished';
  };
  const baseResult = {
    requestedDiagnostics,
    shouldAbortLaunch,
    finishCancelledLane,
  };
  if (shouldAbortLaunch()) {
    await finishCancelledLane();
    return { ...baseResult, outcome: 'cancelled' };
  }
  const adapter = ports.getOpenCodeRuntimeAdapter();
  if (!adapter) {
    const message = 'OpenCode runtime adapter is not registered for mixed team launch.';
    lane.runId = lane.runId ?? ports.randomUuid();
    lane.launchFinishedAtMs = ports.nowMs();
    const timingDiagnostic = ports.buildOpenCodeSecondaryLaneTimingDiagnostic(lane);
    lane.state = 'finished';
    lane.result = {
      runId: lane.runId,
      teamName: run.teamName,
      launchPhase: 'finished',
      teamLaunchState: 'partial_failure',
      members: {
        [lane.member.name]: {
          memberName: lane.member.name,
          providerId: 'opencode',
          launchState: 'failed_to_start',
          agentToolAccepted: false,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: true,
          hardFailureReason: 'opencode_runtime_adapter_missing',
          diagnostics: appendDiagnosticOnce([message], timingDiagnostic),
        },
      },
      warnings: [],
      diagnostics: appendDiagnosticOnce([...requestedDiagnostics, message], timingDiagnostic),
    };
    lane.warnings = [];
    lane.diagnostics = appendDiagnosticOnce([...requestedDiagnostics, message], timingDiagnostic);
    await ports.publishMixedSecondaryLaneStatusChange(run, lane);
    lane.state = 'finished';
    return { ...baseResult, outcome: 'handled' };
  }

  const migration = await ports.migrateLegacyOpenCodeRuntimeState({
    teamsBasePath: ports.teamsBasePath(),
    teamName: run.teamName,
    laneId: lane.laneId,
  });
  if (shouldAbortLaunch()) {
    await finishCancelledLane();
    return { ...baseResult, outcome: 'cancelled' };
  }
  await ports.upsertOpenCodeRuntimeLaneIndexEntry({
    teamsBasePath: ports.teamsBasePath(),
    teamName: run.teamName,
    laneId: lane.laneId,
    state: migration.degraded ? 'degraded' : 'active',
    diagnostics: migration.diagnostics,
  });
  if (shouldAbortLaunch()) {
    await finishCancelledLane();
    return { ...baseResult, outcome: 'cancelled' };
  }

  lane.state = 'launching';
  lane.runId = lane.runId ?? ports.randomUuid();
  const laneRunId = lane.runId;
  lane.warnings = [];
  lane.diagnostics = [...requestedDiagnostics, ...migration.diagnostics];
  const laneCwd = lane.member.cwd?.trim() || run.request.cwd;
  ports.setSecondaryRuntimeRun({
    teamName: run.teamName,
    runId: laneRunId,
    providerId: 'opencode',
    laneId: lane.laneId,
    memberName: lane.member.name,
    cwd: laneCwd,
  });
  await ports.publishMixedSecondaryLaneStatusChange(run, lane);
  const previousLaunchState = await ports.readLaunchState(run.teamName);

  return {
    ...baseResult,
    outcome: 'ready',
    adapter,
    migration,
    laneRunId,
    laneCwd,
    previousLaunchState,
  };
}
