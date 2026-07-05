import {
  type MixedSecondaryLaneLaunchSetupPorts,
  type MixedSecondaryLaneLaunchSetupRun,
  setupMixedSecondaryLaneLaunch,
} from './TeamProvisioningMixedSecondaryLaneLaunchSetup';
import {
  appendDiagnosticOnce,
  collectOpenCodeSecondaryLaneFailureDiagnostics,
  isDefinitiveOpenCodePreLaunchFailure,
  isRecoverableOpenCodeBootstrapPendingLaunchResult,
  normalizeRecoverableOpenCodeBootstrapPendingLaunchResult,
} from './TeamProvisioningOpenCodeRuntimeEvidencePolicy';

import type {
  TeamRuntimeLaunchResult,
  TeamRuntimeMemberLaunchEvidence,
  TeamRuntimeMemberSpec,
} from '../runtime/TeamRuntimeAdapter';
import type { MixedSecondaryRuntimeLaneState } from './TeamProvisioningSecondaryRuntimeRuns';
import type { TeamCreateRequest } from '@shared/types';

export interface MixedSecondaryLaneLaunchFlowRun extends MixedSecondaryLaneLaunchSetupRun {
  request: Pick<TeamCreateRequest, 'cwd' | 'skipPermissions' | 'color' | 'displayName'>;
}

export interface MixedSecondaryLaneLaunchFlowPorts<
  TRun extends MixedSecondaryLaneLaunchFlowRun,
> extends MixedSecondaryLaneLaunchSetupPorts<TRun> {
  prepareOpenCodeRuntimeLaneForLaunchGeneration(input: {
    teamsBasePath: string;
    teamName: string;
    laneId: string;
    runId: string;
    reason: 'mixed_secondary_launch' | 'mixed_secondary_launch_stale_manifest_recovery';
    forceReset?: boolean;
  }): Promise<{ diagnostics: string[] }>;
  buildOpenCodeSecondaryAppManagedLaunchPrompt(
    run: TRun,
    lane: MixedSecondaryRuntimeLaneState
  ): Promise<string>;
  guardCommittedOpenCodeSecondaryLaneEvidence(input: {
    teamName: string;
    laneId: string;
    memberName: string;
    result: TeamRuntimeLaunchResult;
  }): Promise<TeamRuntimeLaunchResult>;
  syncOpenCodeRuntimeToolApprovals(input: {
    teamName: string;
    runId: string;
    laneId: string;
    cwd: string;
    members: Record<string, TeamRuntimeMemberLaunchEvidence>;
    expectedMembers: TeamRuntimeMemberSpec[];
    teamColor?: string;
    teamDisplayName?: string;
  }): void;
}

export async function launchSingleMixedSecondaryLaneWithPorts<
  TRun extends MixedSecondaryLaneLaunchFlowRun,
