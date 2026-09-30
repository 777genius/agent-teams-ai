import { parseTeamId } from '@shared/contracts/hosted';

import {
  admitLegacyRuntimeOperation,
  applyCurrentRunStatus,
  applyLifecycleLaneRecovery,
  applyLifecycleLaneStop,
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
  lifecycleProviderMutationOperationId,
  settleLifecycleLaneEffect,
} from './LaunchTeam';

import type {
  CancelProvisioningRequest,
  CancelProvisioningResult,
  LifecycleRunStatusView,
  StopTeamRequest,
  StopTeamResult,
  TeamLifecycleCommandRejectionReason,
} from '../../contracts';
export interface LifecycleDrainDependencies extends LifecycleLaunchWorkflowDependencies {
  readonly fingerprint: TeamLifecycleCommandFingerprintPort;
  readonly legacyRuntime: LegacyRuntimeDrainPort;
}

type LifecycleDrainRequest = StopTeamRequest | CancelProvisioningRequest;
type LifecycleDrainResult =
  | {
      readonly status:
        | 'cancelled'
        | 'stopped'
        | 'replayed'
        | 'degraded'
        | 'recovering'
        | 'operator_required';
      readonly run?: LifecycleRunStatusView;
      readonly generation?: number;
    }
  | { readonly status: 'rejected'; readonly reason: TeamLifecycleCommandRejectionReason };

export class StopTeam {
  constructor(private readonly dependencies: LifecycleDrainDependencies) {}

  async execute(
    request: StopTeamRequest,
    context: TeamLifecycleCommandContext
  ): Promise<StopTeamResult> {
    return await drainTeamLifecycle(this.dependencies, request, context, 'stop');
  }
}

