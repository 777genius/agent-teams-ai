import { getErrorMessage } from '@shared/utils/errorHandling';

import { classifyOpenCodePrimaryLeadBootstrap } from './TeamProvisioningOpenCodeAggregateLaunchPromotion';

import type { TeamLaunchRuntimeAdapter, TeamRuntimeLaunchResult } from '../runtime';
import type { PersistedTeamLaunchPhase, TeamCreateRequest } from '@shared/types';

/**
 * In-place re-bootstrap of the OpenCode lead lane.
 *
 * NOT `restartMember`: its primary path migrates the member into a secondary
 * lane (`migrated_from_failed_primary_lane`), which for a lead-only primary lane
 * empties `effectiveMembers`, makes the primary launch return null and throws -
 * the app already reports `restartable: false` for the lead. This reuses the
 * rollback-relaunch shape instead: stop the primary lane, relaunch it with an
 * empty prompt, and require committed lead evidence before claiming success.
 *
 * The secondary lanes are never touched, so teammates keep their sessions.
 */
export interface OpenCodePrimaryLaneRebootstrapRun {
  runId: string;
  teamName: string;
  request: TeamCreateRequest;
  effectiveMembers: TeamCreateRequest['members'];
  processKilled?: boolean;
  cancelRequested?: boolean;
}

export type OpenCodePrimaryLaneRebootstrapRefusal =
  | 'manual_restart_in_flight'
  | 'primary_stop_in_flight'
  | 'team_stopped'
  | 'stop_generation_changed'
  | 'runtime_not_deliverable'
  | 'no_active_run'
  | 'adapter_unavailable'
  | 'lead_evidence_still_missing'
  | 'relaunch_failed';

export interface OpenCodePrimaryLaneRebootstrapResult {
  rebootstrapped: boolean;
  refusal?: OpenCodePrimaryLaneRebootstrapRefusal;
}

export interface OpenCodePrimaryLaneRebootstrapPorts {
  getAdapter(): TeamLaunchRuntimeAdapter | null;
  resolveActiveRun(teamName: string): OpenCodePrimaryLaneRebootstrapRun | null;
  hasManualRestartInFlight(teamName: string): boolean;
  hasPrimaryStopInFlight(teamName: string): boolean;
  isStopped(teamName: string): Promise<boolean>;
  getStopAllTeamsGeneration(): number;
  getStopTeamGeneration(teamName: string): number;
  canDeliverToOpenCodeRuntime(teamName: string): boolean;
  stopOpenCodeRuntimeAdapterTeam(teamName: string, runId: string): Promise<void>;
  setAliveRunId(teamName: string, runId: string): void;
  launchOpenCodeAggregatePrimaryLane(input: {
    run: OpenCodePrimaryLaneRebootstrapRun;
    adapter: TeamLaunchRuntimeAdapter;
    prompt: string;
  }): Promise<TeamRuntimeLaunchResult | null>;
  hasCommittedLeadSessionEvidence(input: {
    teamName: string;
    runId: string;
    memberName: string;
  }): Promise<boolean>;
  persistLaunchStateSnapshot(
    run: OpenCodePrimaryLaneRebootstrapRun,
    launchPhase: PersistedTeamLaunchPhase
  ): Promise<unknown>;
  getMixedSecondaryLaunchPhase(run: OpenCodePrimaryLaneRebootstrapRun): PersistedTeamLaunchPhase;
  /** Mirrors `beginAggregatePrimaryRestart`: a manual restart may not overlap. */
  beginRebootstrapLease(
    teamName: string,
    memberName: string,
    runId: string
  ): { lease: { cancelRequested?: boolean }; release(): void };
  publishPending(run: OpenCodePrimaryLaneRebootstrapRun, message: string): void;
  publishReady(run: OpenCodePrimaryLaneRebootstrapRun, message: string): void;
  publishFailed(run: OpenCodePrimaryLaneRebootstrapRun, message: string, error: unknown): void;
  logWarn(message: string): void;
  resolveLeadName(run: OpenCodePrimaryLaneRebootstrapRun): string;
}

