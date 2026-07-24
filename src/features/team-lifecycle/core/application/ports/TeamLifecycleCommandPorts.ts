import {
  COMMAND_IDEMPOTENCY_SCOPE,
  type CommandClaimScope,
  type CommandDescriptor,
  type CommandFingerprintRecord,
  createCommandClaimScope,
  type DurableCommandDescriptorIdentity,
  HMAC_SHA256_LD_V1,
  type NormalizedCommandIntent,
  prepareCommandFingerprint,
  type PreparedCommandFingerprint,
} from '@features/application-command-ledger';

import type {
  CancelProvisioningRequest,
  LaunchTeamRequest,
  LifecycleRunRef,
  LifecycleRunStatusView,
  ProvisioningPreflightLaneView,
  RecoverTeamRunRequest,
  StopTeamRequest,
} from '../../../contracts';
import type {
  LegacyRuntimeCutover,
  LegacyRuntimeGenerationState,
  LifecycleRun,
  LifecycleWriterBarrierReceipt,
  TeamLifecycle,
} from '../../domain';
import type {
  CompositeRuntimePlan,
  CompositeRuntimePlanHash,
  LaneId,
  ProcessExecutionUnit,
  RuntimeBackendBindingId,
  RuntimeExecutionBackendKind,
  RuntimePlanLaneBinding,
} from '@features/team-runtime-control';
import type { DeploymentId, TeamId } from '@shared/contracts/hosted';
import type { TeamProviderId } from '@shared/types';
export type TeamLifecycleCommandKind =
  | 'team_lifecycle.launch'
  | 'team_lifecycle.cancel'
  | 'team_lifecycle.stop'
  | 'team_lifecycle.recover';
const ACCEPT_EFFECT = Object.freeze({
  effectId: 'accept-lifecycle-command',
  effectVersion: 1,
  recoveryClass: 'transactional_local' as const,
  evidenceSchemaVersion: 1,
});
const RUNTIME_EFFECT = Object.freeze({
  effectId: 'execute-lifecycle-runtime',
  effectVersion: 1,
  recoveryClass: 'reconcilable_by_unique_evidence' as const,
  evidenceSchemaVersion: 1,
});
function descriptor<TInput>(
  commandKind: TeamLifecycleCommandKind,
  project: (input: TInput) => NormalizedCommandIntent
): CommandDescriptor<TInput, TeamLifecycleCommandKind> {
  return Object.freeze({
    descriptorId: commandKind,
    descriptorVersion: 1,
    commandKind,
    inputSchemaVersion: 1,
    fingerprintVersion: HMAC_SHA256_LD_V1,
    effectPlanVersion: 1,
    idempotencyScope: COMMAND_IDEMPOTENCY_SCOPE,
    retentionClass: 'team-lifecycle-command',
    normalizedIntentProjection: project,
    effects: Object.freeze([ACCEPT_EFFECT, RUNTIME_EFFECT] as const),
  });
}
export const TEAM_LIFECYCLE_DURABLE_COMMAND_DESCRIPTORS = Object.freeze([
  descriptor<LaunchTeamRequest>('team_lifecycle.launch', (input) => ({
    expectedCurrentRunRef: input.expectedCurrentRunRef
      ? {
          generation: input.expectedCurrentRunRef.generation,
          runId: input.expectedCurrentRunRef.runId,
        }
      : null,
    expectedLifecycleRevision: input.expectedLifecycleRevision,
    generation: input.plan.generation,
    planHash: input.plan.planHash,
    runId: input.plan.runId,
    teamId: input.teamId,
  })),
  descriptor<CancelProvisioningRequest>('team_lifecycle.cancel', (input) => ({
    expectedLifecycleRevision: input.expectedLifecycleRevision,
    generation: input.runRef.generation,
    runId: input.runRef.runId,
    teamId: input.teamId,
  })),
  descriptor<StopTeamRequest>('team_lifecycle.stop', (input) => ({
    expectedLifecycleRevision: input.expectedLifecycleRevision,
    generation: input.runRef.generation,
    mode: input.mode,
    runId: input.runRef.runId,
    teamId: input.teamId,
  })),
  descriptor<RecoverTeamRunRequest>('team_lifecycle.recover', (input) => ({
    expectedLifecycleRevision: input.expectedLifecycleRevision,
    generation: input.runRef.generation,
    runId: input.runRef.runId,
    teamId: input.teamId,
  })),
]);
export interface TeamLifecycleCommandContext {
  readonly deploymentId: DeploymentId;
  readonly stableActorId: string;
  readonly cancellation: LifecycleCancellation;
}
export interface LifecycleCancellation {
  readonly cancellationId: string;
  readonly isCancellationRequested: () => boolean;
}
export type TeamLifecycleClockPort = Readonly<{ nowIso(): string }>;
export interface TeamLifecycleIdFactoryPort {
  createEventId(): string;
  createLeaseToken(): string;
}
export const TEAM_LIFECYCLE_PREPARATION_TIMEOUT_MS = 30_000 as const;
export const TEAM_LIFECYCLE_EFFECT_LEASE_DURATION_MS = 30_000 as const;
export interface LifecycleOperationDeadline {
  readonly startedAtIso: string;
  readonly expiresAtIso: string;
  readonly timeoutMs: number;
}
export type RunWithinLifecycleDeadlineResult<T> =
  | { readonly status: 'completed'; readonly value: T }
  | { readonly status: 'cancelled' | 'deadline_exceeded' };
