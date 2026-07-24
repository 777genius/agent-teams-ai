/* eslint-disable @typescript-eslint/require-await -- Async fakes intentionally implement asynchronous port contracts. */
import { createHash, createHmac } from 'node:crypto';

import {
  buildCommandFingerprintRecord,
  type CommandFingerprintRecord,
} from '@features/application-command-ledger';
import {
  applyCurrentRunStatus,
  applyLifecycleLaneLaunch,
  applyLifecycleLaneRecovery,
  applyLifecycleLaneStop,
  createCanonicalRuntimeCutover,
  createTeamLifecycle,
  isTerminalLifecycleRun,
  type LegacyRuntimeGenerationState,
  lifecycleRunStatusView,
  markLifecycleLaneLaunching,
  type TeamLifecycle,
} from '@features/team-lifecycle';
import {
  createCompositeRuntimePlan,
  type LaneId,
  parseExecutionUnitId,
  parseLaneId,
  parseRuntimeBackendBindingId,
  parseRuntimeBinaryId,
  type RuntimeExecutionBackendKind,
  type Sha256Hash,
} from '@features/team-runtime-control';
import { planTeamRuntimeLanes } from '@features/team-runtime-lanes';
import {
  parseDeploymentId,
  parseLegacyMemberKey,
  parseMemberId,
  parseRunId,
  parseTeamId,
  parseWorkspaceId,
} from '@shared/contracts/hosted';

import type {
  AcceptLifecycleLaunchAtomicallyRequest,
  BeginLegacyRuntimeCommandAtomicallyRequest,
  BeginLifecycleRunCommandAtomicallyRequest,
  ClaimLifecycleCommandNoopAtomicallyRequest,
  ClaimLifecycleLaneEffectRequest,
  ClaimLifecycleLaneEffectResult,
  FingerprintTeamLifecycleCommandRequest,
  LegacyRuntimeDrainPort,
  LifecycleAtomicCommandResult,
  LifecycleExecutionBackendRegistryPort,
  LifecycleLaneEffectRecord,
  LifecycleOperationDeadline,
  LifecycleResolvedLaneBackend,
  LifecycleWriterBarrierReceipt,
  LoadTeamLifecycleCommandStateResult,
  PrepareExternalWriterQuiescenceResult,
  ProvisioningPreflightPort,
  ResolveTeamLifecycleCommandClaimResult,
  SaveLegacyRuntimeProgressRequest,
  SaveLegacyRuntimeProgressResult,
  SaveLifecycleRunProgressRequest,
  SaveLifecycleRunProgressResult,
  SettleLifecycleLaneEffectRequest,
  SettleLifecycleLaneEffectResult,
  TeamLifecycleClaimedOutcome,
  TeamLifecycleCommandContext,
  TeamLifecycleCommandFingerprintPort,
  TeamLifecycleCommandSnapshot,
  TeamLifecycleCommandStatePort,
  TeamLifecycleDeadlinePort,
  TeamLifecycleDurableClaim,
  TeamLifecycleExternalWriterBarrierPort,
  TeamLifecycleOutboxEvent,
} from '@features/team-lifecycle';
import type { TeamProviderId } from '@shared/types';

export const TEST_DEPLOYMENT_ID = parseDeploymentId(`deployment_${'a'.repeat(32)}`);
export const TEST_TEAM_ID = parseTeamId(`team_${'b'.repeat(32)}`);

export class FakeTeamLifecycleCommandState implements TeamLifecycleCommandStatePort {
  private snapshotValue: TeamLifecycleCommandSnapshot;
  private readonly claims = new Map<
    string,
    {
      readonly fingerprint: CommandFingerprintRecord;
      readonly commandId: string;
      readonly outcome: TeamLifecycleClaimedOutcome;
    }
  >();

  readonly outbox: TeamLifecycleOutboxEvent[] = [];
  readonly acceptedPlanReferences: unknown[] = [];
  loadCalls = 0;
  failNextProgressSave = false;
  failNextEffectClaim = false;
  failNextEffectCompletion = false;
  failedEffectSettlement: SettleLifecycleLaneEffectRequest | null = null;
  beforeNextEffectClaim:
    | ((request: ClaimLifecycleLaneEffectRequest) => Promise<void> | void)
    | null = null;

  constructor(lifecycle: TeamLifecycle = createTestTeamLifecycle()) {
    this.snapshotValue = Object.freeze({
      lifecycle,
      currentRun: null,
      laneEffects: Object.freeze([]),
    });
  }

  get snapshot(): TeamLifecycleCommandSnapshot {
    return this.snapshotValue;
  }

  async load(): Promise<LoadTeamLifecycleCommandStateResult> {
    this.loadCalls += 1;
    return { status: 'found', snapshot: this.snapshotValue };
  }

  async resolveClaim(
    claim: TeamLifecycleDurableClaim
  ): Promise<ResolveTeamLifecycleCommandClaimResult> {
    const existing = this.claims.get(claimKey(claim));
    if (!existing) return { status: 'missing' };
    if (!sameFingerprint(existing.fingerprint, claim.fingerprint)) {
      return { status: 'idempotency_conflict' };
    }
    return { status: 'replayed', outcome: existing.outcome };
  }

  async acceptLaunchAtomically(
    request: AcceptLifecycleLaunchAtomicallyRequest
  ): Promise<LifecycleAtomicCommandResult> {
    const claim = this.claimOutcome(request.claim);
    if (claim.status !== 'new') return claim;
    if (this.snapshotValue.lifecycle.revision !== request.expectedLifecycleRevision) {
      return { status: 'stale_revision' };
    }
    if (!sameRunRef(this.snapshotValue.lifecycle.currentRunRef, request.expectedCurrentRunRef)) {
      return { status: 'stale_generation' };
    }
    if (
      request.nextLifecycle.currentRunRef?.runId !== request.run.runId ||
      request.nextLifecycle.currentRunRef.generation !== request.run.generation ||
      !sameRunRef(request.claim.targetRunRef, request.nextLifecycle.currentRunRef) ||
      request.nextLifecycle.fileWriterEpoch !== this.snapshotValue.lifecycle.fileWriterEpoch + 1 ||
      !sameWriterBarrierReceipt(
        request.nextLifecycle.writerBarrierReceipt,
        request.writerBarrierReceipt
      )
    ) {
      return { status: 'concurrency_conflict' };
    }
    this.snapshotValue = Object.freeze({
      lifecycle: request.nextLifecycle,
      currentRun: request.run,
      laneEffects: Object.freeze([...request.laneEffects]),
    });
    this.acceptedPlanReferences.push(request.run.plan);
    this.persistClaim(request.claim, canonicalOutcome(request.run));
    this.outbox.push(request.outbox);
    return { status: 'committed', snapshot: this.snapshotValue };
  }

  async beginRunCommandAtomically(
    request: BeginLifecycleRunCommandAtomicallyRequest
  ): Promise<LifecycleAtomicCommandResult> {
    const claim = this.claimOutcome(request.claim);
    if (claim.status !== 'new') return claim;
    const currentRun = this.snapshotValue.currentRun;
    if (
      this.snapshotValue.lifecycle.revision !== request.expectedLifecycleRevision ||
      currentRun?.revision !== request.expectedRunRevision ||
      !sameRunRef(this.snapshotValue.lifecycle.currentRunRef, request.runRef)
    ) {
      return { status: 'stale_generation' };
    }
    if (
      isTerminalLifecycleRun(currentRun) ||
      request.nextRun.plan !== currentRun.plan ||
      !sameRunRef(request.claim.targetRunRef, request.runRef)
    ) {
      return { status: 'stale_generation' };
    }
    const fenced = new Set(request.fencedLaneEffects.map(effectIdentityKey));
    if (
      fenced.size !== request.fencedLaneEffects.length ||
      request.fencedLaneEffects.some((identity) => {
        const effect = this.snapshotValue.laneEffects.find((candidate) =>
          sameEffectIdentity(candidate, identity)
        );
        return !effect || (effect.state !== 'attempting' && effect.state !== 'ambiguous');
      }) ||
      !validAppendedEffects(
        this.snapshotValue.laneEffects,
        request.appendedLaneEffects,
        request.runRef
      )
    ) {
      return { status: 'concurrency_conflict' };
    }
    const retainedEffects = this.snapshotValue.laneEffects.map((effect) =>
      fenced.has(effectIdentityKey(effect))
        ? Object.freeze({
            ...effect,
            state: 'ambiguous' as const,
            lease: null,
          })
        : effect
    );
    this.snapshotValue = Object.freeze({
      lifecycle: request.nextLifecycle,
      currentRun: request.nextRun,
      laneEffects: Object.freeze([...retainedEffects, ...request.appendedLaneEffects]),
    });
    this.persistClaim(request.claim, canonicalOutcome(request.nextRun));
    this.outbox.push(request.outbox);
    return { status: 'committed', snapshot: this.snapshotValue };
  }