export function drainTeamLifecycle(
  dependencies: LifecycleDrainDependencies,
  request: CancelProvisioningRequest,
  context: TeamLifecycleCommandContext,
  intent: 'cancel'
): Promise<CancelProvisioningResult>;
export function drainTeamLifecycle(
  dependencies: LifecycleDrainDependencies,
  request: StopTeamRequest,
  context: TeamLifecycleCommandContext,
  intent: 'stop'
): Promise<StopTeamResult>;
export async function drainTeamLifecycle(
  dependencies: LifecycleDrainDependencies,
  request: LifecycleDrainRequest,
  context: TeamLifecycleCommandContext,
  intent: 'cancel' | 'stop'
): Promise<LifecycleDrainResult> {
  const invalid = validateRequest(request, intent);
  if (invalid) return { status: 'rejected', reason: invalid };
  if (isCancelled(context)) return { status: 'rejected', reason: 'cancelled' };

  let claim;
  try {
    claim = await prepareTeamLifecycleDurableClaim(
      intent === 'cancel' ? 'team_lifecycle.cancel' : 'team_lifecycle.stop',
      request,
      context,
      request.runRef,
      dependencies.fingerprint
    );
  } catch {
    return { status: 'rejected', reason: 'invalid_request' };
  }
  if (!claim) return { status: 'rejected', reason: 'unavailable' };
  const prior = await dependencies.state.resolveClaim(claim);
  if (prior.status === 'idempotency_conflict') {
    return { status: 'rejected', reason: 'idempotency_conflict' };
  }
  if (prior.status === 'unavailable') return { status: 'rejected', reason: 'unavailable' };
  if (prior.status === 'replayed') {
    if (!claimedOutcomeMatchesRunRef(prior.outcome, claim.targetRunRef)) {
      return { status: 'rejected', reason: 'stale_generation' };
    }
    return replayDrain(prior.outcome);
  }

  const loaded = await dependencies.state.load(request.teamId);
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
    return await drainLegacy(dependencies, request, context, intent, snapshot, claim);
  }
  if (
    !isCurrentLifecycleRun(snapshot.lifecycle, request.runRef) ||
    snapshot.currentRun?.runId !== request.runRef.runId
  ) {
    return { status: 'rejected', reason: 'stale_generation' };
  }
  if (isTerminalLifecycleRun(snapshot.currentRun)) {
    const claimed = await dependencies.state.claimNoopAtomically({
      claim,
      expectedLifecycleRevision: request.expectedLifecycleRevision,
      expectedRunRevision: snapshot.currentRun.revision,
      runRef: request.runRef,
    });
    if (claimed.status === 'replayed') {
      if (!claimedOutcomeMatchesRunRef(claimed.outcome, claim.targetRunRef)) {
        return { status: 'rejected', reason: 'stale_generation' };
      }
      return replayedDrainOutcome(claimed.outcome);
    }
    if (claimed.status !== 'committed') {
      return { status: 'rejected', reason: mapAtomicFailure(claimed.status) };
    }
    return {
      status: intent === 'cancel' ? 'cancelled' : 'stopped',
      run: lifecycleRunStatusView(snapshot.currentRun),
    };
  }

  const causalEffects = latestLaneEffects(snapshot);
  const possiblyStartedEffects = causalEffects.filter(
    (effect) => effect.state === 'attempting' || effect.state === 'ambiguous'
  );
  const possiblyStartedLaneIds = possiblyStartedEffects.map((effect) => effect.laneId);
  const nextRun = beginLifecycleRunIntent(
    snapshot.currentRun,
    intent,
    stopMode(request),
    possiblyStartedLaneIds
  );
  const startedLaneIds = snapshot.currentRun.lanes
    .filter(
      (lane) =>
        (lane.executionRef !== null || possiblyStartedLaneIds.includes(lane.laneId)) &&
        !isTerminalLane(lane.status)
    )
    .map((lane) => lane.laneId);
  const laneEffects = createLifecycleLaneEffects(
    nextRun,
    'drain',
    claim.fingerprint.digest,
    startedLaneIds,
    causalEffects
  );
  const nextLifecycle = applyCurrentRunStatus(snapshot.lifecycle, request.runRef, nextRun.status);
  const begun = await dependencies.state.beginRunCommandAtomically({
    claim,
    expectedLifecycleRevision: request.expectedLifecycleRevision,
    expectedRunRevision: snapshot.currentRun.revision,
    runRef: request.runRef,
    nextLifecycle,
    nextRun,
    fencedLaneEffects: possiblyStartedEffects.map(effectIdentity),
    appendedLaneEffects: laneEffects,
    outbox: event(
      dependencies,
      nextLifecycle,
      `team-lifecycle.run-${intent === 'cancel' ? 'cancelling' : 'stopping'}`,
      nextRun.status,
      request.runRef.generation
    ),
  });
  if (begun.status === 'replayed') {
    if (!claimedOutcomeMatchesRunRef(begun.outcome, claim.targetRunRef)) {
      return { status: 'rejected', reason: 'stale_generation' };
    }
    return replayDrain(begun.outcome);
  }
  if (begun.status !== 'committed') {
    return { status: 'rejected', reason: mapAtomicFailure(begun.status) };
  }

  const current = await resumeLifecycleDrainEffects(
    dependencies,
    begun.snapshot,
    context,
    intent,
    stopMode(request)
  );
  return drainResult(current, intent);
}

export async function resumeLifecycleDrainEffects(
  dependencies: LifecycleDrainDependencies,
  initial: TeamLifecycleCommandSnapshot,
  context: TeamLifecycleCommandContext,
  intent: 'cancel' | 'stop',
  mode: 'graceful' | 'immediate',
  requestedLaneIds?: readonly LifecycleLaneEffectRecord['laneId'][]
): Promise<TeamLifecycleCommandSnapshot> {
  let snapshot = initial;
  const requested = requestedLaneIds ? new Set(requestedLaneIds) : null;
  const effects = pendingDrainEffects(initial).filter(
    (effect) => requested === null || requested.has(effect.laneId)
  );
  for (const effect of effects) {
    snapshot = await resumeOneDrainEffect(
      dependencies,
      snapshot,
      effect.laneId,
      context,
      intent,
      mode,
      0
    );
  }
  return snapshot;
}