export interface TeamLifecycleDeadlinePort {
  run<T>(
    request: {
      readonly deadline: LifecycleOperationDeadline;
      readonly cancellation: LifecycleCancellation;
    },
    operation: () => Promise<T>
  ): Promise<RunWithinLifecycleDeadlineResult<T>>;
}
export interface FingerprintTeamLifecycleCommandRequest {
  readonly scope: CommandClaimScope<TeamLifecycleCommandKind>;
  readonly prepared: PreparedCommandFingerprint;
}
export type FingerprintTeamLifecycleCommandResult =
  | { readonly status: 'fingerprinted'; readonly fingerprint: CommandFingerprintRecord }
  | { readonly status: 'unavailable' };
export interface TeamLifecycleCommandFingerprintPort {
  fingerprintCommand(
    request: FingerprintTeamLifecycleCommandRequest
  ): Promise<FingerprintTeamLifecycleCommandResult>;
}
export interface TeamLifecycleDurableClaim {
  readonly commandId: string;
  readonly scope: CommandClaimScope<TeamLifecycleCommandKind>;
  readonly descriptor: DurableCommandDescriptorIdentity<TeamLifecycleCommandKind>;
  readonly fingerprint: CommandFingerprintRecord;
  readonly targetRunRef: LifecycleRunRef;
}
export interface TeamLifecycleOutboxEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly scopeKind: 'team';
  readonly scopeId: TeamId;
  readonly schemaVersion: 1;
  readonly semanticRevision: number;
  readonly payloadJson: string;
  readonly createdAtIso: string;
}
export interface TeamLifecycleCommandSnapshot {
  readonly lifecycle: TeamLifecycle;
  readonly currentRun: LifecycleRun | null;
  readonly laneEffects: readonly LifecycleLaneEffectRecord[];
}
export type LifecycleLaneEffectKind = 'launch' | 'drain' | 'recover';
export type LifecycleLaneEffectState =
  | 'not_started'
  | 'attempting'
  | 'observed_succeeded'
  | 'observed_absent'
  | 'ambiguous';
export interface LifecycleLaneEffectLease {
  readonly token: string;
  readonly fence: number;
  readonly ownerId: string;
  readonly claimedAtIso: string;
  readonly expiresAtIso: string;
}
interface LifecycleLaneEffectEvidenceBase {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly leaseFence: number;
  readonly observedAtIso: string;
}
export type LifecycleLaneEffectEvidence =
  | (LifecycleLaneEffectEvidenceBase & {
      readonly kind: 'launch_receipt';
      readonly disposition: 'launched' | 'already_launched' | 'recovered';
      readonly executionRef: string;
    })
  | (LifecycleLaneEffectEvidenceBase & {
      readonly kind: 'drain_receipt';
      readonly disposition: 'stopped' | 'already_stopped' | 'cancelled' | 'absence_verified';
    })
  | (LifecycleLaneEffectEvidenceBase & {
      readonly kind: 'recovery_receipt';
      readonly disposition: 'not_started' | 'recovered';
      readonly executionRef: string | null;
    })
  | (LifecycleLaneEffectEvidenceBase & {
      readonly kind: 'absence_evidence';
      readonly effectKind: 'launch' | 'drain';
      readonly proof: 'effect_not_invoked' | 'runtime_absence_observed';
    })
  | (LifecycleLaneEffectEvidenceBase & {
      readonly kind: 'causal_absence_evidence';
      readonly effectKind: 'drain' | 'recover';
      readonly proof: 'recovery_not_started';
      readonly provingOperationId: string;
      readonly provingLeaseFence: number;
    })
  | (LifecycleLaneEffectEvidenceBase & {
      readonly kind: 'ambiguous_evidence';
      readonly diagnostic: string;
    });