  async saveRunProgress(
    request: SaveLifecycleRunProgressRequest
  ): Promise<SaveLifecycleRunProgressResult> {
    if (this.failNextProgressSave) {
      this.failNextProgressSave = false;
      return { status: 'concurrency_conflict' };
    }
    const currentRun = this.snapshotValue.currentRun;
    if (
      currentRun?.revision !== request.expectedRunRevision ||
      this.snapshotValue.lifecycle.revision !== request.expectedLifecycleRevision ||
      !sameRunRef(this.snapshotValue.lifecycle.currentRunRef, request.runRef) ||
      request.nextRun.plan !== currentRun.plan ||
      !sameWriterBarrierReceipt(
        this.snapshotValue.lifecycle.writerBarrierReceipt,
        request.expectedWriterBarrierReceipt
      ) ||
      isTerminalLifecycleRun(currentRun)
    ) {
      return { status: 'stale_generation' };
    }
    this.snapshotValue = Object.freeze({
      lifecycle: request.nextLifecycle,
      currentRun: request.nextRun,
      laneEffects: this.snapshotValue.laneEffects,
    });
    this.outbox.push(request.outbox);
    return { status: 'committed', snapshot: this.snapshotValue };
  }

  async claimNoopAtomically(
    request: ClaimLifecycleCommandNoopAtomicallyRequest
  ): Promise<LifecycleAtomicCommandResult> {
    const claim = this.claimOutcome(request.claim);
    if (claim.status !== 'new') return claim;
    const currentRun = this.snapshotValue.currentRun;
    if (
      currentRun?.revision !== request.expectedRunRevision ||
      this.snapshotValue.lifecycle.revision !== request.expectedLifecycleRevision ||
      !sameRunRef(this.snapshotValue.lifecycle.currentRunRef, request.runRef)
    ) {
      return { status: 'stale_generation' };
    }
    if (!sameRunRef(request.claim.targetRunRef, request.runRef)) {
      return { status: 'stale_generation' };
    }
    this.persistClaim(request.claim, canonicalOutcome(currentRun));
    return { status: 'committed', snapshot: this.snapshotValue };
  }

  async beginLegacyCommandAtomically(
    request: BeginLegacyRuntimeCommandAtomicallyRequest
  ): Promise<LifecycleAtomicCommandResult> {
    const claim = this.claimOutcome(request.claim);
    if (claim.status !== 'new') return claim;
    if (
      this.snapshotValue.lifecycle.revision !== request.expectedLifecycleRevision ||
      this.snapshotValue.lifecycle.cutover.mode !== 'legacy_drain'
    ) {
      return { status: 'stale_revision' };
    }
    if (request.claim.targetRunRef.generation !== request.generation) {
      return { status: 'stale_generation' };
    }
    this.snapshotValue = Object.freeze({
      lifecycle: request.nextLifecycle,
      currentRun: null,
      laneEffects: this.snapshotValue.laneEffects,
    });
    this.persistClaim(request.claim, legacyOutcome(request.generation));
    this.outbox.push(request.outbox);
    return { status: 'committed', snapshot: this.snapshotValue };
  }

  async saveLegacyProgress(
    request: SaveLegacyRuntimeProgressRequest
  ): Promise<SaveLegacyRuntimeProgressResult> {
    if (
      this.snapshotValue.lifecycle.revision !== request.expectedLifecycleRevision ||
      this.snapshotValue.currentRun !== null
    ) {
      return { status: 'stale_generation' };
    }
    this.snapshotValue = Object.freeze({
      lifecycle: request.nextLifecycle,
      currentRun: null,
      laneEffects: this.snapshotValue.laneEffects,
    });
    this.outbox.push(request.outbox);
    return { status: 'committed', snapshot: this.snapshotValue };
  }

  forceCurrentRunRef(runId: string, generation: number): void {
    this.snapshotValue = Object.freeze({
      ...this.snapshotValue,
      lifecycle: Object.freeze({
        ...this.snapshotValue.lifecycle,
        revision: this.snapshotValue.lifecycle.revision + 1,
        currentRunRef: Object.freeze({
          runId: parseRunId(runId),
          generation,
        }),
      }),
    });
  }

  expireLaneEffectLeases(): void {
    this.snapshotValue = Object.freeze({
      ...this.snapshotValue,
      laneEffects: Object.freeze(
        this.snapshotValue.laneEffects.map((effect) =>
          effect.lease
            ? Object.freeze({
                ...effect,
                lease: Object.freeze({
                  ...effect.lease,
                  expiresAtIso: '2000-01-01T00:00:00.000Z',
                }),
              })
            : effect
        )
      ),
    });
  }

  async claimLaneEffect(
    request: ClaimLifecycleLaneEffectRequest
  ): Promise<ClaimLifecycleLaneEffectResult> {
    const beforeClaim = this.beforeNextEffectClaim;
    if (beforeClaim) {
      this.beforeNextEffectClaim = null;
      await beforeClaim(request);
    }
    if (this.failNextEffectClaim) {
      this.failNextEffectClaim = false;
      return { status: 'unavailable' };
    }
    const currentRun = this.snapshotValue.currentRun;
    if (
      !sameRunRef(this.snapshotValue.lifecycle.currentRunRef, request.runRef) ||
      !sameWriterBarrierReceipt(
        this.snapshotValue.lifecycle.writerBarrierReceipt,
        request.expectedWriterBarrierReceipt
      )
    ) {
      return { status: 'stale_generation' };
    }
    const currentLane = currentRun?.lanes.find((lane) => lane.laneId === request.laneId);
    if (
      !currentRun ||
      !currentLane ||
      this.snapshotValue.lifecycle.revision !== request.expectedLifecycleRevision ||
      currentRun.revision !== request.expectedRunRevision ||
      currentRun.activeIntent !== request.expectedRunIntent ||
      currentLane.status !== request.expectedLaneStatus ||
      !validClaimTransition(this.snapshotValue, request)
    ) {
      return { status: 'concurrency_conflict' };
    }
    const index = this.effectIndex(
      request.kind,
      request.operationId,
      request.laneId,
      request.expectedLeaseFence
    );
    if (index < 0) return { status: 'stale_generation' };
    const current = this.snapshotValue.laneEffects.at(index);
    if (!current) return { status: 'stale_generation' };
    if (
      !sameRunRef(current.runRef, request.runRef) ||
      current.state !== request.expectedEffectState ||
      current.leaseFence !== request.expectedLeaseFence
    ) {
      return { status: 'concurrency_conflict' };
    }
    if (
      current.state === 'attempting' &&
      current.lease &&
      Date.parse(current.lease.expiresAtIso) > Date.parse(request.claimedAtIso)
    ) {
      return { status: 'busy', effect: current, snapshot: this.snapshotValue };
    }
    const previousState = current.state;
    if (
      previousState !== 'not_started' &&
      previousState !== 'attempting' &&
      previousState !== 'observed_absent' &&
      previousState !== 'ambiguous'
    ) {
      return { status: 'completed', effect: current, snapshot: this.snapshotValue };
    }
    const laneFence = this.snapshotValue.laneEffects.reduce(
      (maximum, candidate) =>
        sameRunRef(candidate.runRef, request.runRef) && candidate.laneId === request.laneId
          ? Math.max(maximum, candidate.leaseFence)
          : maximum,
      0
    );
    const lifecycleLease = Object.freeze({
      token: request.proposedLeaseToken,
      fence: laneFence + 1,
      ownerId: request.ownerId,
      claimedAtIso: request.claimedAtIso,
      expiresAtIso: request.leaseExpiresAtIso,
    });
    const proposed = request.proposedProviderMutation;
    const existingProviderMutation = proposed
      ? current.providerMutations[proposed.effectKind]
      : null;
    if (
      proposed &&
      (!validProviderMutationProposal(current, proposed) ||
        (existingProviderMutation &&
          !sameProviderMutationProposal(existingProviderMutation, proposed)))
    ) {
      return { status: 'concurrency_conflict' };
    }
    const effect = Object.freeze({
      ...current,
      state: 'attempting' as const,
      attempt: current.attempt + 1,
      leaseFence: laneFence + 1,
      lease: lifecycleLease,
      providerMutations: Object.freeze({
        ...current.providerMutations,
        ...(proposed && !existingProviderMutation
          ? {
              [proposed.effectKind]: Object.freeze({
                ...proposed,
                lease: lifecycleLease,
              }),
            }
          : {}),
      }),
    });
    const laneEffects = this.snapshotValue.laneEffects.map((candidate, candidateIndex) =>
      candidateIndex === index ? effect : candidate
    );
    this.snapshotValue = Object.freeze({
      lifecycle: request.nextLifecycle,
      currentRun: request.nextRun,
      laneEffects: Object.freeze(laneEffects),
    });
    if (request.transitionOutbox) this.outbox.push(request.transitionOutbox);
    return { status: 'claimed', previousState, effect, snapshot: this.snapshotValue };
  }

