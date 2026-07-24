import { parseTeamId } from '@shared/contracts/hosted';

import {
  admitLegacyRuntimeOperation,
  applyCurrentRunStatus,
  applyLifecycleLaneRecovery,
  beginLifecycleRunIntent,
  completeLegacyRuntimeCutover,
  isCurrentLifecycleRun,
  isTerminalLifecycleRun,
  lifecycleRunStatusView,
  replaceLegacyRuntimeCutover,
  updateLegacyRuntimeGeneration,
} from '../domain';

import {
  claimedOutcomeMatchesRunRef,
  createLifecycleLaneEffects,
  type LegacyRuntimeDrainPort,
  type LifecycleLaneEffectEvidenceOf,
  type LifecycleLaneEffectLease,
  type LifecycleLaneEffectRecord,
  type LifecycleLaneEffectSettlement,
  prepareTeamLifecycleDurableClaim,
  type SettleCausalLifecycleLaneEffectRequest,
  type TeamLifecycleClaimedOutcome,
  type TeamLifecycleClockPort,
  type TeamLifecycleCommandContext,
  type TeamLifecycleCommandFingerprintPort,
  type TeamLifecycleCommandSnapshot,
  type TeamLifecycleCommandStatePort,
  type TeamLifecycleIdFactoryPort,
  type TeamLifecycleOutboxEvent,
} from './ports/TeamLifecycleCommandPorts';
import {
  claimLifecycleLaneEffect,
  type LifecycleLaunchWorkflowDependencies,
  resumeLifecycleLaunchEffects,
  settleLifecycleLaneEffect,
} from './LaunchTeam';
import { type LifecycleDrainDependencies, resumeLifecycleDrainEffects } from './StopTeam';

import type {
  RecoverTeamRunRequest,
  RecoverTeamRunResult,
  TeamLifecycleCommandRejectionReason,
} from '../../contracts';
import type { LifecycleLaneCoordinator } from './LifecycleLaneCoordinator';

export interface RecoverTeamRunDependencies
  extends LifecycleLaunchWorkflowDependencies, LifecycleDrainDependencies {
  readonly state: TeamLifecycleCommandStatePort;
  readonly fingerprint: TeamLifecycleCommandFingerprintPort;
  readonly lanes: LifecycleLaneCoordinator;
  readonly legacyRuntime: LegacyRuntimeDrainPort;
  readonly clock: TeamLifecycleClockPort;
  readonly ids: TeamLifecycleIdFactoryPort;
}

export class RecoverTeamRun {
  constructor(private readonly dependencies: RecoverTeamRunDependencies) {}