export type LifecycleLaneEffectEvidenceOf<TKind extends LifecycleLaneEffectEvidence['kind']> =
  Extract<LifecycleLaneEffectEvidence, { readonly kind: TKind }>;
type LifecycleLaneSettlement<
  TState extends LifecycleLaneEffectState,
  TEvidence extends LifecycleLaneEffectEvidence['kind'],
> = Readonly<{ state: TState; evidence: LifecycleLaneEffectEvidenceOf<TEvidence> }>;
interface LifecycleLaneEffectSettlementMatrix {
  launch:
    | LifecycleLaneSettlement<'observed_succeeded', 'launch_receipt'>
    | LifecycleLaneSettlement<'observed_absent', 'absence_evidence'>
    | LifecycleLaneSettlement<'ambiguous', 'ambiguous_evidence'>;
  drain:
    | LifecycleLaneSettlement<'observed_succeeded', 'drain_receipt'>
    | LifecycleLaneSettlement<'observed_absent', 'absence_evidence'>
    | LifecycleLaneSettlement<'observed_absent', 'causal_absence_evidence'>
    | LifecycleLaneSettlement<'ambiguous', 'ambiguous_evidence'>;
  recover:
    | LifecycleLaneSettlement<'observed_succeeded', 'recovery_receipt'>
    | LifecycleLaneSettlement<'observed_absent', 'causal_absence_evidence'>
    | LifecycleLaneSettlement<'ambiguous', 'ambiguous_evidence'>;
}
export type LifecycleLaneEffectSettlement<
  TKind extends LifecycleLaneEffectKind = LifecycleLaneEffectKind,
> = LifecycleLaneEffectSettlementMatrix[TKind];
type CausalAbsenceSettlement = Extract<
  LifecycleLaneEffectSettlement<'drain'>,
  {
    readonly state: 'observed_absent';
    readonly evidence: { readonly kind: 'causal_absence_evidence' };
  }
>;
export interface LifecycleLaneEffectRecord {
  readonly effectId: string;
  readonly effectVersion: 1;
  readonly evidenceSchemaVersion: 1;
  readonly recoveryClass: 'reconcilable_by_unique_evidence';
  readonly runRef: LifecycleRunRef;
  readonly laneId: LaneId;
  readonly kind: LifecycleLaneEffectKind;
  readonly operationId: string;
  readonly commandFingerprintDigest: string;
  readonly causalPredecessor: Omit<LifecycleLaneEffectIdentity, 'leaseFence'> | null;
  readonly state: LifecycleLaneEffectState;
  readonly attempt: number;
  readonly leaseFence: number;
  readonly lease: LifecycleLaneEffectLease | null;
  readonly providerMutations: Readonly<
    Partial<Record<LifecycleLaneProviderMutation['effectKind'], LifecycleLaneProviderMutation>>
  >;
  readonly evidence: LifecycleLaneEffectEvidence | null;
}
export interface LifecycleLaneProviderMutation {
  readonly effectKind: 'launch' | 'stop' | 'recover';
  readonly operationId: string;
  readonly lease: LifecycleLaneEffectLease;
  readonly backend: RuntimeExecutionBackendKind;
  readonly scope: LifecycleLaneExecutionScope;
  readonly readiness: LifecycleLaneReadinessReceipt | null;
  readonly executionRef: string | null;
  readonly mode: 'graceful' | 'immediate' | null;
}
export type LifecycleLaneProviderMutationProposal = Omit<LifecycleLaneProviderMutation, 'lease'>;
export type TeamLifecycleClaimedOutcome =
  | {
      readonly kind: 'canonical_run';
      readonly run: LifecycleRunStatusView;
    }
  | {
      readonly kind: 'legacy_generation';
      readonly generation: number;
    };
export type LoadTeamLifecycleCommandStateResult =
  | { readonly status: 'found'; readonly snapshot: TeamLifecycleCommandSnapshot }
  | { readonly status: 'missing' }
  | { readonly status: 'unavailable' };
