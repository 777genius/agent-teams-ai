import {
  type AnchorChannelRef,
  isExactProcessOwnerAttestation,
  isExactProcessOwnershipPlanRef,
  isExactProcessOwnershipScope,
  isExactProcessWorkspaceBinding,
  type OwnedProcessRef,
  parseAnchorChannelRef,
  parseOwnedProcessRef,
  parseProcessOwnerAttestation,
  type ProcessControllerInstanceId,
  type ProcessOwnerAttestation,
  type ProcessOwnershipScope,
  ProcessSupervisionCancellationError,
  ProcessSupervisionProtocolError,
  ProcessSupervisionTimeoutError,
} from '../../../../contracts/processSupervision';
import {
  CommitProcessOwnership,
  createProcessSupervisionDeadline,
  CreateSpawnIntent,
  isCancellationRequested,
  type MonotonicClockPort,
  type OwnedProcessControlPort,
  type ProcessIdentityFactoryPort,
  type ProcessOwnershipStoreContext,
  type ProcessOwnershipStorePort,
  RecoverProcessOwnership,
  remainingProcessSupervisionTime,
  StopOwnedProcess,
  type StopOwnedProcessEffectResult,
} from '../../../../core/application/process-supervision';
import {
  computeCanonicalArgvDigest,
  computeCanonicalPolicyDigest,
  type ProcessOwnershipRecord,
  type SpawnIntent,
  spawnNonceDigest,
} from '../../../../core/domain/process-supervision';
import {
  NodeAnchorControlChannel,
  type NodeAnchorControlSink,
  NodeAnchorStatusReader,
  type NodeAnchorStatusSource,
  runBoundedProcessEffect,
} from '../../../infrastructure/process-supervision';

import {
  createAnchorStopControlFrame,
  mapAnchorDrainProof,
  mapAnchorReadyProof,
} from './AnchorProtocolFrames';

import type { ProcessExecutionUnit, Sha256Hash } from '../../../../contracts/runtimePlan';
import type {
  ObserveProcessExecutionUnitRequest,
  ProcessSupervisorPort,
  RecoverProcessExecutionUnitRequest,
  ResolvedProcessLaunchSpec,
  StartProcessExecutionUnitRequest,
  StopProcessExecutionUnitRequest,
  StopProcessExecutionUnitResult,
  SupervisedProcessRef,
} from '../../../../core/application/ports';

export interface AnchorSpawnRequest {
  readonly intent: SpawnIntent;
  readonly executableAuthority: ResolvedProcessLaunchSpec['argvAuthority']['executableRef'];
  readonly argv: readonly string[];
  readonly workdirAuthority: ResolvedProcessLaunchSpec['workdirAuthority'];
  readonly environmentAuthority: ResolvedProcessLaunchSpec['environmentAuthority'];
  readonly resourcePolicy: ResolvedProcessLaunchSpec['resourcePolicy'];
  readonly shell: false;
  readonly inheritParentEnvironment: false;
  readonly closeUndeclaredDescriptors: true;
}

export type AnchorSpawnResult =
  | {
      readonly status: 'spawned';
      readonly channelRef: AnchorChannelRef;
      readonly controlSink: NodeAnchorControlSink;
      readonly statusSource: NodeAnchorStatusSource;
      readonly ownerAttestation: ProcessOwnerAttestation;
      readonly owningProcess: AttestedOwningProcessPort;
    }
  | { readonly status: 'cancelled' | 'timed_out' | 'unavailable' };

export interface AnchorSpawnPort {
  spawn(
    request: AnchorSpawnRequest,
    options: {
      readonly remainingTimeMs: number;
      readonly cancellation: StartProcessExecutionUnitRequest['cancellation'];
    }
  ): Promise<AnchorSpawnResult>;
}

export type OwningProcessInspection =
  | { readonly status: 'live' | 'eof'; readonly ownerAttestation: ProcessOwnerAttestation }
  | { readonly status: 'mismatch' | 'unavailable' };