  async execute(
    request: RecoverTeamRunRequest,
    context: TeamLifecycleCommandContext
  ): Promise<RecoverTeamRunResult> {
    const invalid = validateRequest(request);
    if (invalid) return { status: 'rejected', reason: invalid };
    if (isCancelled(context)) return { status: 'rejected', reason: 'cancelled' };

    let claim;
    try {
      claim = await prepareTeamLifecycleDurableClaim(
        'team_lifecycle.recover',
        request,
        context,
        request.runRef,
        this.dependencies.fingerprint
      );
    } catch {
      return { status: 'rejected', reason: 'invalid_request' };
    }
    if (!claim) return { status: 'rejected', reason: 'unavailable' };
    const prior = await this.dependencies.state.resolveClaim(claim);
    if (prior.status === 'idempotency_conflict') {
      return { status: 'rejected', reason: 'idempotency_conflict' };
    }
    if (prior.status === 'unavailable') return { status: 'rejected', reason: 'unavailable' };
    if (prior.status === 'replayed') {
      if (!claimedOutcomeMatchesRunRef(prior.outcome, claim.targetRunRef)) {
        return { status: 'rejected', reason: 'stale_generation' };
      }
      return this.replay(prior.outcome);
    }

    const loaded = await this.dependencies.state.load(request.teamId);
    if (loaded.status === 'missing') return { status: 'rejected', reason: 'not_found' };
    if (loaded.status === 'unavailable') return { status: 'rejected', reason: 'unavailable' };
    const snapshot = loaded.snapshot;
    if (snapshot.lifecycle.deploymentId !== context.deploymentId) {
      return { status: 'rejected', reason: 'not_found' };
    }
    if (snapshot.lifecycle.revision !== request.expectedLifecycleRevision) {
      return { status: 'rejected', reason: 'stale_revision' };
    }
    if (snapshot.lifecycle.cutover.mode === 'legacy_drain') {
      return await this.recoverLegacy(request, context, snapshot, claim);
    }
    if (
      !isCurrentLifecycleRun(snapshot.lifecycle, request.runRef) ||
      snapshot.currentRun?.runId !== request.runRef.runId
    ) {
      return { status: 'rejected', reason: 'stale_generation' };
    }
    if (isTerminalLifecycleRun(snapshot.currentRun)) {
      return { status: 'rejected', reason: 'terminal_run' };
    }

    const interruptedIntent = activeIntent(snapshot.currentRun);
    const recoverableLaneIds = snapshot.currentRun.lanes
      .filter((lane) => !isTerminalLane(lane.status))
      .map((lane) => lane.laneId);
    const causalEffects = latestLaneEffects(snapshot, recoverableLaneIds);
    const unsettledEffects = unsettledLaneEffects(snapshot, recoverableLaneIds);
    const replayableEffects = replayableProviderEffects(causalEffects);
    const replayableLaneIds = new Set([
      ...replayableEffects.launchLaneIds,
      ...replayableEffects.drainLaneIds,
      ...replayableEffects.recoverLaneIds,
    ]);
    const recoveryLaneIds = recoverableLaneIds.filter((laneId) => !replayableLaneIds.has(laneId));
    const recoveringRun = beginLifecycleRunIntent(
      snapshot.currentRun,
      interruptedIntent,
      snapshot.currentRun.drainMode ?? undefined
    );
    const laneEffects = createLifecycleLaneEffects(
      recoveringRun,
      'recover',
      claim.fingerprint.digest,
      recoveryLaneIds,
      causalEffects
    );
    const nextLifecycle = applyCurrentRunStatus(
      snapshot.lifecycle,
      request.runRef,
      recoveringRun.status
    );
    const begun = await this.dependencies.state.beginRunCommandAtomically({
      claim,
      expectedLifecycleRevision: request.expectedLifecycleRevision,
      expectedRunRevision: snapshot.currentRun.revision,
      runRef: request.runRef,
      nextLifecycle,
      nextRun: recoveringRun,
      fencedLaneEffects: unsettledEffects
        .filter((effect) => effect.state === 'attempting' || effect.state === 'ambiguous')
        .map(effectIdentity),
      appendedLaneEffects: laneEffects,
      outbox: this.event(nextLifecycle, 'team-lifecycle.run-recovering', recoveringRun.status),
    });
    if (begun.status === 'replayed') {
      if (!claimedOutcomeMatchesRunRef(begun.outcome, claim.targetRunRef)) {
        return { status: 'rejected', reason: 'stale_generation' };
      }
      return this.replay(begun.outcome);
    }
    if (begun.status !== 'committed') {
      return { status: 'rejected', reason: mapAtomicFailure(begun.status) };
    }

    const current = await this.resumeWorkflow(
      begun.snapshot,
      context,
      interruptedIntent,
      replayableEffects,
      recoveryLaneIds
    );
    return recoveryResult(current);
  }

  private replay(outcome: TeamLifecycleClaimedOutcome): RecoverTeamRunResult {
    if (outcome.kind === 'legacy_generation') {
      return { status: 'replayed', generation: outcome.generation };
    }
    return { status: 'replayed', run: outcome.run };
  }