export type LifecycleAtomicCommandResult =
  | {
      readonly status: 'committed';
      readonly snapshot: TeamLifecycleCommandSnapshot;
    }
  | {
      readonly status: 'replayed';
      readonly outcome: TeamLifecycleClaimedOutcome;
    }
  | {
      readonly status: 'concurrency_conflict';
    }
  | { readonly status: 'idempotency_conflict' }
  | { readonly status: 'stale_generation' }
  | { readonly status: 'stale_revision' }
  | { readonly status: 'unavailable' };
export type ResolveTeamLifecycleCommandClaimResult =
  | { readonly status: 'missing' }
  | { readonly status: 'replayed'; readonly outcome: TeamLifecycleClaimedOutcome }
  | { readonly status: 'idempotency_conflict' }
  | { readonly status: 'unavailable' };
export interface AcceptLifecycleLaunchAtomicallyRequest {
  readonly claim: TeamLifecycleDurableClaim;
  readonly expectedLifecycleRevision: number;
  readonly expectedCurrentRunRef: LifecycleRunRef | null;
  readonly nextLifecycle: TeamLifecycle;
  readonly run: LifecycleRun;
  readonly writerBarrierReceipt: LifecycleWriterBarrierReceipt;
  readonly laneEffects: readonly LifecycleLaneEffectRecord[];
  readonly outbox: TeamLifecycleOutboxEvent;
}
export interface BeginLifecycleRunCommandAtomicallyRequest {
  readonly claim: TeamLifecycleDurableClaim;
  readonly expectedLifecycleRevision: number;
  readonly expectedRunRevision: number;
  readonly runRef: LifecycleRunRef;
  readonly nextLifecycle: TeamLifecycle;
  readonly nextRun: LifecycleRun;
  readonly fencedLaneEffects: readonly LifecycleLaneEffectIdentity[];
  readonly appendedLaneEffects: readonly LifecycleLaneEffectRecord[];
  readonly outbox: TeamLifecycleOutboxEvent;
}
export interface LifecycleLaneEffectIdentity {
  readonly runRef: LifecycleRunRef;
  readonly kind: LifecycleLaneEffectKind;
  readonly laneId: LaneId;
  readonly operationId: string;
  readonly leaseFence: number;
}
export interface ClaimLifecycleCommandNoopAtomicallyRequest {
  readonly claim: TeamLifecycleDurableClaim;
  readonly expectedLifecycleRevision: number;
  readonly expectedRunRevision: number;
  readonly runRef: LifecycleRunRef;
}
export interface SaveLifecycleRunProgressRequest {
  readonly expectedLifecycleRevision: number;
  readonly expectedRunRevision: number;
  readonly runRef: LifecycleRunRef;
  readonly nextLifecycle: TeamLifecycle;
  readonly nextRun: LifecycleRun;
  readonly expectedWriterBarrierReceipt: LifecycleWriterBarrierReceipt;
  readonly outbox: TeamLifecycleOutboxEvent;
}
export type SaveLifecycleRunProgressResult =
  | { readonly status: 'committed'; readonly snapshot: TeamLifecycleCommandSnapshot }
  | { readonly status: 'concurrency_conflict' }
  | { readonly status: 'stale_generation' }
  | { readonly status: 'unavailable' };
export interface ClaimLifecycleLaneEffectRequest {
  readonly runRef: LifecycleRunRef;
  readonly laneId: LaneId;
  readonly kind: LifecycleLaneEffectKind;
  readonly operationId: string;
  readonly proposedProviderMutation: LifecycleLaneProviderMutationProposal | null;
  readonly expectedEffectState: 'not_started' | 'attempting' | 'observed_absent' | 'ambiguous';
  readonly expectedLeaseFence: number;
  readonly expectedLifecycleRevision: number;
  readonly expectedRunRevision: number;
  readonly expectedRunIntent: LifecycleRun['activeIntent'];
  readonly expectedLaneStatus: LifecycleRun['lanes'][number]['status'];
  readonly nextLifecycle: TeamLifecycle;
  readonly nextRun: LifecycleRun;
  readonly transitionOutbox: TeamLifecycleOutboxEvent | null;
  readonly ownerId: string;
  readonly proposedLeaseToken: string;
  readonly claimedAtIso: string;
  readonly leaseExpiresAtIso: string;
  readonly expectedWriterBarrierReceipt: LifecycleWriterBarrierReceipt;
}
export type ClaimLifecycleLaneEffectResult =
  | {
      readonly status: 'claimed';
      readonly previousState: 'not_started' | 'attempting' | 'observed_absent' | 'ambiguous';
      readonly effect: LifecycleLaneEffectRecord;
      readonly snapshot: TeamLifecycleCommandSnapshot;
    }
  | {
      readonly status: 'busy' | 'completed';
      readonly effect: LifecycleLaneEffectRecord;
      readonly snapshot: TeamLifecycleCommandSnapshot;
    }
  | { readonly status: 'concurrency_conflict' | 'stale_generation' | 'unavailable' };