  async settleLaneEffect(
    request: SettleLifecycleLaneEffectRequest
  ): Promise<SettleLifecycleLaneEffectResult> {
    if (this.failNextEffectCompletion) {
      this.failNextEffectCompletion = false;
      this.failedEffectSettlement = request;
      return { status: 'unavailable' };
    }
    const currentRun = this.snapshotValue.currentRun;
    const index = this.effectIndex(
      request.kind,
      request.operationId,
      request.laneId,
      request.expectedLease.fence
    );
    const current = index >= 0 ? this.snapshotValue.laneEffects.at(index) : undefined;
    const evidence = request.settlement.evidence;
    if (
      !current ||
      !sameRunRef(current.runRef, request.runRef) ||
      current.state !== 'attempting' ||
      current.lease?.token !== request.expectedLease.token ||
      current.lease?.fence !== request.expectedLease.fence ||
      evidence.operationId !== request.operationId ||
      evidence.leaseFence !== request.expectedLease.fence
    ) {
      return { status: 'stale_lease' };
    }
    if (!isSettlementConsistent(this.snapshotValue, current, request)) {
      return { status: 'evidence_conflict' };
    }
    const causalIndices = causalSettlementIndices(this.snapshotValue, current, request);
    if (causalIndices === null) {
      return { status: 'evidence_conflict' };
    }
    if (
      currentRun?.revision !== request.expectedRunRevision ||
      this.snapshotValue.lifecycle.revision !== request.expectedLifecycleRevision ||
      !sameRunRef(this.snapshotValue.lifecycle.currentRunRef, request.runRef) ||
      !sameWriterBarrierReceipt(
        this.snapshotValue.lifecycle.writerBarrierReceipt,
        request.expectedWriterBarrierReceipt
      )
    ) {
      return { status: 'stale_generation' };
    }
    const settled = Object.freeze({
      ...current,
      state: request.settlement.state,
      lease: null,
      evidence,
    });
    const causalByIndex = new Map(
      causalIndices.map(({ index, settlement }) => [index, settlement])
    );
    const laneEffects = this.snapshotValue.laneEffects.map((candidate, candidateIndex) => {
      if (candidateIndex === index) return settled;
      const causalSettlement = causalByIndex.get(candidateIndex);
      return causalSettlement
        ? Object.freeze({
            ...candidate,
            state: causalSettlement.state,
            lease: null,
            evidence: causalSettlement.evidence,
          })
        : candidate;
    });
    if (!terminalLaneEffectsAreConclusive(request.nextRun, laneEffects)) {
      return { status: 'evidence_conflict' };
    }
    this.snapshotValue = Object.freeze({
      lifecycle: request.nextLifecycle,
      currentRun: request.nextRun,
      laneEffects: Object.freeze(laneEffects),
    });
    this.outbox.push(request.outbox);
    return { status: 'committed', snapshot: this.snapshotValue };
  }

  private claimOutcome(
    claim: TeamLifecycleDurableClaim
  ): { readonly status: 'new' } | LifecycleAtomicCommandResult {
    const existing = this.claims.get(claimKey(claim));
    if (!existing) return { status: 'new' };
    return sameFingerprint(existing.fingerprint, claim.fingerprint)
      ? { status: 'replayed', outcome: existing.outcome }
      : { status: 'idempotency_conflict' };
  }

  private persistClaim(
    claim: TeamLifecycleDurableClaim,
    outcome: TeamLifecycleClaimedOutcome
  ): void {
    this.claims.set(claimKey(claim), {
      commandId: claim.commandId,
      fingerprint: claim.fingerprint,
      outcome,
    });
  }

  private effectIndex(
    kind: LifecycleLaneEffectRecord['kind'],
    operationId: string,
    laneId: LaneId,
    leaseFence: number
  ): number {
    for (let index = this.snapshotValue.laneEffects.length - 1; index >= 0; index -= 1) {
      const effect = this.snapshotValue.laneEffects.at(index);
      if (!effect) continue;
      if (
        effect.kind === kind &&
        effect.operationId === operationId &&
        effect.laneId === laneId &&
        effect.leaseFence === leaseFence
      ) {
        return index;
      }
    }
    return -1;
  }
}

export class FakeTeamLifecycleFingerprint implements TeamLifecycleCommandFingerprintPort {
  async fingerprintCommand(
    request: FingerprintTeamLifecycleCommandRequest
  ): Promise<{ readonly status: 'fingerprinted'; readonly fingerprint: CommandFingerprintRecord }> {
    const digest = createHmac('sha256', TEST_DEPLOYMENT_ID)
      .update(request.prepared.encodedPreimage)
      .digest('hex');
    return {
      status: 'fingerprinted',
      fingerprint: buildCommandFingerprintRecord(
        request.prepared.preimage,
        'sandbox-key-v1',
        digest
      ),
    };
  }
}

type BackendOperation = 'preflight' | 'launch' | 'observe' | 'stop' | 'recover';
type MutatingBackendOperation = Extract<BackendOperation, 'launch' | 'recover' | 'stop'>;

interface FakeMutationRequest {
  readonly scope: unknown;
  readonly operationId?: string;
  readonly effectLease?: {
    readonly token: string;
    readonly fence: number;
    readonly ownerId: string;
    readonly claimedAtIso: string;
    readonly expiresAtIso: string;
  };
  readonly readiness?: unknown;
  readonly executionRef?: unknown;
  readonly mode?: unknown;
}