export async function rebootstrapOpenCodeAggregatePrimaryLane(
  params: { teamName: string; reason: string },
  ports: OpenCodePrimaryLaneRebootstrapPorts
): Promise<OpenCodePrimaryLaneRebootstrapResult> {
  const { teamName } = params;
  const refuse = (
    refusal: OpenCodePrimaryLaneRebootstrapRefusal
  ): OpenCodePrimaryLaneRebootstrapResult => {
    ports.logWarn(
      `[${teamName}] opencode_primary_lane_rebootstrap_refused reason=${params.reason} refusal=${refusal}`
    );
    return { rebootstrapped: false, refusal };
  };

  if (ports.hasManualRestartInFlight(teamName)) return refuse('manual_restart_in_flight');
  if (ports.hasPrimaryStopInFlight(teamName)) return refuse('primary_stop_in_flight');
  if (!ports.canDeliverToOpenCodeRuntime(teamName)) return refuse('runtime_not_deliverable');
  if (await ports.isStopped(teamName)) return refuse('team_stopped');

  const run = ports.resolveActiveRun(teamName);
  if (!run || run.processKilled === true || run.cancelRequested === true) {
    return refuse('no_active_run');
  }
  const adapter = ports.getAdapter();
  if (!adapter) return refuse('adapter_unavailable');

  const stopAllGenerationAtStart = ports.getStopAllTeamsGeneration();
  const stopTeamGenerationAtStart = ports.getStopTeamGeneration(teamName);
  const stopRequested = (): boolean =>
    ports.getStopAllTeamsGeneration() !== stopAllGenerationAtStart ||
    ports.getStopTeamGeneration(teamName) !== stopTeamGenerationAtStart ||
    run.processKilled === true ||
    run.cancelRequested === true;

  /**
   * A refusal AFTER the relaunch owns a freshly created host and session. The
   * trigger is automatic and the caller never awaits it, so a Stop that lands
   * during the relaunch would otherwise leave that host running on a team the
   * user believes is stopped - and `setAliveRunId` would have re-marked the
   * stopped run alive. The team-scoped stop is the same call the manual-restart
   * path reuses: it reaps the lane, clears its runtime storage and drops both
   * the runtime owner and the alive run id, so nothing of the refused relaunch
   * survives.
   */
  const reapRelaunchedPrimaryLane = async (): Promise<void> => {
    await ports.stopOpenCodeRuntimeAdapterTeam(teamName, run.runId).catch((error: unknown) => {
      ports.logWarn(
        `[${teamName}] opencode_primary_lane_rebootstrap_cleanup_failed run=${run.runId} ` +
          `error=${getErrorMessage(error)}`
      );
    });
  };

  const leadName = ports.resolveLeadName(run);
  const lease = ports.beginRebootstrapLease(teamName, leadName, run.runId);
  try {
    ports.publishPending(run, 'Re-bootstrapping the OpenCode lead lane');
    // The lease is never held across the relaunch: a leaked lease deadlocks
    // every teammate delivery, so each stage re-reads the stop generation
    // instead of trusting a claim it made before it started.
    if (stopRequested() || lease.lease.cancelRequested) {
      return refuse('stop_generation_changed');
    }

    await ports.stopOpenCodeRuntimeAdapterTeam(teamName, run.runId);
    if (stopRequested() || lease.lease.cancelRequested) {
      return refuse('stop_generation_changed');
    }
    ports.setAliveRunId(teamName, run.runId);

    /**
     * Every stage past the relaunch owns a host, so its fence reaps before it
     * refuses.
     */
    const reapAndRefuseWhenStopped =
      async (): Promise<OpenCodePrimaryLaneRebootstrapResult | null> => {
        if (!stopRequested() && !lease.lease.cancelRequested) {
          return null;
        }
        await reapRelaunchedPrimaryLane();
        return refuse('stop_generation_changed');
      };

    const result = await ports.launchOpenCodeAggregatePrimaryLane({ run, adapter, prompt: '' });
    const stoppedAfterRelaunch = await reapAndRefuseWhenStopped();
    if (stoppedAfterRelaunch) {
      return stoppedAfterRelaunch;
    }
    // `null`, not `false`: the classifier takes `false` as proof that no
    // session was committed and takes `null` as the read having failed, which
    // may not downgrade a lane whose launch already claims it is confirmed.
    // Collapsing the two reaped a correctly bootstrapped lead over an I/O
    // hiccup in the evidence store and burnt a self-heal attempt doing it.
    const committed = await ports
      .hasCommittedLeadSessionEvidence({ teamName, runId: run.runId, memberName: leadName })
      .catch(() => null);
    const leadBootstrap = classifyOpenCodePrimaryLeadBootstrap({
      leadName,
      primaryResult: result,
      committedSessionEvidence: committed,
    });
    if (leadBootstrap !== 'confirmed') {
      await reapRelaunchedPrimaryLane();
      ports.publishFailed(
        run,
        'OpenCode lead lane re-bootstrap did not produce a usable lead',
        new Error(`OpenCode lead "${leadName}" still has no committed runtime session`)
      );
      return refuse('lead_evidence_still_missing');
    }

    /**
     * The persist is fenced on both sides. An `active` snapshot is a
     * launch-start write, and `TeamLaunchStateStore.writeNow` lifts
     * `launch-stopped.json` for one, so a stop that settled while the evidence
     * read was in flight must not reach the write at all. A stop that settles
     * during the write must not go on to re-mark the run alive and publish
     * `ready` for a team the user stopped. This is the same order the manual
     * restart uses around its own persist.
     */
    const stoppedBeforePersist = await reapAndRefuseWhenStopped();
    if (stoppedBeforePersist) {
      return stoppedBeforePersist;
    }
    try {
      await ports.persistLaunchStateSnapshot(run, ports.getMixedSecondaryLaunchPhase(run));
    } catch (persistError) {
      // The relaunched host outlives a failed persist otherwise: the catch
      // below reports `relaunch_failed` without reaping anything.
      await reapRelaunchedPrimaryLane();
      throw persistError;
    }
    const stoppedAfterPersist = await reapAndRefuseWhenStopped();
    if (stoppedAfterPersist) {
      return stoppedAfterPersist;
    }
    ports.setAliveRunId(teamName, run.runId);
    ports.publishReady(run, 'OpenCode lead lane was re-bootstrapped');
    return { rebootstrapped: true };
  } catch (error) {
    ports.publishFailed(run, 'OpenCode lead lane re-bootstrap failed', error);
    ports.logWarn(
      `[${teamName}] opencode_primary_lane_rebootstrap_failed reason=${params.reason} ` +
        `error=${getErrorMessage(error)}`
    );
    return { rebootstrapped: false, refusal: 'relaunch_failed' };
  } finally {
    lease.release();
  }
}