>(
  run: TRun,
  lane: MixedSecondaryRuntimeLaneState,
  ports: MixedSecondaryLaneLaunchFlowPorts<TRun>
): Promise<void> {
  const setup = await setupMixedSecondaryLaneLaunch(run, lane, ports);
  if (setup.outcome !== 'ready') {
    return;
  }
  const {
    adapter,
    finishCancelledLane,
    laneCwd,
    laneRunId,
    migration,
    previousLaunchState,
    requestedDiagnostics,
    shouldAbortLaunch,
  } = setup;

  try {
    if (shouldAbortLaunch()) {
      await finishCancelledLane();
      return;
    }
    await ports.prepareOpenCodeRuntimeLaneForLaunchGeneration({
      teamsBasePath: ports.teamsBasePath(),
      teamName: run.teamName,
      laneId: lane.laneId,
      runId: laneRunId,
      reason: 'mixed_secondary_launch',
    });
    if (shouldAbortLaunch()) {
      await finishCancelledLane();
      return;
    }
    const appManagedLaunchPrompt = await ports.buildOpenCodeSecondaryAppManagedLaunchPrompt(
      run,
      lane
    );
    if (shouldAbortLaunch()) {
      await finishCancelledLane();
      return;
    }
    const laneExpectedMembers: TeamRuntimeMemberSpec[] = [
      {
        name: lane.member.name,
        role: lane.member.role,
        workflow: lane.member.workflow,
        isolation: lane.member.isolation === 'worktree' ? ('worktree' as const) : undefined,
        providerId: 'opencode',
        model: lane.member.model,
        effort: lane.member.effort,
        cwd: laneCwd,
      },
    ];
    const launchOpenCodeLane = () =>
      adapter.launch({
        runId: laneRunId,
        laneId: lane.laneId,
        teamName: run.teamName,
        cwd: laneCwd,
        prompt: appManagedLaunchPrompt,
        providerId: 'opencode',
        model: lane.member.model,
        effort: lane.member.effort,
        runtimeOnly: true,
        skipPermissions: run.request.skipPermissions !== false,
        expectedMembers: laneExpectedMembers,
        previousLaunchState,
      });
    let rawResult: TeamRuntimeLaunchResult;
    try {
      rawResult = await launchOpenCodeLane();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const staleManifestMessage = 'Bridge server runtime manifest high watermark is stale';
      if (
        message !== staleManifestMessage &&
        message !== `OpenCode bridge failed: ${staleManifestMessage}`
      ) {
        throw error;
      }
      if (shouldAbortLaunch()) {
        await finishCancelledLane();
        return;
      }
      const recovery = await ports.prepareOpenCodeRuntimeLaneForLaunchGeneration({
        teamsBasePath: ports.teamsBasePath(),
        teamName: run.teamName,
        laneId: lane.laneId,
        runId: laneRunId,
        reason: 'mixed_secondary_launch_stale_manifest_recovery',
        forceReset: true,
      });
      lane.diagnostics = appendDiagnosticOnce(
        [...lane.diagnostics, ...recovery.diagnostics],
        'Retried OpenCode secondary launch after resetting stale runtime manifest.'
      );
      if (shouldAbortLaunch()) {
        await finishCancelledLane();
        return;
      }
      rawResult = await launchOpenCodeLane();
    }
    if (shouldAbortLaunch()) {
      await finishCancelledLane();
      return;
    }
    // Treat the bridge result as provisional. The guard below is the single
    // promotion gate that turns app-managed OpenCode bootstrap into
    // confirmed_alive only after durable lane evidence exists on disk.
    const result = await ports.guardCommittedOpenCodeSecondaryLaneEvidence({
      teamName: run.teamName,
      laneId: lane.laneId,
      memberName: lane.member.name,
      result: rawResult,
    });
    if (shouldAbortLaunch()) {
      await finishCancelledLane();
      return;
    }
    lane.launchFinishedAtMs = ports.nowMs();
    const timingDiagnostic = ports.buildOpenCodeSecondaryLaneTimingDiagnostic(lane);
    const memberEvidence = result.members[lane.member.name];
    const resultWithTiming: TeamRuntimeLaunchResult = timingDiagnostic
      ? {
          ...result,
          diagnostics: appendDiagnosticOnce(result.diagnostics, timingDiagnostic),
          members: {
            ...result.members,
            ...(memberEvidence
              ? {
                  [lane.member.name]: {
                    ...memberEvidence,
                    diagnostics: appendDiagnosticOnce(
                      memberEvidence.diagnostics ?? [],
                      timingDiagnostic
                    ),
                  },
                }
              : {}),
          },
        }
      : result;
    const baseFailureDiagnostics = appendDiagnosticOnce(
      [...requestedDiagnostics, ...migration.diagnostics],
      timingDiagnostic
    );
    const recoverableBootstrapPending = isRecoverableOpenCodeBootstrapPendingLaunchResult(
      resultWithTiming,
      lane.member.name
    );
    const normalizedResult = recoverableBootstrapPending
      ? normalizeRecoverableOpenCodeBootstrapPendingLaunchResult(
          resultWithTiming,
          lane.member.name,
          baseFailureDiagnostics
        )
      : resultWithTiming;
    lane.result = normalizedResult;
    ports.syncOpenCodeRuntimeToolApprovals({
      teamName: run.teamName,
      runId: laneRunId,
      laneId: lane.laneId,
      cwd: laneCwd,
      members: normalizedResult.members,
      expectedMembers: laneExpectedMembers,
      teamColor: run.request.color,
      teamDisplayName: run.request.displayName,
    });
    lane.warnings = [...normalizedResult.warnings];
    const launchDiagnostics = appendDiagnosticOnce(
      [...requestedDiagnostics, ...migration.diagnostics, ...normalizedResult.diagnostics],
      timingDiagnostic
    );
    lane.diagnostics = launchDiagnostics;

    if (recoverableBootstrapPending) {
      await ports
        .upsertOpenCodeRuntimeLaneIndexEntry({
          teamsBasePath: ports.teamsBasePath(),
          teamName: run.teamName,
          laneId: lane.laneId,
          state: 'active',
          diagnostics: collectOpenCodeSecondaryLaneFailureDiagnostics(
            normalizedResult,
            lane.member.name,
            baseFailureDiagnostics
          ),
        })
        .catch(() => undefined);
    } else if (
      isDefinitiveOpenCodePreLaunchFailure(normalizedResult, lane.member.name) ||
      normalizedResult.teamLaunchState === 'partial_failure'
    ) {
      const diagnostics = collectOpenCodeSecondaryLaneFailureDiagnostics(
        normalizedResult,
        lane.member.name,
        baseFailureDiagnostics
      );
      await ports
        .upsertOpenCodeRuntimeLaneIndexEntry({
          teamsBasePath: ports.teamsBasePath(),
          teamName: run.teamName,
          laneId: lane.laneId,
          state: 'degraded',
          diagnostics,
        })
        .catch(() => undefined);
      ports.deleteSecondaryRuntimeRun(run.teamName, lane.laneId);
    }
  } catch (error) {
    if (shouldAbortLaunch()) {
      await finishCancelledLane();
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    lane.launchFinishedAtMs = ports.nowMs();
    const timingDiagnostic = ports.buildOpenCodeSecondaryLaneTimingDiagnostic(lane);
    lane.result = {
      runId: laneRunId,
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
          hardFailureReason: message,
          diagnostics: appendDiagnosticOnce([message], timingDiagnostic),
        },
      },
      warnings: [],
      diagnostics: appendDiagnosticOnce([message], timingDiagnostic),
    };
    lane.warnings = [];
    lane.diagnostics = appendDiagnosticOnce(
      [...requestedDiagnostics, ...migration.diagnostics, message],
      timingDiagnostic
    );
    await ports
      .upsertOpenCodeRuntimeLaneIndexEntry({
        teamsBasePath: ports.teamsBasePath(),
        teamName: run.teamName,
        laneId: lane.laneId,
        state: 'degraded',
        diagnostics: appendDiagnosticOnce([message], timingDiagnostic),
      })
      .catch(() => undefined);
    ports.deleteSecondaryRuntimeRun(run.teamName, lane.laneId);
  }

  await ports.publishMixedSecondaryLaneStatusChange(run, lane);
  lane.state = 'finished';
}