export class FakeLifecycleBackendRegistry implements LifecycleExecutionBackendRegistryPort {
  readonly calls: {
    readonly backend: RuntimeExecutionBackendKind;
    readonly laneId: LaneId;
    readonly operation: BackendOperation;
  }[] = [];
  readonly resolutionCount = new Map<string, number>();
  readonly executedScopes: unknown[] = [];
  readonly operationIds: string[] = [];
  readonly leaseFences: number[] = [];
  readonly mutationAuthorityCalls: {
    readonly backend: RuntimeExecutionBackendKind;
    readonly laneId: LaneId;
    readonly operation: MutatingBackendOperation;
    readonly requestJson: string;
  }[] = [];
  reconstructResolvedScope = false;
  widenResolvedProviders = false;
  onOperation:
    | ((call: {
        readonly backend: RuntimeExecutionBackendKind;
        readonly laneId: LaneId;
        readonly operation: BackendOperation;
      }) => void)
    | null = null;
  private readonly scripts = new Map<string, unknown[]>();
  private readonly launched = new Set<string>();
  private readonly mutationOutcomes = new Map<
    string,
    {
      readonly requestJson: string;
      readonly outcome: unknown;
      readonly status: 'completed' | 'unknown';
    }
  >();
  private readonly latestMutationByLane = new Map<
    string,
    {
      readonly operationId: string;
      readonly leaseFence: number;
      readonly status: 'completed' | 'unknown';
    }
  >();

  script(
    backend: RuntimeExecutionBackendKind,
    laneId: LaneId,
    operation: BackendOperation,
    ...outcomes: readonly unknown[]
  ): void {
    this.scripts.set(scriptKey(backend, laneId, operation), [...outcomes]);
  }

  resolve(plan: ReturnType<typeof createTestRuntimePlan>, laneId: LaneId) {
    const lane = plan.lanes.find((candidate) => candidate.laneId === laneId);
    const executionUnit = plan.executionUnits.find((candidate) => candidate.laneId === laneId);
    if (!lane || !executionUnit) return { status: 'rejected' as const, reason: 'lane_not_found' };
    const key = `${plan.planHash}:${laneId}`;
    this.resolutionCount.set(key, (this.resolutionCount.get(key) ?? 0) + 1);
    const backendKind = executionUnit.backendBinding.backend;
    const backend: LifecycleResolvedLaneBackend = {
      backend: backendKind,
      preflight: async () => {
        this.record(backendKind, laneId, 'preflight');
        return this.next(backendKind, laneId, 'preflight', {
          status: 'ready',
          readiness: {
            backend: backendKind,
            bindingId: executionUnit.backendBinding.bindingId,
            laneId,
            planHash: plan.planHash,
            bindingRevision: executionUnit.backendBinding.bindingRevision,
            providerRevisions: requiredProviders(plan, laneId).map((providerId) => ({
              providerId,
              capabilityRevision: 1,
            })),
          },
        });
      },
      launch: async (request) => {
        return await this.executeMutation(backendKind, laneId, 'launch', request, () => {
          this.record(backendKind, laneId, 'launch');
          this.captureEffectRequest(request);
          const fallback = {
            status: this.launched.has(key) ? ('already_launched' as const) : ('launched' as const),
            executionRef: `${backendKind}:${laneId}:execution`,
          };
          const outcome = this.next(backendKind, laneId, 'launch', fallback);
          if (
            isRecord(outcome) &&
            (outcome.status === 'launched' || outcome.status === 'already_launched')
          ) {
            this.launched.add(key);
          }
          return outcome;
        });
      },
      observe: async () => {
        this.record(backendKind, laneId, 'observe');
        return this.next(backendKind, laneId, 'observe', { status: 'ready' });
      },
      stop: async (request) => {
        return await this.executeMutation(backendKind, laneId, 'stop', request, () => {
          this.record(backendKind, laneId, 'stop');
          this.captureEffectRequest(request);
          const outcome = this.next(backendKind, laneId, 'stop', { status: 'stopped' });
          if (
            isRecord(outcome) &&
            (outcome.status === 'stopped' ||
              outcome.status === 'already_stopped' ||
              outcome.status === 'cancelled')
          ) {
            this.launched.delete(key);
          }
          return outcome;
        });
      },
      recover: async (request) => {
        return await this.executeMutation(backendKind, laneId, 'recover', request, () => {
          this.record(backendKind, laneId, 'recover');
          this.captureEffectRequest(request);
          return this.next(
            backendKind,
            laneId,
            'recover',
            this.launched.has(key)
              ? {
                  status: 'recovered',
                  executionRef: `${backendKind}:${laneId}:execution`,
                }
              : { status: 'not_started' }
          );
        });
      },
    } as LifecycleResolvedLaneBackend;
    const requiredProviderIds = requiredProviders(plan, laneId);
    const resolvedPlan = this.reconstructResolvedScope ? ({ ...plan } as typeof plan) : plan;
    return {
      status: 'resolved' as const,
      backend,
      scope: {
        plan: resolvedPlan,
        lane: this.reconstructResolvedScope ? { ...lane } : lane,
        executionUnit: this.reconstructResolvedScope ? { ...executionUnit } : executionUnit,
        requiredProviderIds: this.widenResolvedProviders
          ? [...requiredProviderIds, 'gemini' as const]
          : requiredProviderIds,
      },
    };
  }

  count(operation: BackendOperation, backend?: RuntimeExecutionBackendKind): number {
    return this.calls.filter(
      (call) => call.operation === operation && (!backend || call.backend === backend)
    ).length;
  }

  mutationAuthorityCount(
    operation: MutatingBackendOperation,
    backend?: RuntimeExecutionBackendKind
  ): number {
    return this.mutationAuthorityCalls.filter(
      (call) => call.operation === operation && (!backend || call.backend === backend)
    ).length;
  }

  private record(
    backend: RuntimeExecutionBackendKind,
    laneId: LaneId,
    operation: BackendOperation
  ): void {
    const call = { backend, laneId, operation };
    this.calls.push(call);
    this.onOperation?.(call);
  }

  private next<T>(
    backend: RuntimeExecutionBackendKind,
    laneId: LaneId,
    operation: BackendOperation,
    fallback: T
  ): T {
    const script = this.scripts.get(scriptKey(backend, laneId, operation));
    return (script?.shift() ?? fallback) as T;
  }

  private async executeMutation<T>(
    backend: RuntimeExecutionBackendKind,
    laneId: LaneId,
    operation: MutatingBackendOperation,
    request: FakeMutationRequest,
    effect: () => T | Promise<T>
  ): Promise<T> {
    const operationId = request.operationId;
    const effectLease = request.effectLease;
    if (!operationId || !effectLease) {
      throw new TypeError('lifecycle-effect-request-identity-missing');
    }
    const requestJson = JSON.stringify({
      backend,
      effectKind: operation,
      operationId,
      effectLease,
      payload:
        operation === 'launch'
          ? { effectKind: operation, scope: request.scope, readiness: request.readiness }
          : operation === 'stop'
            ? {
                effectKind: operation,
                scope: request.scope,
                executionRef: request.executionRef,
                mode: request.mode,
              }
            : { effectKind: operation, scope: request.scope },
    });
    this.mutationAuthorityCalls.push({ backend, laneId, operation, requestJson });

    const mutationScopeKey = fakeMutationScopeKey(request.scope);
    const operationKey = `${mutationScopeKey}:${operationId}`;
    const existing = this.mutationOutcomes.get(operationKey);
    if (existing) {
      if (existing.requestJson !== requestJson) {
        throw new TypeError('lifecycle-mutation-authority-tuple-mismatch');
      }
      return (
        existing.status === 'completed' ? existing.outcome : { status: 'operator_required' }
      ) as T;
    }

    const laneKey = `${mutationScopeKey}:${laneId}`;
    const latest = this.latestMutationByLane.get(laneKey);
    if (latest && (latest.status === 'unknown' || effectLease.fence <= latest.leaseFence)) {
      return { status: 'operator_required' } as T;
    }

    const outcome = await effect();
    const status = isCompletedMutationOutcome(operation, outcome) ? 'completed' : 'unknown';
    this.mutationOutcomes.set(operationKey, { requestJson, outcome, status });
    this.latestMutationByLane.set(laneKey, {
      operationId,
      leaseFence: effectLease.fence,
      status,
    });
    return outcome;
  }