export interface SettleCausalLifecycleLaneEffectRequest {
  readonly runRef: LifecycleRunRef;
  readonly laneId: LaneId;
  readonly kind: 'drain' | 'recover';
  readonly operationId: string;
  readonly expectedEffectState: 'not_started' | 'attempting' | 'ambiguous';
  readonly expectedLeaseFence: number;
  readonly settlement: CausalAbsenceSettlement;
}
export interface SettleLifecycleLaneEffectRequest<
  TKind extends LifecycleLaneEffectKind = LifecycleLaneEffectKind,
> {
  readonly runRef: LifecycleRunRef;
  readonly laneId: LaneId;
  readonly kind: TKind;
  readonly operationId: string;
  readonly expectedLease: LifecycleLaneEffectLease;
  readonly settlement: LifecycleLaneEffectSettlement<TKind>;
  readonly causalSettlements: readonly SettleCausalLifecycleLaneEffectRequest[];
  readonly expectedLifecycleRevision: number;
  readonly expectedRunRevision: number;
  readonly nextLifecycle: TeamLifecycle;
  readonly nextRun: LifecycleRun;
  readonly expectedWriterBarrierReceipt: LifecycleWriterBarrierReceipt;
  readonly outbox: TeamLifecycleOutboxEvent;
}
export type SettleLifecycleLaneEffectResult =
  | { readonly status: 'committed'; readonly snapshot: TeamLifecycleCommandSnapshot }
  | {
      readonly status:
        | 'concurrency_conflict'
        | 'evidence_conflict'
        | 'stale_generation'
        | 'stale_lease'
        | 'unavailable';
    };
export interface BeginLegacyRuntimeCommandAtomicallyRequest {
  readonly claim: TeamLifecycleDurableClaim;
  readonly expectedLifecycleRevision: number;
  readonly generation: number;
  readonly nextLifecycle: TeamLifecycle;
  readonly outbox: TeamLifecycleOutboxEvent;
}
export interface SaveLegacyRuntimeProgressRequest {
  readonly expectedLifecycleRevision: number;
  readonly generation: number;
  readonly nextLifecycle: TeamLifecycle;
  readonly outbox: TeamLifecycleOutboxEvent;
}
export type SaveLegacyRuntimeProgressResult =
  | { readonly status: 'committed'; readonly snapshot: TeamLifecycleCommandSnapshot }
  | { readonly status: 'concurrency_conflict' }
  | { readonly status: 'stale_generation' }
  | { readonly status: 'unavailable' };
export interface TeamLifecycleCommandStatePort {
  load(teamId: TeamId): Promise<LoadTeamLifecycleCommandStateResult>;
  resolveClaim(claim: TeamLifecycleDurableClaim): Promise<ResolveTeamLifecycleCommandClaimResult>;
  acceptLaunchAtomically(
    request: AcceptLifecycleLaunchAtomicallyRequest
  ): Promise<LifecycleAtomicCommandResult>;
  beginRunCommandAtomically(
    request: BeginLifecycleRunCommandAtomicallyRequest
  ): Promise<LifecycleAtomicCommandResult>;
  claimNoopAtomically(
    request: ClaimLifecycleCommandNoopAtomicallyRequest
  ): Promise<LifecycleAtomicCommandResult>;
  saveRunProgress(
    request: SaveLifecycleRunProgressRequest
  ): Promise<SaveLifecycleRunProgressResult>;
  claimLaneEffect(
    request: ClaimLifecycleLaneEffectRequest
  ): Promise<ClaimLifecycleLaneEffectResult>;
  settleLaneEffect(
    request: SettleLifecycleLaneEffectRequest
  ): Promise<SettleLifecycleLaneEffectResult>;
  beginLegacyCommandAtomically(
    request: BeginLegacyRuntimeCommandAtomicallyRequest
  ): Promise<LifecycleAtomicCommandResult>;
  saveLegacyProgress(
    request: SaveLegacyRuntimeProgressRequest
  ): Promise<SaveLegacyRuntimeProgressResult>;
}
export interface PrepareExternalWriterQuiescenceRequest {
  readonly teamId: TeamId;
  readonly expectedFileWriterEpoch: number;
  readonly cancellation: LifecycleCancellation;
  readonly deadline: LifecycleOperationDeadline;
}
export type PrepareExternalWriterQuiescenceResult =
  | {
      readonly status: 'quiescent';
      readonly receipt: LifecycleWriterBarrierReceipt;
    }
  | { readonly status: 'busy' | 'cancelled' | 'deadline_exceeded' | 'unavailable' };
