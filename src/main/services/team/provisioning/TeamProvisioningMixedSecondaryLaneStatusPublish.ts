import { getErrorMessage } from '@shared/utils/errorHandling';

import type { MixedSecondaryRuntimeLaneState } from './TeamProvisioningSecondaryRuntimeRuns';

export interface MixedSecondaryLaneStatusPublishPorts<TRun extends { teamName: string }> {
  publishMixedSecondaryLaneStatusChange(
    run: TRun,
    lane: MixedSecondaryRuntimeLaneState
  ): Promise<void>;
  logger: { warn(message: string): void };
}

/**
 * Publishes a lane status change without blocking the caller. The persist this triggers is
 * enqueued synchronously against the team's launch-state queue, so its FIFO position is
 * already claimed by the time this returns, and every persist rebuilds the snapshot from
 * live run state and re-checks run authority when it executes — so not awaiting this cannot
 * reorder writes or resurrect stale state, it only removes the artificial wait on lane
 * progress. A rejection here must not fail the caller: it is logged and dropped, so a
 * cosmetic status-broadcast failure never turns an otherwise-successful lane launch into a
 * crashed one.
 */
export type MixedSecondaryLaneStatusPublishStage =
  | 'adapter-missing'
  | 'setup'
  | 'finished'
  | 'shared-runtime-blocked'
  | 'crash';

export function publishMixedSecondaryLaneStatusInBackground<TRun extends { teamName: string }>(
  run: TRun,
  lane: MixedSecondaryRuntimeLaneState,
  ports: MixedSecondaryLaneStatusPublishPorts<TRun>,
  stage: MixedSecondaryLaneStatusPublishStage
): void {
  const report = (error: unknown): void =>
    ports.logger.warn(
      `[${run.teamName}] OpenCode secondary lane ${lane.laneId} status publish failed (${stage}): ${getErrorMessage(error)}`
    );
  // Calling the port directly (not deferred) keeps the enqueue synchronous, which is what
  // the FIFO ordering guarantee above depends on. Ports are expected to always return a
  // promise, per the type above, never throw synchronously.
  void ports.publishMixedSecondaryLaneStatusChange(run, lane).catch(report);
}