async function resumeOneDrainEffect(
  dependencies: LifecycleDrainDependencies,
  initial: TeamLifecycleCommandSnapshot,
  laneId: LifecycleLaneEffectRecord['laneId'],
  context: TeamLifecycleCommandContext,
  intent: 'cancel' | 'stop',
  mode: 'graceful' | 'immediate',
  recoveryDepth: number
): Promise<TeamLifecycleCommandSnapshot> {
  let snapshot = initial;
  let effect = findDrainEffect(snapshot, laneId);
  let run = snapshot.currentRun;
  let lane = run?.lanes.find((candidate) => candidate.laneId === laneId);
  if (!run || !lane || !effect || isEffectTerminal(effect) || isTerminalLane(lane.status)) {
    return snapshot;
  }

  const providerEffectKind = lane.executionRef ? 'stop' : 'recover';
  const proposedProviderMutation = effect.providerMutations[providerEffectKind]
    ? null
    : lane.executionRef
      ? dependencies.lanes.prepareStopMutation(
          run,
          laneId,
          effect.operationId,
          lane.executionRef,
          intent === 'cancel' ? 'graceful' : mode
        )
      : dependencies.lanes.prepareRecoverMutation(
          run,
          laneId,
          lifecycleProviderMutationOperationId(run, effect, 'recover')
        );
  const claimed = await claimLifecycleLaneEffect(
    dependencies,
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
  lane = run?.lanes.find((candidate) => candidate.laneId === laneId);
  const lease = effect.lease;
  if (!run || !lane || !lease) return snapshot;
  const providerMutation = effect.providerMutations[providerEffectKind];
  if (!providerMutation) return snapshot;

  if (providerEffectKind === 'recover') {
    const recovered = await dependencies.lanes.recover(
      run,
      laneId,
      providerMutation,
      context.cancellation
    );
    if (recovered.status === 'not_started' || recovered.status === 'cancelled') {
      if (!otherDrainRecoveryEffectsAreConclusive(snapshot, effect)) return snapshot;
      const nextRun = applyLifecycleLaneStop(run, laneId, { status: 'already_stopped' });
      return (
        (await settleLifecycleLaneEffect(
          dependencies,
          snapshot,
          effect,
          lease,
          {
            state: 'observed_succeeded',
            evidence: drainEvidence(effect, lease, 'absence_verified', dependencies.clock),
          },
          nextRun,
          'team-lifecycle.lane-drain-absence-proven'
        )) ?? snapshot
      );
    }
    if (recovered.status === 'recovered' && recoveryDepth < 1) {
      const recoveredRun = applyLifecycleLaneRecovery(run, laneId, recovered);
      const absent = await settleLifecycleLaneEffect(
        dependencies,
        snapshot,
        effect,
        lease,
        {
          state: 'observed_absent',
          evidence: drainAbsenceEvidence(effect, lease, 'effect_not_invoked', dependencies.clock),
        },
        recoveredRun,
        'team-lifecycle.lane-drain-incomplete'
      );
      return absent
        ? await resumeOneDrainEffect(
            dependencies,
            absent,
            laneId,
            context,
            intent,
            mode,
            recoveryDepth + 1
          )
        : snapshot;
    }
    const ambiguousRun = applyLifecycleLaneStop(run, laneId, {
      status: 'operator_required',
      diagnostic: 'runtime-drain-recovery-ambiguous',
    });
    return (
      (await settleLifecycleLaneEffect(
        dependencies,
        snapshot,
        effect,
        lease,
        {
          state: 'ambiguous',
          evidence: ambiguousEvidence(
            effect,
            lease,
            'runtime-drain-recovery-ambiguous',
            dependencies.clock
          ),
        },
        ambiguousRun,
        'team-lifecycle.lane-drain-ambiguous'
      )) ?? snapshot
    );
  }

  const outcome = await dependencies.lanes.stop(
    run,
    laneId,
    providerMutation,
    context.cancellation
  );
  if (
    (outcome.status === 'stopped' ||
      outcome.status === 'already_stopped' ||
      outcome.status === 'cancelled') &&
    !otherDrainRecoveryEffectsAreConclusive(snapshot, effect)
  ) {
    return snapshot;
  }
  const nextRun = applyLifecycleLaneStop(run, laneId, outcome);
  const settlement: LifecycleLaneEffectSettlement =
    outcome.status === 'stopped' ||
    outcome.status === 'already_stopped' ||
    outcome.status === 'cancelled'
      ? {
          state: 'observed_succeeded',
          evidence: drainEvidence(effect, lease, outcome.status, dependencies.clock),
        }
      : {
          state: 'ambiguous',
          evidence: ambiguousEvidence(
            effect,
            lease,
            'diagnostic' in outcome ? outcome.diagnostic : 'runtime-stop-ambiguous',
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
      `team-lifecycle.lane-${intent === 'cancel' ? 'cancel' : 'stop'}-observed`
    )) ?? snapshot
  );
}

