import { parseTeamId } from '@shared/contracts/hosted';

import {
  acceptLifecycleRun,
  admitCanonicalLaunch,
  applyCurrentRunStatus,
  applyLifecycleLaneLaunch,
  createLifecycleRun,
  eligibleQueuedLaneIds,
  isTerminalLifecycleRun,
  lifecycleRunRef,
  lifecycleRunStatusView,
  markLifecycleLaneLaunching,
} from '../domain';

import {
  claimedOutcomeMatchesRunRef,
  createLifecycleLaneEffects,
  createLifecycleOperationDeadline,
  type LifecycleLaneEffectEvidenceOf,
  type LifecycleLaneEffectLease,
  type LifecycleLaneEffectRecord,
  type LifecycleLaneEffectSettlement,
  type LifecycleLaneProviderMutationProposal,
  prepareTeamLifecycleDurableClaim,
  type SettleCausalLifecycleLaneEffectRequest,
  TEAM_LIFECYCLE_EFFECT_LEASE_DURATION_MS,
  type TeamLifecycleClaimedOutcome,
  type TeamLifecycleClockPort,
  type TeamLifecycleCommandContext,
  type TeamLifecycleCommandFingerprintPort,
  type TeamLifecycleCommandSnapshot,
  type TeamLifecycleCommandStatePort,
  type TeamLifecycleDeadlinePort,
  type TeamLifecycleExternalWriterBarrierPort,
  type TeamLifecycleIdFactoryPort,
  type TeamLifecycleOutboxEvent,
} from './ports/TeamLifecycleCommandPorts';

import type {
  LaunchTeamRequest,
  LaunchTeamResult,
  TeamLifecycleCommandRejectionReason,
} from '../../contracts';
import type { LifecycleLaneCoordinator } from './LifecycleLaneCoordinator';

export interface LifecycleLaunchWorkflowDependencies {
  readonly state: TeamLifecycleCommandStatePort;
  readonly lanes: LifecycleLaneCoordinator;
  readonly clock: TeamLifecycleClockPort;
  readonly ids: TeamLifecycleIdFactoryPort;
}

export interface LaunchTeamDependencies extends LifecycleLaunchWorkflowDependencies {
  readonly fingerprint: TeamLifecycleCommandFingerprintPort;
  readonly externalWriterBarrier: TeamLifecycleExternalWriterBarrierPort;
  readonly deadlines: TeamLifecycleDeadlinePort;
}

export function lifecycleProviderMutationOperationId(
  run: NonNullable<TeamLifecycleCommandSnapshot['currentRun']>,
  effect: LifecycleLaneEffectRecord,
  kind: LifecycleLaneEffectRecord['kind']
): string {
  const lane = run.lanes.find((candidate) => candidate.laneId === effect.laneId);
  if (!lane || run.runId !== effect.runRef.runId || run.generation !== effect.runRef.generation) {
    throw new TypeError('lifecycle-provider-mutation-effect-mismatch');
  }
  return `${kind}:${run.runId}:${run.generation}:${lane.ordinal}:${effect.commandFingerprintDigest}`;
}

export class LaunchTeam {
  constructor(private readonly dependencies: LaunchTeamDependencies) {}