export interface TeamLifecycleExternalWriterBarrierPort {
  prepareForLaunch(
    request: PrepareExternalWriterQuiescenceRequest
  ): Promise<PrepareExternalWriterQuiescenceResult>;
}
export interface ProvisioningPreflightPort {
  preflight(request: {
    readonly teamId: TeamId;
    readonly inputRevision: number;
    readonly cancellation: LifecycleCancellation;
    readonly deadline: LifecycleOperationDeadline;
  }): Promise<
    | { readonly status: 'ready'; readonly lanes: readonly ProvisioningPreflightLaneView[] }
    | { readonly status: 'cancelled' | 'deadline_exceeded' | 'unsupported' | 'unavailable' }
  >;
}
export interface LifecycleLaneExecutionScope {
  readonly plan: CompositeRuntimePlan;
  readonly lane: RuntimePlanLaneBinding;
  readonly executionUnit: ProcessExecutionUnit;
  readonly requiredProviderIds: readonly TeamProviderId[];
}
export interface LifecycleLaneReadinessReceipt {
  readonly backend: RuntimeExecutionBackendKind;
  readonly bindingId: RuntimeBackendBindingId;
  readonly laneId: LaneId;
  readonly planHash: CompositeRuntimePlanHash;
  readonly bindingRevision: number;
  readonly providerRevisions: readonly {
    readonly providerId: TeamProviderId;
    readonly capabilityRevision: number;
  }[];
}
export interface LifecycleResolvedLaneBackend {
  readonly backend: RuntimeExecutionBackendKind;
  preflight(request: {
    readonly scope: LifecycleLaneExecutionScope;
    readonly cancellation: LifecycleCancellation;
  }): Promise<
    | { readonly status: 'ready'; readonly readiness: LifecycleLaneReadinessReceipt }
    | { readonly status: 'rejected'; readonly reason: string }
  >;
  launch(request: {
    readonly scope: LifecycleLaneExecutionScope;
    readonly cancellation: LifecycleCancellation;
    readonly readiness: LifecycleLaneReadinessReceipt;
    readonly operationId: string;
    readonly effectLease: LifecycleLaneEffectLease;
  }): Promise<
    | {
        readonly status: 'launched' | 'already_launched';
        readonly executionRef: string;
      }
    | { readonly status: 'operator_required' }
    | { readonly status: 'rejected'; readonly reason: string }
  >;
  observe(request: {
    readonly scope: LifecycleLaneExecutionScope;
    readonly executionRef: string;
  }): Promise<
    | { readonly status: 'starting' | 'ready' | 'degraded' | 'stopping' }
    | { readonly status: 'exited'; readonly outcome: 'success' | 'failure' | 'unknown' }
    | { readonly status: 'operator_required' }
    | { readonly status: 'rejected'; readonly reason: string }
  >;
  stop(request: {
    readonly scope: LifecycleLaneExecutionScope;
    readonly executionRef: string;
    readonly mode: 'graceful' | 'immediate';
    readonly cancellation: LifecycleCancellation;
    readonly operationId: string;
    readonly effectLease: LifecycleLaneEffectLease;
  }): Promise<
    | { readonly status: 'stopped' | 'already_stopped' | 'cancelled' }
    | { readonly status: 'operator_required' }
    | { readonly status: 'rejected'; readonly reason: string }
  >;
  recover(request: {
    readonly scope: LifecycleLaneExecutionScope;
    readonly cancellation: LifecycleCancellation;
    readonly operationId: string;
    readonly effectLease: LifecycleLaneEffectLease;
  }): Promise<
    | { readonly status: 'not_started' | 'cancelled' }
    | { readonly status: 'recovered'; readonly executionRef: string }
    | { readonly status: 'operator_required' }
    | { readonly status: 'rejected'; readonly reason: string }
  >;
}
export type ResolveLifecycleLaneBackendResult =
  | {
      readonly status: 'resolved';
      readonly backend: LifecycleResolvedLaneBackend;
      readonly scope: LifecycleLaneExecutionScope;
    }
  | { readonly status: 'rejected'; readonly reason: string };