function otherDrainRecoveryEffectsAreConclusive(
  snapshot: TeamLifecycleCommandSnapshot,
  completingEffect: LifecycleLaneEffectRecord
): boolean {
  return snapshot.laneEffects
    .filter(
      (effect) =>
        effect.runRef.runId === completingEffect.runRef.runId &&
        effect.runRef.generation === completingEffect.runRef.generation &&
        effect.laneId === completingEffect.laneId &&
        (effect.kind === 'drain' || effect.kind === 'recover') &&
        !sameEffectIdentity(effect, completingEffect)
    )
    .every(isEffectTerminal);
}

function sameEffectIdentity(
  left: LifecycleLaneEffectRecord,
  right: LifecycleLaneEffectRecord
): boolean {
  return (
    left.kind === right.kind &&
    left.laneId === right.laneId &&
    left.operationId === right.operationId &&
    left.leaseFence === right.leaseFence
  );
}

async function drainLegacy(
  dependencies: LifecycleDrainDependencies,
  request: LifecycleDrainRequest,
  context: TeamLifecycleCommandContext,
  intent: 'cancel' | 'stop',
  snapshot: TeamLifecycleCommandSnapshot,
  claim: Parameters<TeamLifecycleCommandStatePort['resolveClaim']>[0]
): Promise<LifecycleDrainResult> {
  const admission = admitLegacyRuntimeOperation(
    snapshot.lifecycle.cutover,
    request.runRef.generation,
    intent
  );
  if (admission.status === 'rejected') {
    return { status: 'rejected', reason: admission.reason };
  }
  const intentCutover = updateLegacyRuntimeGeneration(
    snapshot.lifecycle.cutover,
    request.runRef.generation,
    intent === 'cancel' ? 'cancelling' : 'stopping',
    false
  );
  const nextLifecycle = replaceLegacyRuntimeCutover(snapshot.lifecycle, intentCutover);
  const begun = await dependencies.state.beginLegacyCommandAtomically({
    claim,
    expectedLifecycleRevision: request.expectedLifecycleRevision,
    generation: request.runRef.generation,
    nextLifecycle,
    outbox: event(
      dependencies,
      nextLifecycle,
      `team-lifecycle.legacy-${intent === 'cancel' ? 'cancelling' : 'stopping'}`,
      intent === 'cancel' ? 'cancelling' : 'stopping',
      request.runRef.generation
    ),
  });
  if (begun.status === 'replayed') {
    return claimedOutcomeMatchesRunRef(begun.outcome, claim.targetRunRef)
      ? replayedDrainOutcome(begun.outcome)
      : { status: 'rejected', reason: 'stale_generation' };
  }
  if (begun.status !== 'committed') {
    return { status: 'rejected', reason: mapAtomicFailure(begun.status) };
  }

  let outcome:
    | Awaited<ReturnType<LegacyRuntimeDrainPort['cancel']>>
    | Awaited<ReturnType<LegacyRuntimeDrainPort['stop']>>;
  try {
    outcome =
      intent === 'cancel'
        ? await dependencies.legacyRuntime.cancel({
            teamId: request.teamId,
            generation: request.runRef.generation,
            cancellation: context.cancellation,
          })
        : await dependencies.legacyRuntime.stop({
            teamId: request.teamId,
            generation: request.runRef.generation,
            mode: stopMode(request),
            cancellation: context.cancellation,
          });
  } catch {
    outcome = { status: 'operator_required' };
  }
  const terminal = outcome.status === 'cancelled' || outcome.status === 'stopped';
  const cleanupVerified = terminal && 'cleanupVerified' in outcome && outcome.cleanupVerified;
  const resultStatus =
    outcome.status === 'operator_required'
      ? 'operator_required'
      : terminal && cleanupVerified
        ? intent === 'cancel'
          ? 'cancelled'
          : 'stopped'
        : 'recovering';
  let cutover = updateLegacyRuntimeGeneration(
    nextLifecycle.cutover,
    request.runRef.generation,
    terminal ? 'terminal' : 'recovering',
    cleanupVerified
  );
  if (terminal && cleanupVerified) {
    cutover = completeLegacyRuntimeCutover(cutover, request.runRef.generation);
  }
  const progressedLifecycle = replaceLegacyRuntimeCutover(nextLifecycle, cutover);
  const saved = await dependencies.state.saveLegacyProgress({
    expectedLifecycleRevision: nextLifecycle.revision,
    generation: request.runRef.generation,
    nextLifecycle: progressedLifecycle,
    outbox: event(
      dependencies,
      progressedLifecycle,
      'team-lifecycle.legacy-drain-observed',
      terminal ? 'terminal' : 'recovering',
      request.runRef.generation
    ),
  });
  if (saved.status !== 'committed') {
    return { status: 'operator_required', generation: request.runRef.generation };
  }
  return { status: resultStatus, generation: request.runRef.generation };
}

