import { parseTeamId } from '@shared/contracts/hosted';

import {
  admitLegacyRuntimeOperation,
  applyCurrentRunStatus,
  applyLifecycleLaneObservation,
  completeLegacyRuntimeCutover,
  isCurrentLifecycleRun,
  isStartedLifecycleLane,
  isTerminalLifecycleRun,
  lifecycleRunRef,
  lifecycleRunStatusView,
  replaceLegacyRuntimeCutover,
  updateLegacyRuntimeGeneration,
} from '../domain';

import {
  claimLifecycleLaneEffect,
  resumeLifecycleLaunchEffects,
  settleLifecycleLaneEffect,
} from './LaunchTeam';

import type { GetProvisioningStatusRequest, GetProvisioningStatusResult } from '../../contracts';
import type { LifecycleLaneCoordinator } from './LifecycleLaneCoordinator';
import type {
  LegacyRuntimeDrainPort,
  LifecycleLaneEffectRecord,
  LifecycleLaneEffectSettlement,
  TeamLifecycleClockPort,
  TeamLifecycleCommandContext,
  TeamLifecycleCommandSnapshot,
  TeamLifecycleCommandStatePort,
  TeamLifecycleIdFactoryPort,
  TeamLifecycleOutboxEvent,
} from './ports/TeamLifecycleCommandPorts';

type LifecycleExitOutcome = 'success' | 'failure' | 'unknown';

export interface GetProvisioningStatusDependencies {
  readonly state: TeamLifecycleCommandStatePort;
  readonly lanes: LifecycleLaneCoordinator;
  readonly legacyRuntime: LegacyRuntimeDrainPort;
  readonly clock: TeamLifecycleClockPort;
  readonly ids: TeamLifecycleIdFactoryPort;
}

export class GetProvisioningStatus {
  constructor(private readonly dependencies: GetProvisioningStatusDependencies) {}

  async execute(
    request: GetProvisioningStatusRequest,
    context: TeamLifecycleCommandContext
  ): Promise<GetProvisioningStatusResult> {
    if (
      request.schemaVersion !== 1 ||
      !Number.isSafeInteger(request.runRef.generation) ||
      request.runRef.generation < 1
    ) {
      return { status: 'rejected', reason: 'invalid_request' };
    }
    try {
      parseTeamId(request.teamId);
    } catch {
      return { status: 'rejected', reason: 'invalid_request' };
    }
    const loaded = await this.dependencies.state.load(request.teamId);
    if (loaded.status === 'missing') return { status: 'rejected', reason: 'not_found' };
    if (loaded.status === 'unavailable') return { status: 'rejected', reason: 'unavailable' };
    if (loaded.snapshot.lifecycle.deploymentId !== context.deploymentId) {
      return { status: 'rejected', reason: 'not_found' };
    }
    if (loaded.snapshot.lifecycle.cutover.mode === 'legacy_drain') {
      return await this.readLegacy(request, loaded.snapshot);
    }
    if (
      !isCurrentLifecycleRun(loaded.snapshot.lifecycle, request.runRef) ||
      loaded.snapshot.currentRun?.runId !== request.runRef.runId
    ) {
      return { status: 'rejected', reason: 'stale_generation' };
    }
    if (isTerminalLifecycleRun(loaded.snapshot.currentRun)) {
      return { status: 'current', run: lifecycleRunStatusView(loaded.snapshot.currentRun) };
    }

    let snapshot = loaded.snapshot;
    const initialRun = snapshot.currentRun;
    if (!initialRun) return { status: 'rejected', reason: 'unavailable' };
    for (const lane of initialRun.lanes) {
      const currentRun = snapshot.currentRun;
      const currentLane = currentRun?.lanes.find((candidate) => candidate.laneId === lane.laneId);
      if (
        !currentRun ||
        !currentLane ||
        !isStartedLifecycleLane(currentLane) ||
        currentLane.status === 'stopped' ||
        currentLane.status === 'cancelled' ||
        currentLane.status === 'failed'
      ) {
        continue;
      }
      const observed = await this.dependencies.lanes.observe(
        currentRun,
        currentLane.laneId,
        currentLane.executionRef!
      );
      if (
        observed.status === 'exited' &&
        (currentRun.activeIntent === 'cancel' || currentRun.activeIntent === 'stop')
      ) {
        snapshot = await this.settleActiveDrainObservation(
          snapshot,
          currentLane.laneId,
          observed.outcome,
          context
        );
        continue;
      }
      const nextRun = applyLifecycleLaneObservation(currentRun, currentLane.laneId, observed);
      const saved = await this.saveRun(snapshot, nextRun, 'team-lifecycle.lane-status-observed');
      if (!saved) {
        return { status: 'rejected', reason: 'concurrency_conflict' };
      }
      snapshot = saved;
    }

    snapshot = await resumeLifecycleLaunchEffects(this.dependencies, snapshot, context);
    if (!snapshot.currentRun) return { status: 'rejected', reason: 'unavailable' };
    return { status: 'current', run: lifecycleRunStatusView(snapshot.currentRun) };
  }