/** Boot-local native handle; implementations use stable owner identity, never a numeric PID. */
export interface AttestedOwningProcessPort {
  inspect(options: {
    readonly attestation: ProcessOwnerAttestation;
    readonly remainingTimeMs: number;
    readonly cancellation: StartProcessExecutionUnitRequest['cancellation'];
  }): Promise<OwningProcessInspection>;
  waitForEof(options: {
    readonly attestation: ProcessOwnerAttestation;
    readonly remainingTimeMs: number;
    readonly cancellation: StartProcessExecutionUnitRequest['cancellation'];
  }): Promise<
    | { readonly status: 'eof'; readonly ownerAttestation: ProcessOwnerAttestation }
    | { readonly status: 'mismatch' | 'unavailable' }
  >;
}

export interface AnchorProcessSupervisorAdapterOptions {
  readonly store: ProcessOwnershipStorePort;
  readonly identities: ProcessIdentityFactoryPort;
  readonly spawner: AnchorSpawnPort;
  readonly clock: MonotonicClockPort;
  readonly controllerInstanceId: ProcessControllerInstanceId;
  readonly launchTimeoutMs: number;
  readonly stopTimeoutMs: number;
  readonly recoveryTimeoutMs: number;
}

interface LiveAnchorSession {
  readonly intent: SpawnIntent;
  readonly control: NodeAnchorControlChannel;
  readonly status: NodeAnchorStatusReader;
  readonly owningProcess: AttestedOwningProcessPort;
  readonly ownership: ProcessOwnershipRecord;
  readonly gracefulStopMs: number;
}

/**
 * Node owns only orchestration and boot-local pipes. Native pidfd/subreaper mechanics remain behind
 * the separately guarded anchor artifact and cannot be emulated with PID or process-group fallback.
 */