function replayDrain(outcome: TeamLifecycleClaimedOutcome): LifecycleDrainResult {
  if (outcome.kind === 'legacy_generation') {
    return { status: 'replayed', generation: outcome.generation };
  }
  return { status: 'replayed', run: outcome.run };
}

function replayedDrainOutcome(outcome: TeamLifecycleClaimedOutcome): LifecycleDrainResult {
  return outcome.kind === 'canonical_run'
    ? { status: 'replayed', run: outcome.run }
    : { status: 'replayed', generation: outcome.generation };
}

function latestLaneEffects(
  snapshot: TeamLifecycleCommandSnapshot
): readonly LifecycleLaneEffectRecord[] {
  const run = snapshot.currentRun;
  if (!run) return Object.freeze([]);
  const latest = new Map<LifecycleLaneEffectRecord['laneId'], LifecycleLaneEffectRecord>();
  for (const effect of snapshot.laneEffects) {
    if (
      effect.runRef.runId !== run.runId ||
      effect.runRef.generation !== run.generation ||
      !run.lanes.some((lane) => lane.laneId === effect.laneId)
    ) {
      continue;
    }
    latest.set(effect.laneId, effect);
  }
  return Object.freeze([...latest.values()]);
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

function pendingDrainEffects(snapshot: TeamLifecycleCommandSnapshot) {
  const run = snapshot.currentRun;
  if (!run) return [];
  const latest = new Map<LifecycleLaneEffectRecord['laneId'], LifecycleLaneEffectRecord>();
  for (const effect of snapshot.laneEffects) {
    if (
      effect.kind !== 'drain' ||
      effect.runRef.runId !== run.runId ||
      effect.runRef.generation !== run.generation
    ) {
      continue;
    }
    latest.set(effect.laneId, effect);
  }
  return [...latest.values()].filter((effect) => !isEffectTerminal(effect));
}

function findDrainEffect(
  snapshot: TeamLifecycleCommandSnapshot,
  laneId: LifecycleLaneEffectRecord['laneId']
) {
  return pendingDrainEffects(snapshot).find((effect) => effect.laneId === laneId);
}

function isEffectTerminal(effect: LifecycleLaneEffectRecord): boolean {
  return effect.state === 'observed_succeeded';
}

function isTerminalLane(status: LifecycleRunStatusView['lanes'][number]['status']): boolean {
  return status === 'cancelled' || status === 'stopped' || status === 'failed';
}

function drainEvidence(
  effect: LifecycleLaneEffectRecord,
  lease: LifecycleLaneEffectLease,
  disposition: 'stopped' | 'already_stopped' | 'cancelled' | 'absence_verified',
  clock: TeamLifecycleClockPort
): LifecycleLaneEffectEvidenceOf<'drain_receipt'> {
  return Object.freeze({
    ...evidenceBase(effect, lease, clock),
    kind: 'drain_receipt',
    disposition,
  });
}

function drainAbsenceEvidence(
  effect: LifecycleLaneEffectRecord,
  lease: LifecycleLaneEffectLease,
  proof: LifecycleLaneEffectEvidenceOf<'absence_evidence'>['proof'],
  clock: TeamLifecycleClockPort
): LifecycleLaneEffectEvidenceOf<'absence_evidence'> {
  return Object.freeze({
    ...evidenceBase(effect, lease, clock),
    kind: 'absence_evidence',
    effectKind: 'drain',
    proof,
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
  dependencies: {
    readonly clock: TeamLifecycleClockPort;
    readonly ids: TeamLifecycleIdFactoryPort;
  },
  lifecycle: TeamLifecycleCommandSnapshot['lifecycle'],
  eventType: string,
  state: string,
  generation: number
): TeamLifecycleOutboxEvent {
  return Object.freeze({
    eventId: dependencies.ids.createEventId(),
    eventType,
    scopeKind: 'team',
    scopeId: lifecycle.teamId,
    schemaVersion: 1,
    semanticRevision: lifecycle.revision,
    payloadJson: JSON.stringify({ generation, state }),
    createdAtIso: dependencies.clock.nowIso(),
  });
}

function drainResult(
  snapshot: TeamLifecycleCommandSnapshot,
  intent: 'cancel' | 'stop'
): LifecycleDrainResult {
  const run = snapshot.currentRun;
  if (!run) return { status: 'rejected', reason: 'unavailable' };
  const status =
    run.status === 'operator_required'
      ? 'operator_required'
      : run.status === 'recovering' || run.status === 'cancelling' || run.status === 'stopping'
        ? 'recovering'
        : run.status === 'degraded' || run.status === 'failed'
          ? 'degraded'
          : intent === 'cancel'
            ? 'cancelled'
            : 'stopped';
  return { status, run: lifecycleRunStatusView(run) };
}

function validateRequest(
  request: LifecycleDrainRequest,
  intent: 'cancel' | 'stop'
): TeamLifecycleCommandRejectionReason | null {
  try {
    if (
      request.schemaVersion !== 1 ||
      parseTeamId(request.teamId) !== request.teamId ||
      !Number.isSafeInteger(request.expectedLifecycleRevision) ||
      request.expectedLifecycleRevision < 1 ||
      !Number.isSafeInteger(request.runRef.generation) ||
      request.runRef.generation < 1 ||
      (intent === 'stop' &&
        (!('mode' in request) || !['graceful', 'immediate'].includes(request.mode)))
    ) {
      return 'invalid_request';
    }
    return null;
  } catch {
    return 'invalid_request';
  }
}

function stopMode(request: LifecycleDrainRequest): 'graceful' | 'immediate' {
  return 'mode' in request ? request.mode : 'graceful';
}

function mapAtomicFailure(
  status: Exclude<
    Awaited<ReturnType<TeamLifecycleCommandStatePort['beginRunCommandAtomically']>>['status'],
    'committed' | 'replayed'
  >
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