  private async resumeWorkflow(
    initial: TeamLifecycleCommandSnapshot,
    context: TeamLifecycleCommandContext,
    interruptedIntent: 'cancel' | 'stop' | 'recover',
    replayableEffects: ReplayableProviderEffects,
    recoveryLaneIds: readonly LifecycleLaneEffectRecord['laneId'][]
  ): Promise<TeamLifecycleCommandSnapshot> {
    let current = initial;
    if (replayableEffects.launchLaneIds.length > 0) {
      current = await resumeLifecycleLaunchEffects(
        this.dependencies,
        current,
        context,
        replayableEffects.launchLaneIds
      );
    }
    if (replayableEffects.drainLaneIds.length > 0) {
      const drainIntent = current.currentRun?.activeIntent === 'cancel' ? 'cancel' : 'stop';
      current = await resumeLifecycleDrainEffects(
        this.dependencies,
        current,
        context,
        drainIntent,
        current.currentRun?.drainMode ?? 'graceful',
        replayableEffects.drainLaneIds
      );
    }
    for (const effect of pendingRecoveryEffects(current)) {
      current = await this.resumeOneRecoveryEffect(
        current,
        effect.laneId,
        context,
        interruptedIntent
      );
    }
    const continuationLaneIds = [
      ...new Set([...recoveryLaneIds, ...replayableEffects.recoverLaneIds]),
    ];
    return interruptedIntent === 'recover'
      ? await resumeLifecycleLaunchEffects(this.dependencies, current, context, continuationLaneIds)
      : await resumeLifecycleDrainEffects(
          this.dependencies,
          current,
          context,
          interruptedIntent,
          interruptedIntent === 'cancel'
            ? 'graceful'
            : (current.currentRun?.drainMode ?? 'graceful'),
          continuationLaneIds
        );
  }

  private async resumeOneRecoveryEffect(
    initial: TeamLifecycleCommandSnapshot,
    laneId: LifecycleLaneEffectRecord['laneId'],
    context: TeamLifecycleCommandContext,
    interruptedIntent: 'cancel' | 'stop' | 'recover'
  ): Promise<TeamLifecycleCommandSnapshot> {
    let snapshot = initial;
    let effect = findRecoveryEffect(snapshot, laneId);
    let run = snapshot.currentRun;
    if (!run || !effect || isEffectTerminal(effect)) return snapshot;

    const proposedProviderMutation = effect.providerMutations.recover
      ? null
      : this.dependencies.lanes.prepareRecoverMutation(run, laneId, effect.operationId);
    const claimed = await claimLifecycleLaneEffect(
      this.dependencies,
      snapshot,
      effect,
      context,
      undefined,
      undefined,
      proposedProviderMutation
    );
    if (claimed.status !== 'claimed') {
      return 'snapshot' in claimed ? claimed.snapshot : snapshot;
    }
    snapshot = claimed.snapshot;
    effect = claimed.effect;
    run = snapshot.currentRun;
    const lease = effect.lease;
    if (!run || !lease) return snapshot;
    const providerMutation = effect.providerMutations.recover;
    if (!providerMutation) return snapshot;

    const outcome = await this.dependencies.lanes.recover(
      run,
      laneId,
      providerMutation,
      context.cancellation
    );
    const causalSettlement = causalAbsenceSettlements(
      snapshot,
      effect,
      lease,
      outcome,
      this.dependencies.clock
    );
    if (!causalSettlement.complete) return snapshot;
    const nextRun = applyLifecycleLaneRecovery(
      run,
      laneId,
      outcome,
      interruptedIntent === 'cancel'
        ? 'cancelled'
        : interruptedIntent === 'stop'
          ? 'stopped'
          : 'queued'
    );
    const settlement: LifecycleLaneEffectSettlement =
      outcome.status === 'recovered' || outcome.status === 'not_started'
        ? {
            state: 'observed_succeeded',
            evidence: recoveryEvidence(
              effect,
              lease,
              outcome.status === 'recovered'
                ? { status: 'recovered', executionRef: outcome.executionRef }
                : { status: 'not_started' },
              this.dependencies.clock
            ),
          }
        : {
            state: 'ambiguous',
            evidence: ambiguousEvidence(
              effect,
              lease,
              'diagnostic' in outcome
                ? outcome.diagnostic
                : 'runtime-recovery-cancelled-before-proof',
              this.dependencies.clock
            ),
          };
    return (
      (await settleLifecycleLaneEffect(
        this.dependencies,
        snapshot,
        effect,
        lease,
        settlement,
        nextRun,
        'team-lifecycle.lane-recovery-observed',
        causalSettlement.settlements
      )) ?? snapshot
    );
  }