  private captureEffectRequest(request: FakeMutationRequest): void {
    if (!request.operationId || !request.effectLease) {
      throw new TypeError('lifecycle-effect-request-identity-missing');
    }
    this.executedScopes.push(request.scope);
    this.operationIds.push(request.operationId);
    this.leaseFences.push(request.effectLease.fence);
  }
}

export class FakeExternalWriterBarrier implements TeamLifecycleExternalWriterBarrierPort {
  status: PrepareExternalWriterQuiescenceResult['status'] = 'quiescent';
  calls = 0;

  async prepareForLaunch(request: {
    readonly teamId: typeof TEST_TEAM_ID;
    readonly expectedFileWriterEpoch: number;
  }): Promise<PrepareExternalWriterQuiescenceResult> {
    this.calls += 1;
    if (this.status !== 'quiescent') return { status: this.status };
    return {
      status: 'quiescent',
      receipt: Object.freeze({
        schemaVersion: 1,
        barrierId: `writer_barrier_fixture_${this.calls}`,
        teamId: request.teamId,
        previousFileWriterEpoch: request.expectedFileWriterEpoch,
        nextFileWriterEpoch: request.expectedFileWriterEpoch + 1,
        drainedThrough: Object.freeze({
          fileWriterEpoch: request.expectedFileWriterEpoch,
          observationSequence: 10 + this.calls,
        }),
        preparedAtIso: '2026-01-01T00:00:00.000Z',
      }),
    };
  }
}

export class FakeLifecycleDeadline implements TeamLifecycleDeadlinePort {
  status: 'completed' | 'cancelled' | 'deadline_exceeded' = 'completed';
  readonly deadlines: { readonly timeoutMs: number; readonly expiresAtIso: string }[] = [];

  async run<T>(
    request: {
      readonly deadline: LifecycleOperationDeadline;
      readonly cancellation: TeamLifecycleCommandContext['cancellation'];
    },
    operation: () => Promise<T>
  ) {
    this.deadlines.push(request.deadline);
    if (this.status !== 'completed') return { status: this.status };
    return { status: 'completed' as const, value: await operation() };
  }
}

export class FakeProvisioningPreflight implements ProvisioningPreflightPort {
  calls = 0;

  async preflight() {
    this.calls += 1;
    return {
      status: 'ready' as const,
      lanes: Object.freeze([
        Object.freeze({
          laneKey: 'primary',
          backend: 'provisioning_cli' as const,
          status: 'ready' as const,
        }),
        Object.freeze({
          laneKey: 'secondary:opencode:reviewer',
          backend: 'opencode' as const,
          status: 'ready' as const,
        }),
      ]),
    };
  }
}

export class FakeLegacyRuntimeDrain implements LegacyRuntimeDrainPort {
  state: LegacyRuntimeGenerationState = 'active';
  cleanupVerified = false;

  async status() {
    return {
      status: 'observed' as const,
      state: this.state,
      cleanupVerified: this.cleanupVerified,
    };
  }

  async cancel() {
    this.state = 'terminal';
    return { status: 'cancelled' as const, cleanupVerified: this.cleanupVerified };
  }

  async stop() {
    this.state = 'terminal';
    return { status: 'stopped' as const, cleanupVerified: this.cleanupVerified };
  }

  async recover() {
    return {
      status: this.state === 'terminal' ? ('terminal' as const) : ('active' as const),
      cleanupVerified: this.cleanupVerified,
    };
  }
}

export function createTestTeamLifecycle(): TeamLifecycle {
  return createTeamLifecycle({
    deploymentId: TEST_DEPLOYMENT_ID,
    teamId: TEST_TEAM_ID,
    cutover: createCanonicalRuntimeCutover(),
  });
}

export function createTestRuntimePlan(
  input: {
    readonly generation?: number;
    readonly runCharacter?: string;
    readonly topology?: 'mixed' | 'primary';
  } = {}
) {
  const generation = input.generation ?? 1;
  const runCharacter = input.runCharacter ?? 'c';
  const topology = input.topology ?? 'mixed';
  const members =
    topology === 'mixed'
      ? [
          { name: 'builder', providerId: 'codex' as const },
          { name: 'reviewer', providerId: 'opencode' as const },
        ]
      : [{ name: 'builder', providerId: 'codex' as const }];
  const lanePlanResult = planTeamRuntimeLanes({
    leadProviderId: 'anthropic',
    members,
  });
  const primaryLaneId = parseLaneId('primary');
  const sideLaneId = parseLaneId('secondary:opencode:reviewer');
  const memberBindings = [
    {
      memberId: parseMemberId(`member_${'d'.repeat(32)}`),
      memberRevision: 1,
      legacyMemberKey: parseLegacyMemberKey('builder'),
      providerId: 'codex' as const,
      laneId: primaryLaneId,
      policy: 'required' as const,
    },
    ...(topology === 'mixed'
      ? [
          {
            memberId: parseMemberId(`member_${'e'.repeat(32)}`),
            memberRevision: 1,
            legacyMemberKey: parseLegacyMemberKey('reviewer'),
            providerId: 'opencode' as const,
            laneId: sideLaneId,
            policy: 'required' as const,
          },
        ]
      : []),
  ];
  const laneIds = topology === 'mixed' ? [primaryLaneId, sideLaneId] : [primaryLaneId];
  return createCompositeRuntimePlan({
    teamId: TEST_TEAM_ID,
    runId: parseRunId(`run_${runCharacter.repeat(32)}`),
    generation,
    leadProviderId: 'anthropic',
    lanePlanResult,
    rosterGeneration: 1,
    memberBindings,
    laneCredentials: laneIds.map((laneId) => ({
      laneId,
      requiredCredentialExposureSet: { secretRefs: [] },
    })),
    workspaceBinding: {
      workspaceId: parseWorkspaceId(`workspace_${'f'.repeat(32)}`),
      registrationRevision: 1,
      bindingGeneration: 1,
      mountGeneration: 1,
    },
    executionUnits: laneIds.map((laneId, index) =>
      executionUnit(
        index === 0 ? 'primary' : 'side',
        laneId,
        index === 0 ? 'provisioning_cli' : 'opencode',
        String(index + 1)
      )
    ),
  });
}

export function createTestContext(): TeamLifecycleCommandContext {
  return {
    deploymentId: TEST_DEPLOYMENT_ID,
    stableActorId: 'operator_fixture',
    cancellation: {
      cancellationId: 'cancel_fixture',
      isCancellationRequested: () => false,
    },
  };
}

export function createTestClock() {
  let tick = 0;
  return {
    nowIso: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(),
  };
}

export function createTestIds() {
  let sequence = 0;
  return {
    createEventId: () => `event_fixture_${++sequence}`,
    createLeaseToken: () => `lease_fixture_${++sequence}`,
  };
}

function executionUnit(
  suffix: string,
  laneId: LaneId,
  backend: RuntimeExecutionBackendKind,
  hashCharacter: string
) {
  return {
    executionUnitId: parseExecutionUnitId(`unit-${suffix}`),
    backendBinding: {
      backend,
      bindingId: parseRuntimeBackendBindingId(`binding-${suffix}`),
      bindingRevision: 1,
    },
    laneId,
    binaryPolicy: {
      policy: 'registered_exact_binary' as const,
      binaryId: parseRuntimeBinaryId(`binary-${suffix}`),
      binaryRevision: 1,
      binaryHash: hash(hashCharacter),
    },
    environmentPolicy: { policy: 'explicit_allowlist' as const, variables: [] },
    credentialExposureSet: { secretRefs: [] },
    resourcePolicy: {
      maxRuntimeMs: 30_000,
      gracefulStopMs: 2_000,
      maxOutputBytes: 100_000,
      maxProcessCount: 2,
    },
  };
}