  private async settleActiveDrainObservation(
    initial: TeamLifecycleCommandSnapshot,
    laneId: LifecycleLaneEffectRecord['laneId'],
    outcome: LifecycleExitOutcome,
    context: TeamLifecycleCommandContext
  ): Promise<TeamLifecycleCommandSnapshot> {
    let snapshot = initial;
    let effect = latestDrainOrRecoveryEffect(snapshot, laneId);
    let lease = effect?.lease ?? null;
    if (effect && effect.state !== 'observed_succeeded' && !lease) {
      const claimed = await claimLifecycleLaneEffect(this.dependencies, snapshot, effect, context);
      if ('snapshot' in claimed) snapshot = claimed.snapshot;
      if (claimed.status === 'claimed') {
        effect = claimed.effect;
        lease = effect.lease;
      }
    }
    const run = snapshot.currentRun;
    if (!run) return snapshot;
    const nextRun = applyLifecycleLaneObservation(run, laneId, {
      status: 'exited',
      outcome,
    });
    if (effect && effect.state !== 'observed_succeeded' && lease) {
      const diagnostic =
        nextRun.lanes.find((lane) => lane.laneId === laneId)?.diagnostic ??
        'runtime-exit-during-active-drain-ambiguous';
      const settlement = {
        state: 'ambiguous',
        evidence: Object.freeze({
          schemaVersion: 1,
          kind: 'ambiguous_evidence',
          operationId: effect.operationId,
          leaseFence: lease.fence,
          observedAtIso: this.dependencies.clock.nowIso(),
          diagnostic,
        }),
      } satisfies LifecycleLaneEffectSettlement;
      const settled = await settleLifecycleLaneEffect(
        this.dependencies,
        snapshot,
        effect,
        lease,
        settlement,
        nextRun,
        'team-lifecycle.lane-terminal-observation-ambiguous'
      );
      if (settled) return settled;
    }
    return (
      (await this.saveRun(
        snapshot,
        nextRun,
        'team-lifecycle.lane-terminal-observation-unsettled'
      )) ?? snapshot
    );
  }

  private async readLegacy(
    request: GetProvisioningStatusRequest,
    snapshot: TeamLifecycleCommandSnapshot
  ): Promise<GetProvisioningStatusResult> {
    const admission = admitLegacyRuntimeOperation(
      snapshot.lifecycle.cutover,
      request.runRef.generation,
      'status'
    );
    if (admission.status === 'rejected') {
      return { status: 'rejected', reason: admission.reason };
    }
    let observed;
    try {
      observed = await this.dependencies.legacyRuntime.status({
        teamId: request.teamId,
        generation: request.runRef.generation,
      });
    } catch {
      return { status: 'rejected', reason: 'unavailable' };
    }
    if (observed.status !== 'observed') {
      return { status: 'rejected', reason: 'unavailable' };
    }
    let cutover = updateLegacyRuntimeGeneration(
      snapshot.lifecycle.cutover,
      request.runRef.generation,
      observed.state,
      observed.cleanupVerified
    );
    if (observed.state === 'terminal' && observed.cleanupVerified) {
      cutover = completeLegacyRuntimeCutover(cutover, request.runRef.generation);
    }
    const nextLifecycle = replaceLegacyRuntimeCutover(snapshot.lifecycle, cutover);
    const saved = await this.dependencies.state.saveLegacyProgress({
      expectedLifecycleRevision: snapshot.lifecycle.revision,
      generation: request.runRef.generation,
      nextLifecycle,
      outbox: this.event(
        'team-lifecycle.legacy-status-observed',
        nextLifecycle,
        request.runRef.generation,
        observed.state
      ),
    });
    if (saved.status !== 'committed') {
      return {
        status: 'rejected',
        reason:
          saved.status === 'stale_generation'
            ? 'stale_generation'
            : saved.status === 'concurrency_conflict'
              ? 'concurrency_conflict'
              : 'unavailable',
      };
    }
    return {
      status: 'legacy',
      generation: request.runRef.generation,
      lifecycle: observed.state,
    };
  }

  private async saveRun(
    snapshot: TeamLifecycleCommandSnapshot,
    nextRun: NonNullable<TeamLifecycleCommandSnapshot['currentRun']>,
    eventType: string
  ): Promise<TeamLifecycleCommandSnapshot | null> {
    const currentRun = snapshot.currentRun;
    const receipt = snapshot.lifecycle.writerBarrierReceipt;
    if (!currentRun || !receipt) return null;
    const nextLifecycle = applyCurrentRunStatus(
      snapshot.lifecycle,
      lifecycleRunRef(currentRun),
      nextRun.status
    );
    const saved = await this.dependencies.state.saveRunProgress({
      expectedLifecycleRevision: snapshot.lifecycle.revision,
      expectedRunRevision: currentRun.revision,
      runRef: lifecycleRunRef(currentRun),
      nextLifecycle,
      nextRun,
      expectedWriterBarrierReceipt: receipt,
      outbox: this.event(eventType, nextLifecycle, nextRun.generation, nextRun.status),
    });
    return saved.status === 'committed' ? saved.snapshot : null;
  }

  private event(
    eventType: string,
    lifecycle: TeamLifecycleCommandSnapshot['lifecycle'],
    generation: number,
    state: string
  ): TeamLifecycleOutboxEvent {
    return Object.freeze({
      eventId: this.dependencies.ids.createEventId(),
      eventType,
      scopeKind: 'team',
      scopeId: lifecycle.teamId,
      schemaVersion: 1,
      semanticRevision: lifecycle.revision,
      payloadJson: JSON.stringify({ generation, state }),
      createdAtIso: this.dependencies.clock.nowIso(),
    });
  }
}

function latestDrainOrRecoveryEffect(
  snapshot: TeamLifecycleCommandSnapshot,
  laneId: LifecycleLaneEffectRecord['laneId']
): LifecycleLaneEffectRecord | null {
  const run = snapshot.currentRun;
  if (!run) return null;
  return snapshot.laneEffects.reduce<LifecycleLaneEffectRecord | null>((latest, effect) => {
    if (
      effect.laneId !== laneId ||
      (effect.kind !== 'drain' && effect.kind !== 'recover') ||
      effect.runRef.runId !== run.runId ||
      effect.runRef.generation !== run.generation
    ) {
      return latest;
    }
    return !latest || effect.leaseFence >= latest.leaseFence ? effect : latest;
  }, null);
}