  private async recoverLegacy(
    request: RecoverTeamRunRequest,
    context: TeamLifecycleCommandContext,
    snapshot: TeamLifecycleCommandSnapshot,
    claim: Parameters<TeamLifecycleCommandStatePort['resolveClaim']>[0]
  ): Promise<RecoverTeamRunResult> {
    const admission = admitLegacyRuntimeOperation(
      snapshot.lifecycle.cutover,
      request.runRef.generation,
      'recover'
    );
    if (admission.status === 'rejected') {
      return { status: 'rejected', reason: admission.reason };
    }
    const intentCutover = updateLegacyRuntimeGeneration(
      snapshot.lifecycle.cutover,
      request.runRef.generation,
      'recovering',
      false
    );
    const nextLifecycle = replaceLegacyRuntimeCutover(snapshot.lifecycle, intentCutover);
    const begun = await this.dependencies.state.beginLegacyCommandAtomically({
      claim,
      expectedLifecycleRevision: request.expectedLifecycleRevision,
      generation: request.runRef.generation,
      nextLifecycle,
      outbox: this.event(nextLifecycle, 'team-lifecycle.legacy-recovering', 'recovering'),
    });
    if (begun.status === 'replayed') {
      if (!claimedOutcomeMatchesRunRef(begun.outcome, claim.targetRunRef)) {
        return { status: 'rejected', reason: 'stale_generation' };
      }
      return begun.outcome.kind === 'legacy_generation'
        ? { status: 'replayed', generation: begun.outcome.generation }
        : { status: 'replayed', run: begun.outcome.run };
    }
    if (begun.status !== 'committed') {
      return { status: 'rejected', reason: mapAtomicFailure(begun.status) };
    }

    let outcome: Awaited<ReturnType<LegacyRuntimeDrainPort['recover']>>;
    try {
      outcome = await this.dependencies.legacyRuntime.recover({
        teamId: request.teamId,
        generation: request.runRef.generation,
        cancellation: context.cancellation,
      });
    } catch {
      outcome = { status: 'operator_required' };
    }
    const terminal = outcome.status === 'terminal';
    const cleanupVerified = terminal && 'cleanupVerified' in outcome && outcome.cleanupVerified;
    const state = terminal ? 'terminal' : 'recovering';
    let cutover = updateLegacyRuntimeGeneration(
      nextLifecycle.cutover,
      request.runRef.generation,
      state,
      cleanupVerified
    );
    if (cleanupVerified) cutover = completeLegacyRuntimeCutover(cutover, request.runRef.generation);
    const progressedLifecycle = replaceLegacyRuntimeCutover(nextLifecycle, cutover);
    const saved = await this.dependencies.state.saveLegacyProgress({
      expectedLifecycleRevision: nextLifecycle.revision,
      generation: request.runRef.generation,
      nextLifecycle: progressedLifecycle,
      outbox: this.event(progressedLifecycle, 'team-lifecycle.legacy-recovery-observed', state),
    });
    if (saved.status !== 'committed' || outcome.status === 'operator_required') {
      return { status: 'operator_required', generation: request.runRef.generation };
    }
    return {
      status: terminal && cleanupVerified ? 'recovered' : 'recovering',
      generation: request.runRef.generation,
    };
  }

  private event(
    lifecycle: TeamLifecycleCommandSnapshot['lifecycle'],
    eventType: string,
    state: string
  ): TeamLifecycleOutboxEvent {
    return Object.freeze({
      eventId: this.dependencies.ids.createEventId(),
      eventType,
      scopeKind: 'team',
      scopeId: lifecycle.teamId,
      schemaVersion: 1,
      semanticRevision: lifecycle.revision,
      payloadJson: JSON.stringify({
        generation: lifecycle.currentRunRef?.generation ?? null,
        state,
      }),
      createdAtIso: this.dependencies.clock.nowIso(),
    });
  }
}