export interface LifecycleExecutionBackendRegistryPort {
  resolve(plan: CompositeRuntimePlan, laneId: LaneId): ResolveLifecycleLaneBackendResult;
}
export interface LegacyRuntimeDrainPort {
  status(request: { readonly teamId: TeamId; readonly generation: number }): Promise<
    | {
        readonly status: 'observed';
        readonly state: LegacyRuntimeGenerationState;
        readonly cleanupVerified: boolean;
      }
    | { readonly status: 'unavailable' | 'operator_required' }
  >;
  cancel(request: {
    readonly teamId: TeamId;
    readonly generation: number;
    readonly cancellation: LifecycleCancellation;
  }): Promise<
    | { readonly status: 'cancelled'; readonly cleanupVerified: boolean }
    | { readonly status: 'recovering' | 'operator_required' | 'unavailable' }
  >;
  stop(request: {
    readonly teamId: TeamId;
    readonly generation: number;
    readonly mode: 'graceful' | 'immediate';
    readonly cancellation: LifecycleCancellation;
  }): Promise<
    | { readonly status: 'stopped'; readonly cleanupVerified: boolean }
    | { readonly status: 'recovering' | 'operator_required' | 'unavailable' }
  >;
  recover(request: {
    readonly teamId: TeamId;
    readonly generation: number;
    readonly cancellation: LifecycleCancellation;
  }): Promise<
    | {
        readonly status: 'active' | 'recovering' | 'terminal';
        readonly cleanupVerified: boolean;
      }
    | { readonly status: 'operator_required' | 'unavailable' }
  >;
}
export interface TeamLifecycleCommandDependencies {
  readonly state: TeamLifecycleCommandStatePort;
  readonly fingerprint: TeamLifecycleCommandFingerprintPort;
  readonly externalWriterBarrier: TeamLifecycleExternalWriterBarrierPort;
  readonly deadlines: TeamLifecycleDeadlinePort;
  readonly provisioningPreflight: ProvisioningPreflightPort;
  readonly backendRegistry: LifecycleExecutionBackendRegistryPort;
  readonly legacyRuntime: LegacyRuntimeDrainPort;
  readonly clock: TeamLifecycleClockPort;
  readonly ids: TeamLifecycleIdFactoryPort;
}
export function lifecycleCommandDescriptor<TInput>(
  kind: TeamLifecycleCommandKind
): CommandDescriptor<TInput, TeamLifecycleCommandKind> {
  const found = TEAM_LIFECYCLE_DURABLE_COMMAND_DESCRIPTORS.find(
    (candidate) => candidate.commandKind === kind
  );
  if (!found) throw new TypeError('team-lifecycle-command-descriptor-missing');
  return found as CommandDescriptor<TInput, TeamLifecycleCommandKind>;
}
export function durableDescriptorIdentity<TInput>(
  descriptorValue: CommandDescriptor<TInput, TeamLifecycleCommandKind>
): DurableCommandDescriptorIdentity<TeamLifecycleCommandKind> {
  return Object.freeze({
    descriptorId: descriptorValue.descriptorId,
    descriptorVersion: descriptorValue.descriptorVersion,
    commandKind: descriptorValue.commandKind,
    inputSchemaVersion: descriptorValue.inputSchemaVersion,
    fingerprintVersion: descriptorValue.fingerprintVersion,
    effectPlanVersion: descriptorValue.effectPlanVersion,
  });
}
export function legacyCutoverOf(snapshot: TeamLifecycleCommandSnapshot): LegacyRuntimeCutover {
  return snapshot.lifecycle.cutover;
}
export async function prepareTeamLifecycleDurableClaim<
  TInput extends {
    readonly commandId: string;
    readonly idempotencyKey: string;
  },