  async execute(
    request: LaunchTeamRequest,
    context: TeamLifecycleCommandContext
  ): Promise<LaunchTeamResult> {
    if (!isValidRequest(request, this.dependencies.lanes)) {
      return { status: 'rejected', reason: 'invalid_request' };
    }
    if (isCancelled(context)) return { status: 'rejected', reason: 'cancelled' };

    let claim;
    try {
      claim = await prepareTeamLifecycleDurableClaim(
        'team_lifecycle.launch',
        request,
        context,
        { runId: request.plan.runId, generation: request.plan.generation },
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
      return replayLaunch(prior.outcome);
    }

    const loaded = await this.dependencies.state.load(request.teamId);
    if (loaded.status === 'missing') return { status: 'rejected', reason: 'not_found' };
    if (loaded.status === 'unavailable') return { status: 'rejected', reason: 'unavailable' };
    const snapshot = loaded.snapshot;
    const validation = validateLaunchAgainstSnapshot(request, context, snapshot);
    if (validation) return { status: 'rejected', reason: validation };

    const deadline = createLifecycleOperationDeadline(this.dependencies.clock.nowIso());
    let boundedBarrier;
    try {
      boundedBarrier = await this.dependencies.deadlines.run(
        { deadline, cancellation: context.cancellation },
        async () =>
          await this.dependencies.externalWriterBarrier.prepareForLaunch({
            teamId: request.teamId,
            expectedFileWriterEpoch: snapshot.lifecycle.fileWriterEpoch,
            cancellation: context.cancellation,
            deadline,
          })
      );
    } catch {
      return { status: 'rejected', reason: 'unavailable' };
    }
    if (boundedBarrier.status !== 'completed') {
      return {
        status: 'rejected',
        reason: boundedBarrier.status === 'cancelled' ? 'cancelled' : 'preparation_timeout',
      };
    }
    const barrier = boundedBarrier.value;
    if (barrier.status !== 'quiescent') {
      return {
        status: 'rejected',
        reason:
          barrier.status === 'busy'
            ? 'external_writer_busy'
            : barrier.status === 'cancelled'
              ? 'cancelled'
              : barrier.status === 'deadline_exceeded'
                ? 'preparation_timeout'
                : 'unavailable',
      };
    }

    const acceptedAt = this.dependencies.clock.nowIso();
    let nextLifecycle;
    let run;
    let laneEffects;
    try {
      nextLifecycle = acceptLifecycleRun(snapshot.lifecycle, request.plan, barrier.receipt);
      run = createLifecycleRun(request.plan, acceptedAt);
      laneEffects = createLifecycleLaneEffects(run, 'launch', claim.fingerprint.digest);
    } catch {
      return { status: 'rejected', reason: 'plan_conflict' };
    }
    const accepted = await this.dependencies.state.acceptLaunchAtomically({
      claim,
      expectedLifecycleRevision: request.expectedLifecycleRevision,
      expectedCurrentRunRef: request.expectedCurrentRunRef,
      nextLifecycle,
      run,
      writerBarrierReceipt: barrier.receipt,
      laneEffects,
      outbox: this.event(
        'team-lifecycle.run-accepted',
        nextLifecycle.revision,
        request.teamId,
        acceptedAt,
        {
          fileWriterEpoch: nextLifecycle.fileWriterEpoch,
          generation: run.generation,
          planHash: run.plan.planHash,
          runId: run.runId,
          watcherWatermark: barrier.receipt.drainedThrough.observationSequence,
        }
      ),
    });
    if (accepted.status === 'idempotency_conflict') {
      return { status: 'rejected', reason: 'idempotency_conflict' };
    }
    if (
      accepted.status === 'stale_generation' ||
      accepted.status === 'stale_revision' ||
      accepted.status === 'concurrency_conflict'
    ) {
      return {
        status: 'rejected',
        reason:
          accepted.status === 'stale_generation'
            ? 'stale_generation'
            : accepted.status === 'stale_revision'
              ? 'stale_revision'
              : 'concurrency_conflict',
      };
    }
    if (accepted.status === 'unavailable') return { status: 'rejected', reason: 'unavailable' };
    if (accepted.status === 'replayed') {
      if (!claimedOutcomeMatchesRunRef(accepted.outcome, claim.targetRunRef)) {
        return { status: 'rejected', reason: 'stale_generation' };
      }
      return replayLaunch(accepted.outcome);
    }
    if (
      accepted.snapshot.currentRun?.plan !== request.plan ||
      accepted.snapshot.lifecycle.writerBarrierReceipt !== barrier.receipt
    ) {
      return currentLaunchResult(accepted.snapshot, 'operator_required');
    }

    const progressed = await resumeLifecycleLaunchEffects(
      this.dependencies,
      accepted.snapshot,
      context
    );
    return currentLaunchResult(progressed);
  }

  private event(
    eventType: string,
    semanticRevision: number,
    teamId: TeamLifecycleOutboxEvent['scopeId'],
    createdAtIso: string,
    payload: Readonly<Record<string, number | string>>
  ): TeamLifecycleOutboxEvent {
    return Object.freeze({
      eventId: this.dependencies.ids.createEventId(),
      eventType,
      scopeKind: 'team',
      scopeId: teamId,
      schemaVersion: 1,
      semanticRevision,
      payloadJson: JSON.stringify(payload),
      createdAtIso,
    });
  }
}

export async function resumeLifecycleLaunchEffects(
  dependencies: LifecycleLaunchWorkflowDependencies,
  initial: TeamLifecycleCommandSnapshot,
  context: TeamLifecycleCommandContext,
  requestedLaneIds?: readonly LifecycleLaneEffectRecord['laneId'][]
): Promise<TeamLifecycleCommandSnapshot> {
  let snapshot = initial;
  const requested = requestedLaneIds ? new Set(requestedLaneIds) : null;
  const laneIds = pendingLaunchLaneIds(snapshot).filter(
    (laneId) => requested === null || requested.has(laneId)
  );
  for (const laneId of laneIds) {
    if (!snapshot.currentRun || isTerminalLifecycleRun(snapshot.currentRun)) break;
    snapshot = await resumeOneLaunchEffect(dependencies, snapshot, laneId, context);
  }
  return snapshot;
}

async function resumeOneLaunchEffect(
  dependencies: LifecycleLaunchWorkflowDependencies,
  initial: TeamLifecycleCommandSnapshot,
  laneId: LifecycleLaneEffectRecord['laneId'],
  context: TeamLifecycleCommandContext
): Promise<TeamLifecycleCommandSnapshot> {
  let snapshot = initial;
  let effect = findLaneEffect(snapshot, laneId, 'launch');
  let run = snapshot.currentRun;
  let lane = run?.lanes.find((candidate) => candidate.laneId === laneId);
  if (!run || !lane || !effect || isEffectTerminal(effect)) return snapshot;

  let proposedProviderMutation: LifecycleLaneProviderMutationProposal | null = null;
  if (!effect.providerMutations.launch) {
    const preflight = await dependencies.lanes.preflight(run, laneId, context.cancellation);
    if (preflight.status === 'rejected') {
      if (lane.status === 'queued') {
        const failed = applyLifecycleLaneLaunch(markLifecycleLaneLaunching(run, laneId), laneId, {
          status: 'rejected',
          diagnostic: `runtime-preflight-${preflight.reason}`,
        });
        return (
          (await saveRun(
            dependencies,
            snapshot,
            failed,
            'team-lifecycle.lane-preflight-rejected'
          )) ?? snapshot
        );
      }
      return snapshot;
    }
    proposedProviderMutation = dependencies.lanes.prepareLaunchMutation(
      run,
      laneId,
      preflight,
      effect.operationId
    );
  }
  if (lane.status === 'queued') {
    run = markLifecycleLaneLaunching(run, laneId);
  }

  const claimed = await claimLifecycleLaneEffect(
    dependencies,
    snapshot,
    effect,
    context,
    run,
    lane.status === 'queued' ? 'team-lifecycle.lane-launching' : null,
    proposedProviderMutation
  );
  if (claimed.status !== 'claimed') {
    return 'snapshot' in claimed ? claimed.snapshot : snapshot;
  }
  snapshot = claimed.snapshot;
  effect = claimed.effect;
  run = snapshot.currentRun;
  lane = run?.lanes.find((candidate) => candidate.laneId === laneId);
  const lease = effect.lease;
  if (!run || !lane || !lease) return snapshot;
  const providerMutation = effect.providerMutations.launch;
  if (!providerMutation) return snapshot;
  const outcome = await dependencies.lanes.launch(
    run,
    laneId,
    providerMutation,
    context.cancellation
  );
  const nextRun = applyLifecycleLaneLaunch(run, laneId, outcome);
  const settlement: LifecycleLaneEffectSettlement =
    outcome.status === 'launched' || outcome.status === 'already_launched'
      ? {
          state: 'observed_succeeded',
          evidence: launchEvidence(
            effect,
            lease,
            outcome.status,
            outcome.executionRef,
            dependencies.clock
          ),
        }
      : outcome.status === 'operator_required'
        ? {
            state: 'ambiguous',
            evidence: ambiguousEvidence(effect, lease, outcome.diagnostic, dependencies.clock),
          }
        : {
            state: 'ambiguous',
            evidence: ambiguousEvidence(
              effect,
              lease,
              'diagnostic' in outcome ? outcome.diagnostic : 'runtime-launch-ambiguous',
              dependencies.clock
            ),
          };
  return (
    (await settleLifecycleLaneEffect(
      dependencies,
      snapshot,
      effect,
      lease,
      settlement,
      nextRun,
      'team-lifecycle.lane-launch-observed'
    )) ?? snapshot
  );
}

function replayLaunch(outcome: TeamLifecycleClaimedOutcome): LaunchTeamResult {
  if (outcome.kind !== 'canonical_run') {
    return { status: 'rejected', reason: 'unavailable' };
  }
  return { status: 'replayed', run: outcome.run };
}

function pendingLaunchLaneIds(snapshot: TeamLifecycleCommandSnapshot) {
  const run = snapshot.currentRun;
  if (!run) return [];
  const interrupted = snapshot.laneEffects
    .filter(
      (effect) =>
        effect.kind === 'launch' &&
        effect.runRef.runId === run.runId &&
        effect.runRef.generation === run.generation &&
        !isEffectTerminal(effect) &&
        run.lanes.some((lane) => lane.laneId === effect.laneId && lane.status === 'launching')
    )
    .map((effect) => effect.laneId);
  return [...new Set([...interrupted, ...eligibleQueuedLaneIds(run)])];
}

export async function claimLifecycleLaneEffect(
  dependencies: LifecycleLaunchWorkflowDependencies,
  snapshot: TeamLifecycleCommandSnapshot,
  effect: LifecycleLaneEffectRecord,
  context: TeamLifecycleCommandContext,
  nextRun: NonNullable<TeamLifecycleCommandSnapshot['currentRun']> = snapshot.currentRun!,
  transitionEventType: string | null = null,
  proposedProviderMutation: LifecycleLaneProviderMutationProposal | null = null
) {
  const receipt = snapshot.lifecycle.writerBarrierReceipt;
  const currentRun = snapshot.currentRun;
  const currentLane = currentRun?.lanes.find((lane) => lane.laneId === effect.laneId);
  if (!receipt || !currentRun || !currentLane) return { status: 'unavailable' as const };
  if (effect.state === 'observed_succeeded') {
    return { status: 'completed' as const, effect, snapshot };
  }
  const claimedAtIso = dependencies.clock.nowIso();
  const nextLifecycle =
    nextRun === currentRun
      ? snapshot.lifecycle
      : applyCurrentRunStatus(snapshot.lifecycle, lifecycleRunRef(currentRun), nextRun.status);
  return await dependencies.state.claimLaneEffect({
    runRef: effect.runRef,
    laneId: effect.laneId,
    kind: effect.kind,
    operationId: effect.operationId,
    proposedProviderMutation,
    expectedEffectState: effect.state,
    expectedLeaseFence: effect.leaseFence,
    expectedLifecycleRevision: snapshot.lifecycle.revision,
    expectedRunRevision: currentRun.revision,
    expectedRunIntent: currentRun.activeIntent,
    expectedLaneStatus: currentLane.status,
    nextLifecycle,
    nextRun,
    transitionOutbox:
      transitionEventType === null
        ? null
        : event(dependencies, nextLifecycle, transitionEventType, nextRun.status),
    ownerId: context.cancellation.cancellationId,
    proposedLeaseToken: dependencies.ids.createLeaseToken(),
    claimedAtIso,
    leaseExpiresAtIso: new Date(
      Date.parse(claimedAtIso) + TEAM_LIFECYCLE_EFFECT_LEASE_DURATION_MS
    ).toISOString(),
    expectedWriterBarrierReceipt: receipt,
  });
}

export async function settleLifecycleLaneEffect(
  dependencies: LifecycleLaunchWorkflowDependencies,
  snapshot: TeamLifecycleCommandSnapshot,
  effect: LifecycleLaneEffectRecord,
  lease: LifecycleLaneEffectLease,
  settlement: LifecycleLaneEffectSettlement,
  nextRun: NonNullable<TeamLifecycleCommandSnapshot['currentRun']>,
  eventType: string,
  causalSettlements: readonly SettleCausalLifecycleLaneEffectRequest[] = Object.freeze([])
): Promise<TeamLifecycleCommandSnapshot | null> {
  const currentRun = snapshot.currentRun;
  const receipt = snapshot.lifecycle.writerBarrierReceipt;
  if (!currentRun || !receipt) return null;
  const nextLifecycle =
    nextRun === currentRun
      ? snapshot.lifecycle
      : applyCurrentRunStatus(snapshot.lifecycle, lifecycleRunRef(currentRun), nextRun.status);
  const saved = await dependencies.state.settleLaneEffect({
    runRef: lifecycleRunRef(currentRun),
    laneId: effect.laneId,
    kind: effect.kind,
    operationId: effect.operationId,
    expectedLease: lease,
    settlement,
    causalSettlements,
    expectedLifecycleRevision: snapshot.lifecycle.revision,
    expectedRunRevision: currentRun.revision,
    nextLifecycle,
    nextRun,
    expectedWriterBarrierReceipt: receipt,
    outbox: event(dependencies, nextLifecycle, eventType, nextRun.status),
  });
  return saved.status === 'committed' ? saved.snapshot : null;
}

async function saveRun(
  dependencies: LifecycleLaunchWorkflowDependencies,
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
  const saved = await dependencies.state.saveRunProgress({
    expectedLifecycleRevision: snapshot.lifecycle.revision,
    expectedRunRevision: currentRun.revision,
    runRef: lifecycleRunRef(currentRun),
    nextLifecycle,
    nextRun,
    expectedWriterBarrierReceipt: receipt,
    outbox: event(dependencies, nextLifecycle, eventType, nextRun.status),
  });
  return saved.status === 'committed' ? saved.snapshot : null;
}

function findLaneEffect(
  snapshot: TeamLifecycleCommandSnapshot,
  laneId: LifecycleLaneEffectRecord['laneId'],
  kind: LifecycleLaneEffectRecord['kind']
): LifecycleLaneEffectRecord | undefined {
  const run = snapshot.currentRun;
  return snapshot.laneEffects.find(
    (effect) =>
      effect.kind === kind &&
      effect.laneId === laneId &&
      effect.runRef.runId === run?.runId &&
      effect.runRef.generation === run.generation
  );
}

function isEffectTerminal(effect: LifecycleLaneEffectRecord): boolean {
  return (
    effect.state === 'observed_succeeded' ||
    (effect.state === 'observed_absent' && effect.kind === 'recover')
  );
}

function launchEvidence(
  effect: LifecycleLaneEffectRecord,
  lease: LifecycleLaneEffectLease,
  disposition: 'launched' | 'already_launched' | 'recovered',
  executionRef: string,
  clock: TeamLifecycleClockPort
): LifecycleLaneEffectEvidenceOf<'launch_receipt'> {
  return Object.freeze({
    ...evidenceBase(effect, lease, clock),
    kind: 'launch_receipt',
    disposition,
    executionRef,
  });
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

function event(
  dependencies: LifecycleLaunchWorkflowDependencies,
  lifecycle: TeamLifecycleCommandSnapshot['lifecycle'],
  eventType: string,
  state: string
): TeamLifecycleOutboxEvent {
  return Object.freeze({
    eventId: dependencies.ids.createEventId(),
    eventType,
    scopeKind: 'team',
    scopeId: lifecycle.teamId,
    schemaVersion: 1,
    semanticRevision: lifecycle.revision,
    payloadJson: JSON.stringify({
      generation: lifecycle.currentRunRef?.generation ?? null,
      state,
    }),
    createdAtIso: dependencies.clock.nowIso(),
  });
}

function isValidRequest(request: LaunchTeamRequest, lanes: LifecycleLaneCoordinator): boolean {
  try {
    return (
      request.schemaVersion === 1 &&
      parseTeamId(request.teamId) === request.teamId &&
      Number.isSafeInteger(request.expectedLifecycleRevision) &&
      request.expectedLifecycleRevision >= 1 &&
      request.plan.teamId === request.teamId &&
      lanes.isCurrentPlan(request.plan) &&
      Object.isFrozen(request.plan)
    );
  } catch {
    return false;
  }
}

function validateLaunchAgainstSnapshot(
  request: LaunchTeamRequest,
  context: TeamLifecycleCommandContext,
  snapshot: TeamLifecycleCommandSnapshot
): TeamLifecycleCommandRejectionReason | null {
  if (
    snapshot.lifecycle.teamId !== request.teamId ||
    snapshot.lifecycle.deploymentId !== context.deploymentId
  ) {
    return 'not_found';
  }
  if (snapshot.lifecycle.revision !== request.expectedLifecycleRevision) return 'stale_revision';
  if (!sameRunRef(snapshot.lifecycle.currentRunRef, request.expectedCurrentRunRef)) {
    return 'stale_generation';
  }
  const admission = admitCanonicalLaunch(snapshot.lifecycle.cutover);
  if (admission.status === 'rejected') return admission.reason;
  if (snapshot.currentRun && !isTerminalLifecycleRun(snapshot.currentRun)) return 'plan_conflict';
  if (
    request.plan.generation !== snapshot.lifecycle.lastGeneration + 1 ||
    request.plan.runId === snapshot.lifecycle.currentRunRef?.runId
  ) {
    return 'plan_conflict';
  }
  return null;
}

function sameRunRef(
  left: LaunchTeamRequest['expectedCurrentRunRef'],
  right: LaunchTeamRequest['expectedCurrentRunRef']
): boolean {
  return left === null
    ? right === null
    : right !== null && left.runId === right.runId && left.generation === right.generation;
}

function currentLaunchResult(
  snapshot: TeamLifecycleCommandSnapshot,
  forcedStatus?: 'operator_required'
): LaunchTeamResult {
  const run = snapshot.currentRun;
  if (!run) return { status: 'rejected', reason: 'unavailable' };
  const status =
    forcedStatus ??
    (run.status === 'operator_required'
      ? 'operator_required'
      : run.status === 'recovering'
        ? 'recovering'
        : run.status === 'degraded' || run.status === 'failed'
          ? 'degraded'
          : 'accepted');
  return { status, run: lifecycleRunStatusView(run) };
}

function isCancelled(context: TeamLifecycleCommandContext): boolean {
  try {
    return context.cancellation.isCancellationRequested() !== false;
  } catch {
    return true;
  }
}