function latestLaneEffects(
  snapshot: TeamLifecycleCommandSnapshot,
  laneIds: readonly LifecycleLaneEffectRecord['laneId'][]
): readonly LifecycleLaneEffectRecord[] {
  const run = snapshot.currentRun;
  if (!run) return Object.freeze([]);
  const requested = new Set(laneIds);
  const latest = new Map<LifecycleLaneEffectRecord['laneId'], LifecycleLaneEffectRecord>();
  for (const effect of snapshot.laneEffects) {
    if (
      !requested.has(effect.laneId) ||
      effect.runRef.runId !== run.runId ||
      effect.runRef.generation !== run.generation
    ) {
      continue;
    }
    latest.set(effect.laneId, effect);
  }
  return Object.freeze([...latest.values()]);
}

interface ReplayableProviderEffects {
  readonly launchLaneIds: readonly LifecycleLaneEffectRecord['laneId'][];
  readonly drainLaneIds: readonly LifecycleLaneEffectRecord['laneId'][];
  readonly recoverLaneIds: readonly LifecycleLaneEffectRecord['laneId'][];
}

function replayableProviderEffects(
  effects: readonly LifecycleLaneEffectRecord[]
): ReplayableProviderEffects {
  const launchLaneIds: LifecycleLaneEffectRecord['laneId'][] = [];
  const drainLaneIds: LifecycleLaneEffectRecord['laneId'][] = [];
  const recoverLaneIds: LifecycleLaneEffectRecord['laneId'][] = [];
  for (const effect of effects) {
    if (effect.state !== 'attempting') continue;
    if (effect.kind === 'launch' && effect.providerMutations.launch) {
      launchLaneIds.push(effect.laneId);
    } else if (
      effect.kind === 'drain' &&
      (effect.providerMutations.stop || effect.providerMutations.recover)
    ) {
      drainLaneIds.push(effect.laneId);
    } else if (effect.kind === 'recover' && effect.providerMutations.recover) {
      recoverLaneIds.push(effect.laneId);
    }
  }
  return Object.freeze({
    launchLaneIds: Object.freeze(launchLaneIds),
    drainLaneIds: Object.freeze(drainLaneIds),
    recoverLaneIds: Object.freeze(recoverLaneIds),
  });
}

function unsettledLaneEffects(
  snapshot: TeamLifecycleCommandSnapshot,
  laneIds: readonly LifecycleLaneEffectRecord['laneId'][]
): readonly LifecycleLaneEffectRecord[] {
  const run = snapshot.currentRun;
  if (!run) return Object.freeze([]);
  const requested = new Set(laneIds);
  return Object.freeze(
    snapshot.laneEffects.filter(
      (effect) =>
        requested.has(effect.laneId) &&
        effect.runRef.runId === run.runId &&
        effect.runRef.generation === run.generation &&
        !isEffectTerminal(effect)
    )
  );
}

function effectIdentity(effect: LifecycleLaneEffectRecord) {
  return Object.freeze({
    runRef: effect.runRef,
    kind: effect.kind,
    laneId: effect.laneId,
    operationId: effect.operationId,
    leaseFence: effect.leaseFence,
  });
}

function pendingRecoveryEffects(snapshot: TeamLifecycleCommandSnapshot) {
  const run = snapshot.currentRun;
  if (!run) return [];
  const latest = new Map<LifecycleLaneEffectRecord['laneId'], LifecycleLaneEffectRecord>();
  for (const effect of snapshot.laneEffects) {
    if (
      effect.kind !== 'recover' ||
      effect.runRef.runId !== run.runId ||
      effect.runRef.generation !== run.generation
    ) {
      continue;
    }
    latest.set(effect.laneId, effect);
  }
  return [...latest.values()].filter((effect) => !isEffectTerminal(effect));
}