export class AnchorProcessSupervisorAdapter
  implements ProcessSupervisorPort, OwnedProcessControlPort
{
  private readonly createIntent: CreateSpawnIntent;
  private readonly commitOwnership: CommitProcessOwnership;
  private readonly recoverOwnership: RecoverProcessOwnership;
  private readonly stopOwnership: StopOwnedProcess;
  private readonly sessions = new Map<OwnedProcessRef, LiveAnchorSession>();

  constructor(private readonly options: AnchorProcessSupervisorAdapterOptions) {
    this.createIntent = new CreateSpawnIntent(options.store);
    this.commitOwnership = new CommitProcessOwnership(options.store);
    this.recoverOwnership = new RecoverProcessOwnership(options.store, this, options.clock);
    this.stopOwnership = new StopOwnedProcess(options.store, this, options.clock);
  }

  async start(request: StartProcessExecutionUnitRequest) {
    if (isCancellationRequested(request.cancellation)) {
      return { status: 'rejected' as const, reason: 'cancelled' as const };
    }

    // Recompute before IDs, durable intent, spawn marker, or any other effect.
    let actualArgvDigest: Sha256Hash;
    try {
      actualArgvDigest = computeCanonicalArgvDigest(request.launchSpec.argvAuthority.argv);
    } catch {
      return { status: 'rejected' as const, reason: 'not_owned' as const };
    }
    if (actualArgvDigest !== request.launchSpec.argvAuthority.argvHash) {
      return { status: 'rejected' as const, reason: 'not_owned' as const };
    }
    if (!isExactLaunchSpec(request.executionUnit, request.launchSpec)) {
      return { status: 'rejected' as const, reason: 'stale_plan' as const };
    }

    const deadline = createProcessSupervisionDeadline(
      this.options.clock,
      this.options.launchTimeoutMs
    );
    let processRef: OwnedProcessRef;
    let spawnNonce: ReturnType<ProcessIdentityFactoryPort['createSpawnNonce']>;
    try {
      processRef = this.options.identities.createProcessRef();
      spawnNonce = this.options.identities.createSpawnNonce();
    } catch {
      return { status: 'rejected' as const, reason: 'unavailable' as const };
    }
    const scope = scopeFromLaunchSpec(request.launchSpec);
    const context = { deadline, clock: this.options.clock, cancellation: request.cancellation };
    const environmentPolicyDigest = computeCanonicalPolicyDigest(
      request.launchSpec.environmentAuthority.policy
    );
    const relayScopeDigest = computeCanonicalPolicyDigest({
      laneId: request.executionUnit.laneId,
      memberIds: request.executionUnit.memberIds,
    });
    const created = await this.createIntent.execute({
      scope,
      processRef,
      spawnNonce,
      workspaceBinding: request.launchSpec.workdirAuthority.grant,
      binaryBinding: request.launchSpec.argvAuthority.binaryPolicy,
      argv: request.launchSpec.argvAuthority.argv,
      callerArgvDigest: request.launchSpec.argvAuthority.argvHash,
      environmentPolicyDigest,
      relayScopeDigest,
      context,
    });
    if (created.status === 'rejected') return mapStartRejection(created.reason);
    if (created.status === 'already_created') {
      const existing = this.sessions.get(created.state.intent.processRef);
      if (
        created.state.phase === 'owned' &&
        existing &&
        (await this.inspectLiveChannel(created.state.ownership, context)).status === 'live'
      ) {
        return {
          status: 'already_started' as const,
          processRef: existing.intent.processRef as string as SupervisedProcessRef,
        };
      }
      await this.failClosedStart(scope, context, 'preexisting-intent-without-live-channel');
      return { status: 'rejected' as const, reason: 'not_owned' as const };
    }

    const intent = created.state.intent;
    let spawned: AnchorSpawnResult;
    try {
      spawned = await runBoundedProcessEffect(
        'anchor-spawn',
        deadline,
        this.options.clock,
        request.cancellation,
        async (remainingTimeMs) =>
          await this.options.spawner.spawn(
            {
              intent,
              executableAuthority: request.launchSpec.argvAuthority.executableRef,
              argv: Object.freeze([...request.launchSpec.argvAuthority.argv]),
              workdirAuthority: request.launchSpec.workdirAuthority,
              environmentAuthority: request.launchSpec.environmentAuthority,
              resourcePolicy: request.launchSpec.resourcePolicy,
              shell: false,
              inheritParentEnvironment: false,
              closeUndeclaredDescriptors: true,
            },
            { remainingTimeMs, cancellation: request.cancellation }
          )
      );
    } catch (error) {
      await this.failClosedStart(scope, context, classifyEffectFailure(error, 'spawn'));
      return mapCaughtStartFailure(error);
    }
    if (spawned.status !== 'spawned') {
      await this.failClosedStart(scope, context, `spawn-${spawned.status}`);
      return spawned.status === 'cancelled'
        ? { status: 'rejected' as const, reason: 'cancelled' as const }
        : { status: 'rejected' as const, reason: 'unavailable' as const };
    }

    let channelRef: AnchorChannelRef;
    try {
      channelRef = parseAnchorChannelRef(spawned.channelRef);
    } catch {
      await this.closeFailedSession(
        new NodeAnchorControlChannel(String(spawned.channelRef), spawned.controlSink),
        new NodeAnchorStatusReader(spawned.statusSource),
        deadline,
        spawned.ownerAttestation,
        spawned.owningProcess,
        false
      );
      await this.failClosedStart(scope, context, 'spawn-channel-ref-invalid');
      return { status: 'rejected' as const, reason: 'unavailable' as const };
    }
    const control = new NodeAnchorControlChannel(channelRef, spawned.controlSink);
    const status = new NodeAnchorStatusReader(spawned.statusSource);
    let ownerAttestation: ProcessOwnerAttestation;
    try {
      ownerAttestation = parseProcessOwnerAttestation(spawned.ownerAttestation);
      if (
        ownerAttestation.processRef !== intent.processRef ||
        ownerAttestation.channelRef !== channelRef ||
        ownerAttestation.spawnNonceDigest !== spawnNonceDigest(intent.spawnNonce) ||
        !isExactProcessOwnershipScope(ownerAttestation.scope, intent.scope) ||
        !isExactProcessWorkspaceBinding(ownerAttestation.workspaceBinding, intent.workspaceBinding)
      ) {
        throw new ProcessSupervisionProtocolError('owner-attestation-mismatch');
      }
    } catch (error) {
      await this.closeFailedSession(
        control,
        status,
        deadline,
        undefined,
        spawned.owningProcess,
        false
      );
      await this.failClosedStart(scope, context, classifyEffectFailure(error, 'owner-attestation'));
      return { status: 'rejected' as const, reason: 'not_owned' as const };
    }
    try {
      const readyFrame = await status.readReady(deadline, this.options.clock, request.cancellation);
      const proof = mapAnchorReadyProof(
        intent,
        this.options.controllerInstanceId,
        channelRef,
        ownerAttestation,
        readyFrame
      );
      if (!proof) throw new ProcessSupervisionProtocolError('ready-ownership-mismatch');
      const committed = await this.commitOwnership.execute({ scope, proof, context });
      if (committed.status === 'rejected') {
        if (committed.reason === 'timed_out') {
          throw new ProcessSupervisionTimeoutError('ownership-commit');
        }
        if (committed.reason === 'cancelled') {
          throw new ProcessSupervisionCancellationError('ownership-commit');
        }
        throw new ProcessSupervisionProtocolError(`ownership-commit-${committed.reason}`);
      }
      if (isCancellationRequested(request.cancellation)) {
        throw new ProcessSupervisionCancellationError('ownership-commit');
      }
      if (remainingProcessSupervisionTime(deadline, this.options.clock) <= 0) {
        throw new ProcessSupervisionTimeoutError('ownership-commit');
      }
      const session = Object.freeze({
        intent,
        control,
        status,
        owningProcess: spawned.owningProcess,
        ownership: committed.state.ownership,
        gracefulStopMs: request.launchSpec.resourcePolicy.gracefulStopMs,
      });
      this.sessions.set(intent.processRef, session);
      return {
        status: 'started' as const,
        processRef: intent.processRef as string as SupervisedProcessRef,
      };
    } catch (error) {
      await this.closeFailedSession(
        control,
        status,
        deadline,
        ownerAttestation,
        spawned.owningProcess,
        true
      );
      await this.failClosedStart(scope, context, classifyEffectFailure(error, 'handshake'));
      return mapCaughtStartFailure(error);
    }
  }

  async stop(request: StopProcessExecutionUnitRequest): Promise<StopProcessExecutionUnitResult> {
    let processRef: OwnedProcessRef;
    try {
      processRef = parseOwnedProcessRef(request.processRef);
    } catch {
      return { status: 'unclassified_residual' as const };
    }
    const outcome = await this.stopOwnership.execute({
      ...scopeFromPlanRef(request.planRef, request.executionUnitId),
      processRef,
      mode: request.mode,
      timeoutMs: this.options.stopTimeoutMs,
      cancellation: request.cancellation,
    });
    switch (outcome.status) {
      case 'drained':
        return { status: 'drained' };
      case 'already_drained':
        return { status: 'already_drained' };
      case 'cancelled':
        return { status: 'cancelled' };
      case 'unclassified_residual':
        return { status: 'unclassified_residual' };
      case 'already_stopping':
        return { status: 'unclassified_residual' as const };
      case 'rejected':
        return { status: 'unclassified_residual' as const };
    }
  }

  async observe(request: ObserveProcessExecutionUnitRequest) {
    let processRef: OwnedProcessRef;
    try {
      processRef = parseOwnedProcessRef(request.processRef);
    } catch {
      return { status: 'unclassified_residual' as const };
    }
    const cancellation = neverCancelled();
    const context = {
      deadline: createProcessSupervisionDeadline(
        this.options.clock,
        this.options.recoveryTimeoutMs
      ),
      clock: this.options.clock,
      cancellation,
    };
    let loaded;
    try {
      loaded = await runBoundedProcessEffect(
        'ownership-store-load-observe',
        context.deadline,
        context.clock,
        context.cancellation,
        async () => await this.options.store.loadByProcessRef(processRef, context)
      );
    } catch {
      return { status: 'unclassified_residual' as const };
    }
    if (loaded.status !== 'found') return { status: 'unclassified_residual' as const };
    const expectedScope = scopeFromPlanRef(request.planRef, request.executionUnitId);
    if (
      loaded.state.intent.processRef !== processRef ||
      !isExactProcessOwnershipPlanRef(loaded.state.intent.scope.planRef, expectedScope.planRef) ||
      loaded.state.intent.scope.executionUnitId !== expectedScope.executionUnitId
    ) {
      return { status: 'unclassified_residual' as const };
    }
    switch (loaded.state.phase) {
      case 'spawn_intent':
        return { status: 'starting' as const };
      case 'owned':
        return (await this.inspectLiveChannel(loaded.state.ownership, context)).status === 'live'
          ? { status: 'ready' as const }
          : { status: 'unclassified_residual' as const };
      case 'stopping':
        return (await this.inspectLiveChannel(loaded.state.ownership, context)).status === 'live'
          ? { status: 'stopping' as const }
          : { status: 'unclassified_residual' as const };
      case 'drained':
        return { status: 'exited' as const, outcome: 'unknown' as const };
      case 'unclassified_residual':
        return { status: 'unclassified_residual' as const };
    }
  }

  async recover(request: RecoverProcessExecutionUnitRequest) {
    if (request.executionUnit.executionUnitId === undefined) {
      return { status: 'operator_required' as const };
    }
    const outcome = await this.recoverOwnership.execute({
      ...scopeFromPlanRef(request.planRef, request.executionUnit.executionUnitId),
      timeoutMs: this.options.recoveryTimeoutMs,
      cancellation: request.cancellation,
    });
    switch (outcome.status) {
      case 'not_started':
      case 'cancelled':
      case 'operator_required':
        return outcome;
      case 'recovered':
        return {
          status: 'recovered' as const,
          processRef: outcome.processRef as string as SupervisedProcessRef,
        };
      case 'rejected':
        return { status: 'operator_required' as const };
    }
  }

  async inspectLiveChannel(
    ownership: ProcessOwnershipRecord,
    context: ProcessOwnershipStoreContext
  ) {
    if (ownership.controllerInstanceId !== this.options.controllerInstanceId) {
      return { status: 'mismatch' as const };
    }
    const session = this.sessions.get(ownership.processRef);
    if (!session) return { status: 'lost' as const };
    if (
      !isExactProcessOwnerAttestation(
        session.ownership.ownerAttestation,
        ownership.ownerAttestation
      ) ||
      session.ownership.mainProcessIdentityRef !== ownership.mainProcessIdentityRef ||
      session.ownership.spawnNonceDigest !== ownership.spawnNonceDigest
    ) {
      return { status: 'mismatch' as const };
    }
    try {
      const statusInspection = await session.status.inspect(
        context.deadline,
        context.clock,
        context.cancellation
      );
      if (statusInspection.status !== 'live') {
        return {
          status: statusInspection.status === 'eof' ? ('eof' as const) : ('unavailable' as const),
        };
      }
      const inspection = await runBoundedProcessEffect(
        'owning-process-inspection',
        context.deadline,
        context.clock,
        context.cancellation,
        async (remainingTimeMs) =>
          await session.owningProcess.inspect({
            attestation: ownership.ownerAttestation,
            remainingTimeMs,
            cancellation: context.cancellation,
          })
      );
      if (inspection.status === 'live' || inspection.status === 'eof') {
        let inspectedAttestation: ProcessOwnerAttestation;
        try {
          inspectedAttestation = parseProcessOwnerAttestation(inspection.ownerAttestation);
        } catch {
          return { status: 'mismatch' as const };
        }
        if (!isExactProcessOwnerAttestation(inspectedAttestation, ownership.ownerAttestation)) {
          return { status: 'mismatch' as const };
        }
      }
      if (inspection.status === 'live') return { status: 'live' as const };
      if (inspection.status === 'eof') return { status: 'eof' as const };
      return { status: inspection.status };
    } catch {
      return { status: 'unavailable' as const };
    }
  }

  async stopAndDrain(
    request: Parameters<OwnedProcessControlPort['stopAndDrain']>[0]
  ): Promise<StopOwnedProcessEffectResult> {
    const session = this.sessions.get(request.ownership.processRef);
    if (
      !session ||
      request.ownership.controllerInstanceId !== this.options.controllerInstanceId ||
      !isExactProcessOwnerAttestation(
        session.ownership.ownerAttestation,
        request.ownership.ownerAttestation
      ) ||
      session.ownership.mainProcessIdentityRef !== request.ownership.mainProcessIdentityRef
    ) {
      return { status: 'unavailable' };
    }
    try {
      const frame = createAnchorStopControlFrame(
        request.ownership,
        request.mode,
        request.mode === 'graceful' ? session.gracefulStopMs : 0
      );
      await session.control.writeStop(
        frame,
        request.deadline,
        this.options.clock,
        request.cancellation
      );
      const terminal = await session.status.readDrain(
        request.deadline,
        this.options.clock,
        request.cancellation
      );
      const ownerExit = await runBoundedProcessEffect(
        'owning-process-eof',
        request.deadline,
        this.options.clock,
        request.cancellation,
        async (remainingTimeMs) =>
          await session.owningProcess.waitForEof({
            attestation: request.ownership.ownerAttestation,
            remainingTimeMs,
            cancellation: request.cancellation,
          })
      );
      if (ownerExit.status !== 'eof') {
        throw new ProcessSupervisionProtocolError(`owning-process-${ownerExit.status}`);
      }
      const proof = mapAnchorDrainProof(request.ownership, terminal, {
        processRef: request.ownership.processRef,
        ownerAttestation: ownerExit.ownerAttestation,
        observed: true,
      });
      if (!proof) throw new ProcessSupervisionProtocolError('drain-ownership-mismatch');
      await session.control.close(request.deadline, this.options.clock, request.cancellation);
      this.sessions.delete(request.ownership.processRef);
      return { status: terminal.type === 'drained' ? 'drained' : 'unclassified', proof };
    } catch (error) {
      await this.closeStopFailureSession(session, request.deadline);
      if (error instanceof ProcessSupervisionCancellationError) return { status: 'cancelled' };
      if (error instanceof ProcessSupervisionTimeoutError) return { status: 'timed_out' };
      return { status: 'unavailable' };
    }
  }

  private async closeStopFailureSession(
    session: LiveAnchorSession,
    deadline: ReturnType<typeof createProcessSupervisionDeadline>
  ): Promise<void> {
    const cancellation = neverCancelled();
    try {
      await session.control.close(deadline, this.options.clock, cancellation);
    } catch {
      // Continue classification attempts inside the same absolute deadline.
    }
    try {
      await session.status.readDrain(deadline, this.options.clock, cancellation);
    } catch {
      // Missing typed drain remains unclassified. Numeric process fallback is forbidden.
    }
    await this.waitForCleanupOwnerEof(
      session.owningProcess,
      session.ownership.ownerAttestation,
      deadline,
      cancellation
    );
  }

  private async closeFailedSession(
    control: NodeAnchorControlChannel,
    status: NodeAnchorStatusReader,
    deadline: ReturnType<typeof createProcessSupervisionDeadline>,
    ownerAttestation: ProcessOwnerAttestation | undefined,
    owningProcess: AttestedOwningProcessPort,
    readyConsumed: boolean
  ): Promise<void> {
    const cancellation = neverCancelled();
    try {
      await control.close(deadline, this.options.clock, cancellation);
    } catch {
      // Continue classification attempts inside the same absolute deadline.
    }
    try {
      if (!readyConsumed) {
        await status.readReady(deadline, this.options.clock, cancellation);
      }
      await status.readDrain(deadline, this.options.clock, cancellation);
    } catch {
      // Durable state is marked unclassified by the caller. No PID/PGID fallback is allowed.
    }
    if (ownerAttestation) {
      await this.waitForCleanupOwnerEof(owningProcess, ownerAttestation, deadline, cancellation);
    }
  }

  private async waitForCleanupOwnerEof(
    owningProcess: AttestedOwningProcessPort,
    ownerAttestation: ProcessOwnerAttestation,
    deadline: ReturnType<typeof createProcessSupervisionDeadline>,
    cancellation: StartProcessExecutionUnitRequest['cancellation']
  ): Promise<void> {
    try {
      await runBoundedProcessEffect(
        'owning-process-cleanup-eof',
        deadline,
        this.options.clock,
        cancellation,
        async (remainingTimeMs) =>
          await owningProcess.waitForEof({
            attestation: ownerAttestation,
            remainingTimeMs,
            cancellation,
          })
      );
    } catch {
      // Caller persists unclassified; this helper never upgrades missing owner EOF to cleanup proof.
    }
  }

  private async failClosedStart(
    scope: ProcessOwnershipScope,
    operationContext: ProcessOwnershipStoreContext,
    reason: string
  ): Promise<void> {
    try {
      await this.recoverOwnership.failClosed(
        scope,
        reason,
        {
          ...operationContext,
          cancellation: neverCancelled(),
        },
        reason.endsWith('timed-out') || reason.endsWith('timed_out')
      );
    } catch {
      // The original typed failure is returned; store-unavailable is never treated as cleanup proof.
    }
  }
}