function requiredProviders(
  plan: ReturnType<typeof createTestRuntimePlan>,
  laneId: LaneId
): readonly TeamProviderId[] {
  const providers: TeamProviderId[] = [];
  const lane = plan.lanes.find((candidate) => candidate.laneId === laneId);
  if (lane?.laneKind === 'primary') providers.push(plan.leadProviderId);
  for (const member of plan.memberBindings.filter((candidate) => candidate.laneId === laneId)) {
    if (!providers.includes(member.providerId)) providers.push(member.providerId);
  }
  return Object.freeze(providers);
}

function isCompletedMutationOutcome(
  operation: MutatingBackendOperation,
  outcome: unknown
): boolean {
  if (!isRecord(outcome) || typeof outcome.status !== 'string') return false;
  if (outcome.status === 'rejected') {
    return (
      typeof outcome.reason === 'string' &&
      [
        'cancelled',
        'invalid_plan',
        'unsupported',
        'unavailable',
        'capability_mismatch',
        'readiness_mismatch',
        'stale_plan',
        'not_owned',
      ].includes(outcome.reason)
    );
  }
  if (operation === 'launch') {
    return (
      (outcome.status === 'launched' || outcome.status === 'already_launched') &&
      typeof outcome.executionRef === 'string' &&
      outcome.executionRef.length > 0
    );
  }
  if (operation === 'stop') {
    return (
      outcome.status === 'stopped' ||
      outcome.status === 'already_stopped' ||
      outcome.status === 'cancelled'
    );
  }
  return (
    outcome.status === 'not_started' ||
    outcome.status === 'cancelled' ||
    (outcome.status === 'recovered' &&
      typeof outcome.executionRef === 'string' &&
      outcome.executionRef.length > 0)
  );
}

function fakeMutationScopeKey(scope: unknown): string {
  if (!isRecord(scope) || !isRecord(scope.plan)) {
    throw new TypeError('lifecycle-mutation-authority-scope-invalid');
  }
  const { teamId, runId, generation } = scope.plan;
  if (
    typeof teamId !== 'string' ||
    typeof runId !== 'string' ||
    !Number.isSafeInteger(generation)
  ) {
    throw new TypeError('lifecycle-mutation-authority-scope-invalid');
  }
  return `${teamId}:${runId}:${String(generation)}`;
}

function hash(character: string): Sha256Hash {
  return `sha256:${createHash('sha256').update(character).digest('hex')}`;
}

function claimKey(claim: TeamLifecycleDurableClaim): string {
  const scope = claim.scope;
  return `${scope.deploymentId}|${scope.stableActorId}|${scope.commandKind}|${scope.idempotencyKey}`;
}