function findRecoveryEffect(
  snapshot: TeamLifecycleCommandSnapshot,
  laneId: LifecycleLaneEffectRecord['laneId']
) {
  return pendingRecoveryEffects(snapshot).find((effect) => effect.laneId === laneId);
}

function isEffectTerminal(effect: LifecycleLaneEffectRecord): boolean {
  return effect.state === 'observed_succeeded' || effect.state === 'observed_absent';
}

function activeIntent(run: {
  readonly activeIntent: NonNullable<TeamLifecycleCommandSnapshot['currentRun']>['activeIntent'];
}) {
  return run.activeIntent === 'cancel'
    ? 'cancel'
    : run.activeIntent === 'stop'
      ? 'stop'
      : 'recover';
}

function isTerminalLane(status: LifecycleRunStatusLane): boolean {
  return status === 'cancelled' || status === 'stopped' || status === 'failed';
}

type LifecycleRunStatusLane = NonNullable<
  TeamLifecycleCommandSnapshot['currentRun']
>['lanes'][number]['status'];

function recoveryEvidence(
  effect: LifecycleLaneEffectRecord,
  lease: LifecycleLaneEffectLease,
  outcome:
    | { readonly status: 'not_started' }
    | { readonly status: 'recovered'; readonly executionRef: string },
  clock: TeamLifecycleClockPort
): LifecycleLaneEffectEvidenceOf<'recovery_receipt'> {
  return Object.freeze({
    ...evidenceBase(effect, lease, clock),
    kind: 'recovery_receipt',
    disposition: outcome.status,
    executionRef: outcome.status === 'recovered' ? outcome.executionRef : null,
  });
}

function causalAbsenceSettlements(
  snapshot: TeamLifecycleCommandSnapshot,
  provingEffect: LifecycleLaneEffectRecord,
  provingLease: LifecycleLaneEffectLease,
  outcome:
    | { readonly status: 'not_started' | 'cancelled' }
    | { readonly status: 'recovered'; readonly executionRef: string }
    | { readonly status: 'operator_required'; readonly diagnostic: string }
    | { readonly status: 'rejected'; readonly diagnostic: string },
  clock: TeamLifecycleClockPort
): {
  readonly complete: boolean;
  readonly settlements: readonly SettleCausalLifecycleLaneEffectRequest[];
} {
  if (outcome.status !== 'not_started') {
    return Object.freeze({ complete: true, settlements: Object.freeze([]) });
  }
  const predecessors: (LifecycleLaneEffectRecord & {
    readonly kind: 'drain' | 'recover';
  })[] = [];
  const seen = new Set<string>();
  let predecessorIdentity = provingEffect.causalPredecessor;
  while (predecessorIdentity) {
    const identityKey = [
      predecessorIdentity.runRef.runId,
      predecessorIdentity.runRef.generation,
      predecessorIdentity.kind,
      predecessorIdentity.laneId,
      predecessorIdentity.operationId,
    ].join('|');
    if (seen.has(identityKey)) {
      return Object.freeze({ complete: false, settlements: Object.freeze([]) });
    }
    seen.add(identityKey);
    const predecessor = snapshot.laneEffects.find((effect) =>
      matchesEffectIdentity(effect, predecessorIdentity!)
    );
    if (!predecessor) {
      return Object.freeze({ complete: false, settlements: Object.freeze([]) });
    }
    if (isDrainOrRecoveryEffect(predecessor) && !isEffectTerminal(predecessor)) {
      predecessors.push(predecessor);
    }
    predecessorIdentity = predecessor.causalPredecessor;
  }
  if (
    predecessors.some(
      (effect) =>
        (effect.lease !== null &&
          Date.parse(effect.lease.expiresAtIso) > Date.parse(provingLease.claimedAtIso)) ||
        (effect.state !== 'not_started' &&
          effect.state !== 'attempting' &&
          effect.state !== 'ambiguous')
    )
  ) {
    return Object.freeze({ complete: false, settlements: Object.freeze([]) });
  }
  const observedAtIso = clock.nowIso();
  return Object.freeze({
    complete: true,
    settlements: Object.freeze(
      predecessors.map((effect) =>
        Object.freeze({
          runRef: effect.runRef,
          laneId: effect.laneId,
          kind: effect.kind,
          operationId: effect.operationId,
          expectedEffectState: effect.state as 'not_started' | 'attempting' | 'ambiguous',
          expectedLeaseFence: effect.leaseFence,
          settlement: Object.freeze({
            state: 'observed_absent' as const,
            evidence: Object.freeze({
              schemaVersion: 1 as const,
              kind: 'causal_absence_evidence' as const,
              effectKind: effect.kind,
              proof: 'recovery_not_started' as const,
              operationId: effect.operationId,
              leaseFence: effect.leaseFence,
              provingOperationId: provingEffect.operationId,
              provingLeaseFence: provingLease.fence,
              observedAtIso,
            }),
          }),
        })
      )
    ),
  });
}