>(
  kind: TeamLifecycleCommandKind,
  input: TInput,
  context: TeamLifecycleCommandContext,
  targetRunRef: LifecycleRunRef,
  fingerprintPort: TeamLifecycleCommandFingerprintPort
): Promise<TeamLifecycleDurableClaim | null> {
  if (
    !isBoundedIdentifier(input.commandId, 256) ||
    !isBoundedIdentifier(input.idempotencyKey, 512) ||
    !isBoundedIdentifier(context.stableActorId, 256)
  ) {
    throw new TypeError('team-lifecycle-command-identity-invalid');
  }
  const commandDescriptor = lifecycleCommandDescriptor<TInput>(kind);
  const scope = createCommandClaimScope({
    deploymentId: context.deploymentId,
    stableActorId: context.stableActorId,
    commandKind: kind,
    idempotencyKey: input.idempotencyKey,
  });
  const fingerprint = await fingerprintPort.fingerprintCommand({
    scope,
    prepared: prepareCommandFingerprint(commandDescriptor, input),
  });
  if (fingerprint.status !== 'fingerprinted') return null;
  return Object.freeze({
    commandId: input.commandId,
    scope,
    descriptor: durableDescriptorIdentity(commandDescriptor),
    fingerprint: fingerprint.fingerprint,
    targetRunRef: Object.freeze({
      runId: targetRunRef.runId,
      generation: targetRunRef.generation,
    }),
  });
}
export function createLifecycleOperationDeadline(
  startedAtIso: string,
  timeoutMs = TEAM_LIFECYCLE_PREPARATION_TIMEOUT_MS
): LifecycleOperationDeadline {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > TEAM_LIFECYCLE_PREPARATION_TIMEOUT_MS ||
    !Number.isFinite(Date.parse(startedAtIso)) ||
    new Date(startedAtIso).toISOString() !== startedAtIso
  ) {
    throw new TypeError('team-lifecycle-deadline-invalid');
  }
  return Object.freeze({
    startedAtIso,
    expiresAtIso: new Date(Date.parse(startedAtIso) + timeoutMs).toISOString(),
    timeoutMs,
  });
}
export function createLifecycleLaneEffects(
  run: LifecycleRun,
  kind: LifecycleLaneEffectKind,
  commandFingerprintDigest: string,
  laneIds: readonly LaneId[] = run.lanes.map((lane) => lane.laneId),
  causalEffects: readonly LifecycleLaneEffectRecord[] = Object.freeze([])
): readonly LifecycleLaneEffectRecord[] {
  if (!isBoundedIdentifier(commandFingerprintDigest, 512))
    throw new TypeError('team-lifecycle-effect-fingerprint-invalid');
  const requested = new Set(laneIds);
  if (requested.size !== laneIds.length)
    throw new TypeError('team-lifecycle-effect-lane-ambiguous');
  const effects = run.lanes
    .filter((lane) => requested.has(lane.laneId))
    .map((lane) => {
      const causal =
        causalEffects.findLast(
          (effect) =>
            effect.laneId === lane.laneId &&
            effect.runRef.runId === run.runId &&
            effect.runRef.generation === run.generation
        ) ?? null;
      return Object.freeze({
        effectId: `lifecycle-lane-${kind}`,
        effectVersion: 1 as const,
        evidenceSchemaVersion: 1 as const,
        recoveryClass: 'reconcilable_by_unique_evidence' as const,
        runRef: Object.freeze({ runId: run.runId, generation: run.generation }),
        laneId: lane.laneId,
        kind,
        operationId: `${kind}:${run.runId}:${run.generation}:${lane.ordinal}:${commandFingerprintDigest}`,
        commandFingerprintDigest,
        causalPredecessor: causal
          ? Object.freeze({
              runRef: causal.runRef,
              kind: causal.kind,
              laneId: causal.laneId,
              operationId: causal.operationId,
            })
          : null,
        state: 'not_started' as const,
        attempt: 0,
        leaseFence: causal?.leaseFence ?? 0,
        lease: null,
        providerMutations: Object.freeze({}),
        evidence: null,
      });
    });
  if (effects.length !== requested.size)
    throw new TypeError('team-lifecycle-effect-lane-not-found');
  return Object.freeze(effects);
}
export function claimedOutcomeMatchesRunRef(
  outcome: TeamLifecycleClaimedOutcome,
  runRef: LifecycleRunRef
): boolean {
  return outcome.kind === 'legacy_generation'
    ? outcome.generation === runRef.generation
    : outcome.run.runId === runRef.runId && outcome.run.generation === runRef.generation;
}
function isBoundedIdentifier(value: string, maxLength: number): boolean {
  if (value.length < 1 || value.length > maxLength) return false;
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint <= 31 || codePoint === 127) return false;
  }
  return true;
}