function sameFingerprint(left: CommandFingerprintRecord, right: CommandFingerprintRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

type ProviderMutation = NonNullable<
  LifecycleLaneEffectRecord['providerMutations'][keyof LifecycleLaneEffectRecord['providerMutations']]
>;
type ProviderMutationProposal = NonNullable<
  ClaimLifecycleLaneEffectRequest['proposedProviderMutation']
>;

function validProviderMutationProposal(
  effect: LifecycleLaneEffectRecord,
  proposal: ProviderMutationProposal
): boolean {
  const scope = proposal.scope;
  const expectedKind =
    effect.kind === 'launch' ? 'launch' : effect.kind === 'recover' ? 'recover' : null;
  const expectedOperationId =
    effect.kind === 'drain' && proposal.effectKind === 'recover'
      ? `recover:${effect.runRef.runId}:${effect.runRef.generation}:${scope.lane.ordinal}:${effect.commandFingerprintDigest}`
      : effect.operationId;
  if (
    (expectedKind !== null && proposal.effectKind !== expectedKind) ||
    (effect.kind === 'drain' &&
      proposal.effectKind !== 'stop' &&
      proposal.effectKind !== 'recover') ||
    proposal.operationId !== expectedOperationId ||
    scope.plan.runId !== effect.runRef.runId ||
    scope.plan.generation !== effect.runRef.generation ||
    scope.lane.laneId !== effect.laneId ||
    scope.executionUnit.laneId !== effect.laneId ||
    scope.executionUnit.backendBinding.backend !== proposal.backend
  ) {
    return false;
  }
  if (proposal.effectKind === 'launch') {
    return (
      proposal.readiness !== null &&
      proposal.readiness.backend === proposal.backend &&
      proposal.readiness.laneId === effect.laneId &&
      proposal.readiness.planHash === scope.plan.planHash &&
      proposal.executionRef === null &&
      proposal.mode === null
    );
  }
  if (proposal.effectKind === 'stop') {
    return (
      proposal.readiness === null &&
      typeof proposal.executionRef === 'string' &&
      proposal.executionRef.length > 0 &&
      proposal.mode !== null
    );
  }
  return proposal.readiness === null && proposal.executionRef === null && proposal.mode === null;
}

function sameProviderMutationProposal(
  existing: ProviderMutation,
  proposal: ProviderMutationProposal
): boolean {
  const { lease: _lease, ...existingProposal } = existing;
  return JSON.stringify(existingProposal) === JSON.stringify(proposal);
}

function effectIdentityKey(identity: {
  readonly runRef: LifecycleLaneEffectRecord['runRef'];
  readonly kind: LifecycleLaneEffectRecord['kind'];
  readonly laneId: LaneId;
  readonly operationId: string;
  readonly leaseFence: number;
}): string {
  return [
    identity.runRef.runId,
    identity.runRef.generation,
    identity.kind,
    identity.laneId,
    identity.operationId,
    identity.leaseFence,
  ].join('|');
}

function sameEffectIdentity(
  effect: LifecycleLaneEffectRecord,
  identity: {
    readonly runRef: LifecycleLaneEffectRecord['runRef'];
    readonly kind: LifecycleLaneEffectRecord['kind'];
    readonly laneId: LaneId;
    readonly operationId: string;
    readonly leaseFence: number;
  }
): boolean {
  return effectIdentityKey(effect) === effectIdentityKey(identity);
}

function sameCausalEffectIdentity(
  effect: LifecycleLaneEffectRecord,
  identity: NonNullable<LifecycleLaneEffectRecord['causalPredecessor']>
): boolean {
  return (
    sameRunRef(effect.runRef, identity.runRef) &&
    effect.kind === identity.kind &&
    effect.laneId === identity.laneId &&
    effect.operationId === identity.operationId
  );
}

function validAppendedEffects(
  existing: readonly LifecycleLaneEffectRecord[],
  appended: readonly LifecycleLaneEffectRecord[],
  runRef: TeamLifecycle['currentRunRef']
): boolean {
  const appendedKeys = new Set<string>();
  for (const effect of appended) {
    const key = `${effect.kind}|${effect.laneId}`;
    if (
      appendedKeys.has(key) ||
      !runRef ||
      !sameRunRef(effect.runRef, runRef) ||
      effect.state !== 'not_started' ||
      effect.attempt !== 0 ||
      effect.lease !== null ||
      Object.keys(effect.providerMutations).length !== 0 ||
      effect.evidence !== null
    ) {
      return false;
    }
    appendedKeys.add(key);
    const causal =
      existing.findLast(
        (candidate) => sameRunRef(candidate.runRef, runRef) && candidate.laneId === effect.laneId
      ) ?? null;
    if (
      causal
        ? effect.operationId === causal.operationId ||
          effect.leaseFence !== causal.leaseFence ||
          !effect.causalPredecessor ||
          !sameCausalEffectIdentity(causal, effect.causalPredecessor)
        : effect.leaseFence !== 0 || effect.causalPredecessor !== null
    ) {
      return false;
    }
  }
  return true;
}

function validClaimTransition(
  snapshot: TeamLifecycleCommandSnapshot,
  request: ClaimLifecycleLaneEffectRequest
): boolean {
  const currentRun = snapshot.currentRun;
  const currentLane = currentRun?.lanes.find((lane) => lane.laneId === request.laneId);
  if (!currentRun || !currentLane) return false;
  if (request.nextRun === currentRun) {
    return request.nextLifecycle === snapshot.lifecycle && request.transitionOutbox === null;
  }
  if (request.kind !== 'launch' || currentLane.status !== 'queued') return false;
  try {
    const expectedRun = markLifecycleLaneLaunching(currentRun, request.laneId);
    const expectedLifecycle = applyCurrentRunStatus(
      snapshot.lifecycle,
      request.runRef,
      expectedRun.status
    );
    return (
      request.nextRun.plan === currentRun.plan &&
      JSON.stringify(request.nextRun) === JSON.stringify(expectedRun) &&
      JSON.stringify(request.nextLifecycle) === JSON.stringify(expectedLifecycle) &&
      request.transitionOutbox?.eventType === 'team-lifecycle.lane-launching' &&
      request.transitionOutbox.semanticRevision === expectedLifecycle.revision
    );
  } catch {
    return false;
  }
}

const SETTLEMENT_EVIDENCE_MATRIX = Object.freeze([
  { effectKind: 'launch', state: 'observed_succeeded', evidenceKind: 'launch_receipt' },
  { effectKind: 'launch', state: 'observed_absent', evidenceKind: 'absence_evidence' },
  { effectKind: 'launch', state: 'ambiguous', evidenceKind: 'ambiguous_evidence' },
  { effectKind: 'drain', state: 'observed_succeeded', evidenceKind: 'drain_receipt' },
  { effectKind: 'drain', state: 'observed_absent', evidenceKind: 'absence_evidence' },
  {
    effectKind: 'drain',
    state: 'observed_absent',
    evidenceKind: 'causal_absence_evidence',
  },
  { effectKind: 'drain', state: 'ambiguous', evidenceKind: 'ambiguous_evidence' },
  { effectKind: 'recover', state: 'observed_succeeded', evidenceKind: 'recovery_receipt' },
  {
    effectKind: 'recover',
    state: 'observed_absent',
    evidenceKind: 'causal_absence_evidence',
  },
  { effectKind: 'recover', state: 'ambiguous', evidenceKind: 'ambiguous_evidence' },
] as const);

function isSettlementConsistent(
  snapshot: TeamLifecycleCommandSnapshot,
  effect: LifecycleLaneEffectRecord,
  request: SettleLifecycleLaneEffectRequest
): boolean {
  const currentRun = snapshot.currentRun;
  const settlement = request.settlement;
  const matrix = SETTLEMENT_EVIDENCE_MATRIX.find(
    (row) =>
      row.effectKind === effect.kind &&
      row.state === settlement.state &&
      row.evidenceKind === settlement.evidence.kind
  );
  if (
    !currentRun ||
    matrix?.evidenceKind !== settlement.evidence.kind ||
    settlement.evidence.schemaVersion !== 1
  ) {
    return false;
  }
  if (
    (settlement.evidence.kind === 'absence_evidence' ||
      settlement.evidence.kind === 'causal_absence_evidence') &&
    settlement.evidence.effectKind !== effect.kind
  ) {
    return false;
  }
  try {
    const projectedRun = projectSettledRun(currentRun, effect, request);
    if (!projectedRun) return false;
    const projectedLifecycle =
      projectedRun === currentRun
        ? snapshot.lifecycle
        : applyCurrentRunStatus(snapshot.lifecycle, request.runRef, projectedRun.status);
    return (
      request.nextRun.plan === currentRun.plan &&
      (projectedRun === currentRun
        ? request.nextRun === currentRun
        : JSON.stringify(request.nextRun) === JSON.stringify(projectedRun)) &&
      JSON.stringify(request.nextLifecycle) === JSON.stringify(projectedLifecycle) &&
      request.outbox.semanticRevision === projectedLifecycle.revision
    );
  } catch {
    return false;
  }
}

function causalSettlementIndices(
  snapshot: TeamLifecycleCommandSnapshot,
  provingEffect: LifecycleLaneEffectRecord,
  request: SettleLifecycleLaneEffectRequest
):
  | readonly {
      readonly index: number;
      readonly settlement: SettleLifecycleLaneEffectRequest['causalSettlements'][number]['settlement'];
    }[]
  | null {
  if (request.causalSettlements.length === 0) return Object.freeze([]);
  if (
    provingEffect.kind !== 'recover' ||
    request.settlement.state !== 'observed_succeeded' ||
    request.settlement.evidence.kind !== 'recovery_receipt' ||
    request.settlement.evidence.disposition !== 'not_started'
  ) {
    return null;
  }
  const expectedIndices = causalPredecessorIndices(snapshot, provingEffect);
  if (expectedIndices === null || expectedIndices.size !== request.causalSettlements.length) {
    return null;
  }
  const seen = new Set<number>();
  const resolved = [];
  for (const causal of request.causalSettlements) {
    const index = snapshot.laneEffects.findIndex(
      (effect) =>
        effect.kind === causal.kind &&
        effect.laneId === causal.laneId &&
        effect.operationId === causal.operationId &&
        effect.leaseFence === causal.expectedLeaseFence
    );
    const effect = index >= 0 ? snapshot.laneEffects.at(index) : undefined;
    const evidence = causal.settlement.evidence;
    if (
      !effect ||
      seen.has(index) ||
      !expectedIndices.has(index) ||
      effect === provingEffect ||
      !sameRunRef(effect.runRef, request.runRef) ||
      !sameRunRef(causal.runRef, request.runRef) ||
      effect.laneId !== provingEffect.laneId ||
      effect.state !== causal.expectedEffectState ||
      (effect.lease !== null &&
        Date.parse(effect.lease.expiresAtIso) > Date.parse(request.expectedLease.claimedAtIso)) ||
      causal.settlement.state !== 'observed_absent' ||
      evidence.kind !== 'causal_absence_evidence' ||
      evidence.effectKind !== effect.kind ||
      evidence.operationId !== effect.operationId ||
      evidence.leaseFence !== effect.leaseFence ||
      evidence.proof !== 'recovery_not_started' ||
      evidence.provingOperationId !== provingEffect.operationId ||
      evidence.provingLeaseFence !== request.expectedLease.fence
    ) {
      return null;
    }
    seen.add(index);
    resolved.push(Object.freeze({ index, settlement: causal.settlement }));
  }
  return Object.freeze(resolved);
}

function causalPredecessorIndices(
  snapshot: TeamLifecycleCommandSnapshot,
  provingEffect: LifecycleLaneEffectRecord
): ReadonlySet<number> | null {
  const indices = new Set<number>();
  const visited = new Set<number>();
  let identity = provingEffect.causalPredecessor;
  while (identity) {
    const index = snapshot.laneEffects.findIndex((effect) =>
      sameCausalEffectIdentity(effect, identity!)
    );
    if (index < 0 || visited.has(index)) return null;
    visited.add(index);
    const effect = snapshot.laneEffects.at(index);
    if (!effect) return null;
    if (
      (effect.kind === 'drain' || effect.kind === 'recover') &&
      !isConclusiveEffectState(effect.state)
    ) {
      indices.add(index);
    }
    identity = effect.causalPredecessor;
  }
  return indices;
}

function terminalLaneEffectsAreConclusive(
  run: NonNullable<TeamLifecycleCommandSnapshot['currentRun']>,
  effects: readonly LifecycleLaneEffectRecord[]
): boolean {
  return run.lanes.every((lane) => {
    if (lane.status !== 'stopped' && lane.status !== 'cancelled') return true;
    return effects
      .filter(
        (effect) =>
          effect.runRef.runId === run.runId &&
          effect.runRef.generation === run.generation &&
          effect.laneId === lane.laneId &&
          (effect.kind === 'drain' || effect.kind === 'recover')
      )
      .every((effect) => isConclusiveEffectState(effect.state));
  });
}

function isConclusiveEffectState(state: LifecycleLaneEffectRecord['state']): boolean {
  return state === 'observed_succeeded' || state === 'observed_absent';
}

function projectSettledRun(
  currentRun: NonNullable<TeamLifecycleCommandSnapshot['currentRun']>,
  effect: LifecycleLaneEffectRecord,
  request: SettleLifecycleLaneEffectRequest
): NonNullable<TeamLifecycleCommandSnapshot['currentRun']> | null {
  const settlement = request.settlement;
  if (settlement.state === 'observed_succeeded') {
    return projectSucceededRun(currentRun, effect, settlement);
  }
  if (settlement.state === 'observed_absent') {
    return projectAbsentRun(currentRun, effect, request, settlement);
  }
  return projectAmbiguousRun(currentRun, effect, request);
}

function projectSucceededRun(
  currentRun: NonNullable<TeamLifecycleCommandSnapshot['currentRun']>,
  effect: LifecycleLaneEffectRecord,
  settlement: Extract<
    SettleLifecycleLaneEffectRequest['settlement'],
    { readonly state: 'observed_succeeded' }
  >
): NonNullable<TeamLifecycleCommandSnapshot['currentRun']> | null {
  const evidence = settlement.evidence;
  if (effect.kind === 'launch' && evidence.kind === 'launch_receipt') {
    if (evidence.disposition === 'recovered') {
      return applyLifecycleLaneRecovery(currentRun, effect.laneId, {
        status: 'recovered',
        executionRef: evidence.executionRef,
      });
    }
    return applyLifecycleLaneLaunch(currentRun, effect.laneId, {
      status: evidence.disposition,
      executionRef: evidence.executionRef,
    });
  }
  if (effect.kind === 'drain' && evidence.kind === 'drain_receipt') {
    const status =
      evidence.disposition === 'absence_verified' ? 'already_stopped' : evidence.disposition;
    return applyLifecycleLaneStop(currentRun, effect.laneId, { status });
  }
  if (effect.kind !== 'recover' || evidence.kind !== 'recovery_receipt') return null;
  if (evidence.disposition === 'not_started') {
    if (evidence.executionRef !== null) return null;
    return applyLifecycleLaneRecovery(
      currentRun,
      effect.laneId,
      { status: 'not_started' },
      recoveryAbsenceDisposition(currentRun)
    );
  }
  if (!evidence.executionRef) return null;
  return applyLifecycleLaneRecovery(currentRun, effect.laneId, {
    status: 'recovered',
    executionRef: evidence.executionRef,
  });
}

function projectAbsentRun(
  currentRun: NonNullable<TeamLifecycleCommandSnapshot['currentRun']>,
  effect: LifecycleLaneEffectRecord,
  request: SettleLifecycleLaneEffectRequest,
  settlement: Extract<
    SettleLifecycleLaneEffectRequest['settlement'],
    { readonly state: 'observed_absent' }
  >
): NonNullable<TeamLifecycleCommandSnapshot['currentRun']> | null {
  const evidence = settlement.evidence;
  if (
    effect.kind === 'launch' &&
    evidence.proof === 'runtime_absence_observed' &&
    request.outbox.eventType === 'team-lifecycle.lane-launch-absence-proven'
  ) {
    return currentRun;
  }
  const nextLane = request.nextRun.lanes.find((lane) => lane.laneId === effect.laneId);
  if (
    effect.kind === 'launch' &&
    evidence.proof === 'effect_not_invoked' &&
    request.outbox.eventType === 'team-lifecycle.lane-preflight-rejected' &&
    nextLane?.status === 'failed' &&
    nextLane.executionRef === null &&
    nextLane.diagnostic?.startsWith('runtime-preflight-')
  ) {
    return applyLifecycleLaneLaunch(currentRun, effect.laneId, {
      status: 'rejected',
      diagnostic: nextLane.diagnostic,
    });
  }
  if (
    effect.kind === 'drain' &&
    evidence.proof === 'effect_not_invoked' &&
    request.outbox.eventType === 'team-lifecycle.lane-drain-incomplete' &&
    nextLane?.status === 'starting' &&
    nextLane.executionRef
  ) {
    return applyLifecycleLaneRecovery(currentRun, effect.laneId, {
      status: 'recovered',
      executionRef: nextLane.executionRef,
    });
  }
  return null;
}

function projectAmbiguousRun(
  currentRun: NonNullable<TeamLifecycleCommandSnapshot['currentRun']>,
  effect: LifecycleLaneEffectRecord,
  request: SettleLifecycleLaneEffectRequest
): NonNullable<TeamLifecycleCommandSnapshot['currentRun']> | null {
  const nextLane = request.nextRun.lanes.find((lane) => lane.laneId === effect.laneId);
  if (!nextLane?.diagnostic) return null;
  const operatorRequired = nextLane.status === 'operator_required';
  if (effect.kind === 'launch') {
    if (operatorRequired) {
      return applyLifecycleLaneLaunch(currentRun, effect.laneId, {
        status: 'operator_required',
        diagnostic: nextLane.diagnostic,
      });
    }
    if (nextLane.status !== 'failed') return null;
    return applyLifecycleLaneLaunch(currentRun, effect.laneId, {
      status: 'rejected',
      diagnostic: nextLane.diagnostic,
    });
  }
  if (effect.kind === 'drain') {
    if (operatorRequired) {
      return applyLifecycleLaneStop(currentRun, effect.laneId, {
        status: 'operator_required',
        diagnostic: nextLane.diagnostic,
      });
    }
    if (nextLane.status !== 'degraded') return null;
    return applyLifecycleLaneStop(currentRun, effect.laneId, {
      status: 'rejected',
      diagnostic: nextLane.diagnostic,
    });
  }
  if (operatorRequired) {
    return applyLifecycleLaneRecovery(currentRun, effect.laneId, {
      status: 'operator_required',
      diagnostic: nextLane.diagnostic,
    });
  }
  if (nextLane.status !== 'degraded') return null;
  return applyLifecycleLaneRecovery(currentRun, effect.laneId, {
    status: 'rejected',
    diagnostic: nextLane.diagnostic,
  });
}

function recoveryAbsenceDisposition(
  run: NonNullable<TeamLifecycleCommandSnapshot['currentRun']>
): 'queued' | 'cancelled' | 'stopped' {
  if (run.activeIntent === 'cancel') return 'cancelled';
  if (run.activeIntent === 'stop') return 'stopped';
  return 'queued';
}

function canonicalOutcome(
  run: NonNullable<TeamLifecycleCommandSnapshot['currentRun']>
): TeamLifecycleClaimedOutcome {
  return Object.freeze({
    kind: 'canonical_run',
    run: lifecycleRunStatusView(run),
  });
}

function legacyOutcome(generation: number): TeamLifecycleClaimedOutcome {
  return Object.freeze({ kind: 'legacy_generation', generation });
}

function sameRunRef(
  left: TeamLifecycle['currentRunRef'],
  right: TeamLifecycle['currentRunRef']
): boolean {
  return left === null
    ? right === null
    : right !== null && left.runId === right.runId && left.generation === right.generation;
}

function sameWriterBarrierReceipt(
  left: LifecycleWriterBarrierReceipt | null,
  right: LifecycleWriterBarrierReceipt
): boolean {
  return (
    left?.barrierId === right.barrierId &&
    left.teamId === right.teamId &&
    left.previousFileWriterEpoch === right.previousFileWriterEpoch &&
    left.nextFileWriterEpoch === right.nextFileWriterEpoch &&
    left.drainedThrough.fileWriterEpoch === right.drainedThrough.fileWriterEpoch &&
    left.drainedThrough.observationSequence === right.drainedThrough.observationSequence
  );
}

function scriptKey(
  backend: RuntimeExecutionBackendKind,
  laneId: LaneId,
  operation: BackendOperation
): string {
  return `${backend}:${laneId}:${operation}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