function matchesEffectIdentity(
  effect: LifecycleLaneEffectRecord,
  identity: NonNullable<LifecycleLaneEffectRecord['causalPredecessor']>
): boolean {
  return (
    effect.runRef.runId === identity.runRef.runId &&
    effect.runRef.generation === identity.runRef.generation &&
    effect.kind === identity.kind &&
    effect.laneId === identity.laneId &&
    effect.operationId === identity.operationId
  );
}

function isDrainOrRecoveryEffect(
  effect: LifecycleLaneEffectRecord
): effect is LifecycleLaneEffectRecord & { readonly kind: 'drain' | 'recover' } {
  return effect.kind === 'drain' || effect.kind === 'recover';
}

function ambiguousEvidence(
  effect: LifecycleLaneEffectRecord,
  lease: LifecycleLaneEffectLease,
  diagnostic: string,
  clock: TeamLifecycleClockPort
): LifecycleLaneEffectEvidenceOf<'ambiguous_evidence'> {
  return Object.freeze({
    ...evidenceBase(effect, lease, clock),
    kind: 'ambiguous_evidence',
    diagnostic,
  });
}

function evidenceBase(
  effect: LifecycleLaneEffectRecord,
  lease: LifecycleLaneEffectLease,
  clock: TeamLifecycleClockPort
) {
  return {
    schemaVersion: 1 as const,
    operationId: effect.operationId,
    leaseFence: lease.fence,
    observedAtIso: clock.nowIso(),
  };
}

function recoveryResult(snapshot: TeamLifecycleCommandSnapshot): RecoverTeamRunResult {
  const run = snapshot.currentRun;
  if (!run) return { status: 'rejected', reason: 'unavailable' };
  const status =
    run.status === 'operator_required'
      ? 'operator_required'
      : run.status === 'recovering' || run.status === 'cancelling' || run.status === 'stopping'
        ? 'recovering'
        : run.status === 'degraded' || run.status === 'failed'
          ? 'degraded'
          : 'recovered';
  return { status, run: lifecycleRunStatusView(run) };
}

function validateRequest(
  request: RecoverTeamRunRequest
): TeamLifecycleCommandRejectionReason | null {
  try {
    if (
      request.schemaVersion !== 1 ||
      parseTeamId(request.teamId) !== request.teamId ||
      !Number.isSafeInteger(request.expectedLifecycleRevision) ||
      request.expectedLifecycleRevision < 1 ||
      !Number.isSafeInteger(request.runRef.generation) ||
      request.runRef.generation < 1
    ) {
      return 'invalid_request';
    }
    return null;
  } catch {
    return 'invalid_request';
  }
}

function mapAtomicFailure(
  status:
    | 'concurrency_conflict'
    | 'idempotency_conflict'
    | 'stale_generation'
    | 'stale_revision'
    | 'unavailable'
): TeamLifecycleCommandRejectionReason {
  return status;
}

function isCancelled(context: TeamLifecycleCommandContext): boolean {
  try {
    return context.cancellation.isCancellationRequested() !== false;
  } catch {
    return true;
  }
}