function isExactLaunchSpec(
  executionUnit: ProcessExecutionUnit,
  launchSpec: ResolvedProcessLaunchSpec
): boolean {
  try {
    return (
      executionUnit.executionUnitId === launchSpec.executionUnitId &&
      executionUnit.backendBinding.backend === launchSpec.backend &&
      computeCanonicalPolicyDigest(executionUnit.binaryPolicy) ===
        computeCanonicalPolicyDigest(launchSpec.argvAuthority.binaryPolicy) &&
      computeCanonicalPolicyDigest(executionUnit.environmentPolicy) ===
        computeCanonicalPolicyDigest(launchSpec.environmentAuthority.policy) &&
      computeCanonicalPolicyDigest(executionUnit.resourcePolicy) ===
        computeCanonicalPolicyDigest(launchSpec.resourcePolicy) &&
      launchSpec.workdirAuthority.grant.permission === 'execute_process'
    );
  } catch {
    return false;
  }
}

function scopeFromLaunchSpec(launchSpec: ResolvedProcessLaunchSpec): ProcessOwnershipScope {
  return scopeFromPlanRef(launchSpec.planRef, launchSpec.executionUnitId);
}

function scopeFromPlanRef(
  planRef: ResolvedProcessLaunchSpec['planRef'],
  executionUnitId: ResolvedProcessLaunchSpec['executionUnitId']
): ProcessOwnershipScope {
  return Object.freeze({
    planRef: Object.freeze({
      teamId: planRef.teamId,
      runId: planRef.runId,
      generation: planRef.generation,
      planHash: planRef.planHash,
    }),
    executionUnitId,
  });
}

function mapStartRejection(reason: string) {
  switch (reason) {
    case 'cancelled':
      return { status: 'rejected' as const, reason: 'cancelled' as const };
    case 'ownership_conflict':
    case 'argv_digest_mismatch':
    case 'invalid_request':
      return { status: 'rejected' as const, reason: 'not_owned' as const };
    default:
      return { status: 'rejected' as const, reason: 'unavailable' as const };
  }
}

function mapCaughtStartFailure(error: unknown) {
  return error instanceof ProcessSupervisionCancellationError
    ? { status: 'rejected' as const, reason: 'cancelled' as const }
    : { status: 'rejected' as const, reason: 'unavailable' as const };
}

function classifyEffectFailure(error: unknown, fallback: string): string {
  if (error instanceof ProcessSupervisionCancellationError) return `${fallback}-cancelled`;
  if (error instanceof ProcessSupervisionTimeoutError) return `${fallback}-timed-out`;
  if (error instanceof ProcessSupervisionProtocolError) return `${fallback}-protocol-error`;
  return `${fallback}-unavailable`;
}

function neverCancelled() {
  return {
    cancellationId: 'process-observe-never-cancelled' as never,
    isCancellationRequested: () => false,
  };
}
