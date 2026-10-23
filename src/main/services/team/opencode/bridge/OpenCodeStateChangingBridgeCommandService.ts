import { randomUUID } from 'crypto';

import {
  assertLaunchBehaviorFingerprint,
  assertLaunchResultBehaviorFingerprint,
  attachBridgePreconditions,
  commandRequiresRuntimeStoreManifestPrecondition,
  isActiveOpenCodeBridgeCommandLeaseError,
  isLaunchFingerprintEchoMismatch,
  isOpenCodeBridgeEmptyOutputFailure,
  isOpenCodeBridgeUnknownOutcomeFailure,
  isOpenCodeLaunchCapabilitySnapshotRecoveryAttempt,
  isRecord,
  reconciliationRequiredLaunchResult,
  requiresOpenCodeDeliveryAcceptanceContract,
  requiresOpenCodeVideoFilePartsContract,
  resolveOpenCodeBridgeLeaseAcquireTimeoutMs,
  sleep,
  stringifyError,
} from './OpenCodeStateChangingBridgePreconditions';

export { attachBridgePreconditions, resolveOpenCodeBridgeLeaseAcquireTimeoutMs };

import {
  assertBridgeEvidenceCanCommitToRuntimeStores,
  createOpenCodeBridgeIdempotencyKey,
  extractRunId,
  OPEN_CODE_BRIDGE_TRANSPORT_WATCHDOG_GRACE_MS,
  type OpenCodeBridgeCommandName,
  type OpenCodeBridgeDiagnosticEvent,
  type OpenCodeBridgeHandshake,
  type OpenCodeBridgePeerIdentity,
  type OpenCodeBridgeResult,
  type RuntimeStoreManifestEvidence,
  stableHash,
  validateOpenCodeBridgeHandshake,
} from './OpenCodeBridgeCommandContract';
import { OpenCodeBridgeCommandLeaseError } from './OpenCodeBridgeCommandLedgerStore';
import { bindLifecycleManifest } from './OpenCodeLifecycleManifestBinding';
import { validateRuntimeStopData } from './OpenCodeRuntimeStopProtocol';
import {
  createStopTarget,
  recoverRuntimeStop,
  runtimeStopRequest,
} from './OpenCodeRuntimeStopRecovery';
import { assertStopDomainResult } from './OpenCodeStopOutcomeRecovery';

import type {
  OpenCodeBridgeCommandLease,
  OpenCodeBridgeCommandLeaseStore,
  OpenCodeBridgeCommandLedger,
} from './OpenCodeBridgeCommandLedgerStore';
import type { OpenCodeStopCausalFailure } from '@shared/types';
const DEFAULT_COMMAND_LEASE_ACQUIRE_RETRY_DELAY_MS = 100;

export interface OpenCodeBridgeCommandExecutor {
  execute<TBody, TData>(
    command: OpenCodeBridgeCommandName,
    body: TBody,
    options: {
      cwd: string;
      timeoutMs: number;
      requestId?: string;
      stdoutLimitBytes?: number;
      stderrLimitBytes?: number;
    }
  ): Promise<OpenCodeBridgeResult<TData>>;
}

export interface OpenCodeBridgeHandshakePort {
  handshake(input: {
    requiredCommand: OpenCodeBridgeCommandName;
    expectedRunId: string | null;
    expectedCapabilitySnapshotId: string | null;
    expectedManifestHighWatermark: number | null;
    timeoutMs?: number;
    cwd?: string;
    allowEmptyLaneStop?: boolean;
    selectedModel?: string | null;
    toolApprovalMode?: 'auto' | 'manual';
    teamId?: string;
    teamName?: string;
    memberName?: string;
    laneId?: string | null;
  }): Promise<OpenCodeBridgeHandshake>;
}

export interface OpenCodeLaunchAuthorityWriter {
  publish(input: {
    teamName: string;
    laneId: string | null;
    runId: string;
    capabilitySnapshotId: string;
    behaviorFingerprint: string;
  }): Promise<void>;
}

export interface RuntimeStoreManifestReader {
  read(
    teamName: string,
    laneId?: string | null,
    includeSessionIdentity?: boolean
  ): Promise<RuntimeStoreManifestEvidence>;
}

export interface OpenCodeStateChangingBridgeDiagnosticsSink {
  append(event: OpenCodeBridgeDiagnosticEvent): Promise<void>;
}

export interface OpenCodeStateChangingBridgeCommandServiceOptions {
  expectedClientIdentity: OpenCodeBridgePeerIdentity;
  handshakePort: OpenCodeBridgeHandshakePort;
  leaseStore: OpenCodeBridgeCommandLeaseStore;
  ledger: OpenCodeBridgeCommandLedger;
  bridge: OpenCodeBridgeCommandExecutor;
  manifestReader: RuntimeStoreManifestReader;
  launchAuthorityWriter: OpenCodeLaunchAuthorityWriter;
  diagnostics?: OpenCodeStateChangingBridgeDiagnosticsSink;
  requestIdFactory?: () => string;
  diagnosticIdFactory?: () => string;
  clock?: () => Date;
  leaseAcquireTimeoutMs?: number;
  leaseAcquireRetryDelayMs?: number;
}

const causalSnapshots = new WeakSet<object>();
const causalFailures = new WeakMap<
  object,
  {
    phase: string;
    cleanupErrno?: string | null;
    handshakeFailure?: OpenCodeStopCausalFailure['handshakeFailure'];
  }
>();
export function rememberOpenCodeHandshakeFailure(
  error: Error,
  failure: NonNullable<OpenCodeStopCausalFailure['handshakeFailure']>
): void {
  const lockCode = (['ELOCKED', 'ECOMPROMISED'] as const).find(
    (value) => value === failure.lockCode
  );
  const lockCategory = (['registry', 'profile', 'startup', 'unknown'] as const).find(
    (value) => value === failure.lockCategory
  );
  const messageShape = (['code', 'lock_operation', 'unclassified'] as const).find(
    (value) => value === failure.messageShape
  );
  causalFailures.set(error, {
    ...(causalFailures.get(error) ?? { phase: 'handshake' }),
    handshakeFailure: Object.freeze({
      kind: failure.kind,
      ...(failure.sdkCode ? { sdkCode: failure.sdkCode } : {}),
      ...(failure.nativeOperation ? { nativeOperation: failure.nativeOperation } : {}),
      ...(Number.isInteger(failure.nativeErrno) &&
      (failure.nativeErrno ?? -1) >= 0 &&
      (failure.nativeErrno ?? -1) <= 0xffffffff
        ? { nativeErrno: failure.nativeErrno }
        : {}),
      ...(lockCode ? { lockCode } : {}),
      ...(lockCategory ? { lockCategory } : {}),
      ...(messageShape ? { messageShape } : {}),
    }),
  });
}
/** Identity-only delivery observation: never inspect an unowned thrown value. */
export function ownedOpenCodeHandshakeFailure(error: unknown) {
  const facts = error && typeof error === 'object' ? causalFailures.get(error) : undefined;
  if (!facts?.handshakeFailure) return undefined;
  const snapshot = Object.freeze({ ...facts, reason: null, errno: null, sourceFrame: null });
  causalSnapshots.add(snapshot);
  return snapshot;
}
function rememberFailure(error: unknown, phase: string): void {
  if (error && typeof error === 'object' && !causalFailures.has(error))
    causalFailures.set(error, { phase });
}
/** Closed causal facts only; the original exception remains the thrown object. */
export function projectOpenCodeStateChangingFailure(error: unknown) {
  const object = error && typeof error === 'object' ? error : {};
  const code = 'code' in object ? object.code : null;
  const errno =
    [
      'EACCES',
      'EPERM',
      'ENOENT',
      'ENOSPC',
      'EIO',
      'EROFS',
      'EEXIST',
      'ENOTDIR',
      'EISDIR',
      'EMFILE',
      'ENFILE',
      'EBUSY',
      'EINVAL',
      'ETIMEDOUT',
      'ECONNRESET',
      'ECONNREFUSED',
      'EPIPE',
      'ABORT_ERR',
      'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    ].find((value) => value === code) ?? null;
  const message = error instanceof Error ? error.message : '';
  const reason =
    [
      'OpenCode lifecycle command requires the exact persisted lane run and capability snapshot',
      'OpenCode lifecycle command requires a persisted lane capability snapshot',
      'OpenCode lifecycle capability snapshot does not match the persisted lane manifest',
      'Bridge handshake client identity mismatch',
      'Bridge server capability snapshot mismatch',
      'Bridge server active run mismatch',
      'Bridge server runtime manifest high watermark is stale',
      'Bridge handshake identity hash mismatch',
      'OpenCode lifecycle command body does not match its persisted lane identity',
      'Invalid OpenCode Stop domain result; exact-target reconciliation required',
      'Invalid durable Stop result; reconciliation required',
      'Stop binding mismatch; reconciliation required',
      'Stop receipt target/runtime mismatch; reconciliation required',
      'Invalid original Stop identity; reconciliation unknown',
      'Stop reconciliation unknown: original session set missing',
      'Ambiguous original Stop session set',
      'Invalid original Stop capability/behavior identity',
      'Bridge handshake protocol version mismatch',
      'Unsupported Stop recovery capability/version; reconciliation unknown',
      'Stop target changed before dispatch; reconciliation required',
      'OpenCode bridge command outcome must be reconciled before retry',
      'OpenCode bridge command already started',
      'OpenCode bridge command completed concurrently; retry recovery',
      'OpenCode bridge command already completed; recover through commandStatus',
      'Invalid Stop recovery object; reconciliation required',
      'Unsupported Stop recovery contract version',
      'Stop observation session-set token mismatch',
      'Stop recovery requires a validated success envelope',
      'OpenCode Stop requires authoritative exact-target reconciliation; no durable outcome',
      'OpenCode Stop recovery target or outcome mismatch; reconciliation required',
      'Stop receipt envelope identity mismatch; reconciliation required',
      'OpenCode bridge idempotency key reused with different payload',
      'OpenCode bridge command lease was not created',
    ].find((value) => value === message) ?? null;
  const frame =
    error instanceof Error
      ? /(?:^|[/\\])((?:OpenCodeStateChangingBridgeCommandService|OpenCodeBridgeCommandClient|OpenCodeBridgeHandshakeClient|OpenCodeBridgeCommandLedgerStore|OpenCodeLifecycleManifestBinding|OpenCodeRuntimeStopProtocol|OpenCodeStopOutcomeRecovery)\.ts):(\d{1,7}):(\d{1,5})(?:\)|$)/m.exec(
          error.stack ?? ''
        )
      : null;
  const snapshot = {
    ...(causalFailures.get(object) ?? { phase: 'unclassified' }),
    reason,
    errno,
    sourceFrame: frame
      ? Object.freeze({ source: frame[1], line: Number(frame[2]), column: Number(frame[3]) })
      : null,
  };
  Object.freeze(snapshot);
  causalSnapshots.add(snapshot);
  return snapshot;
}
export function ownedOpenCodeStateChangingFailure(value: unknown) {
  return value && typeof value === 'object' && causalSnapshots.has(value)
    ? (value as ReturnType<typeof projectOpenCodeStateChangingFailure>)
    : undefined;
}

export function formatOpenCodeStopCausalSuffix(value: unknown): string {
  const snapshot = ownedOpenCodeStateChangingFailure(value);
  if (!snapshot) return '';
  const json = JSON.stringify(snapshot);
  return json.length <= 2048 ? '\nOPENCODE_STOP_CAUSE_V1=' + json : '';
}

interface StateChangingInput<TBody> {
  command: OpenCodeBridgeCommandName;
  teamName: string;
  laneId?: string | null;
  runId: string | null;
  capabilitySnapshotId: string | null;
  behaviorFingerprint: string | null;
  body: TBody;
  cwd: string;
  timeoutMs: number;
}

export class OpenCodeStateChangingBridgeCommandService {
  private readonly expectedClientIdentity: OpenCodeBridgePeerIdentity;
  private readonly handshakePort: OpenCodeBridgeHandshakePort;
  private readonly leaseStore: OpenCodeBridgeCommandLeaseStore;
  private readonly ledger: OpenCodeBridgeCommandLedger;
  private readonly bridge: OpenCodeBridgeCommandExecutor;
  private readonly launchAuthorityWriter: OpenCodeLaunchAuthorityWriter;
  private readonly manifestReader: RuntimeStoreManifestReader;
  private readonly diagnostics: OpenCodeStateChangingBridgeDiagnosticsSink | null;
  private readonly requestIdFactory: () => string;
  private readonly diagnosticIdFactory: () => string;
  private readonly clock: () => Date;
  private readonly leaseAcquireTimeoutMs: number | null;
  private readonly leaseAcquireRetryDelayMs: number;

  constructor(options: OpenCodeStateChangingBridgeCommandServiceOptions) {
    this.expectedClientIdentity = options.expectedClientIdentity;
    this.handshakePort = options.handshakePort;
    this.leaseStore = options.leaseStore;
    this.ledger = options.ledger;
    this.bridge = options.bridge;
    this.manifestReader = options.manifestReader;
    this.launchAuthorityWriter = options.launchAuthorityWriter;
    this.diagnostics = options.diagnostics ?? null;
    this.requestIdFactory = options.requestIdFactory ?? (() => `opencode-bridge-${randomUUID()}`);
    this.diagnosticIdFactory =
      options.diagnosticIdFactory ?? (() => `opencode-bridge-diagnostic-${randomUUID()}`);
    this.clock = options.clock ?? (() => new Date());
    this.leaseAcquireTimeoutMs = options.leaseAcquireTimeoutMs ?? null;
    this.leaseAcquireRetryDelayMs =
      options.leaseAcquireRetryDelayMs ?? DEFAULT_COMMAND_LEASE_ACQUIRE_RETRY_DELAY_MS;
  }

  async execute<TBody, TData>(
    input: StateChangingInput<TBody>
  ): Promise<OpenCodeBridgeResult<TData>> {
    const context = { phase: 'manifest' };
    try {
      return await this.executeTracked<TBody, TData>(input, context);
    } catch (error) {
      rememberFailure(error, context.phase);
      throw error;
    }
  }

  private async executeTracked<TBody, TData>(
    input: StateChangingInput<TBody>,
    context: { phase: string }
  ): Promise<OpenCodeBridgeResult<TData>> {
    assertLaunchBehaviorFingerprint(input.command, input.behaviorFingerprint, input.body);
    // Pre-dispatch phases share the command budget so the attempt settles inside the caller's escalation race.
    const preDispatchDeadlineMs = Date.now() + input.timeoutMs;
    const normalizedLaneId = input.laneId ?? null;
    const manifest = await this.manifestReader.read(
      input.teamName,
      normalizedLaneId,
      input.command === 'opencode.stopTeam'
    );
    context.phase = 'binding';
    const { capabilitySnapshotId, body: commandBody } = bindLifecycleManifest(input, manifest);
    // Preserve caller identity in the ledger; committed behavior fences runtime effects.
    const behaviorFingerprint =
      input.behaviorFingerprint ??
      (input.command === 'opencode.reconcileTeam' ||
      input.command === 'opencode.stopTeam' ||
      input.command === 'opencode.sendMessage'
        ? (manifest.behaviorFingerprint ?? null)
        : null);
    const enforceManifestHighWatermark = commandRequiresRuntimeStoreManifestPrecondition(
      input.command
    );
    const expectedManifestHighWatermark = enforceManifestHighWatermark
      ? manifest.highWatermark
      : null;
    const idempotencyKey = createOpenCodeBridgeIdempotencyKey({
      command: input.command,
      teamName: input.teamName,
      laneId: normalizedLaneId,
      runId: input.runId,
      body: commandBody,
    });
    if (input.command === 'opencode.stopTeam') {
      context.phase = 'stop_ledger_lookup';
      const existing = await this.ledger.getByIdempotencyKey(idempotencyKey);
      if (existing) {
        const lease = await this.acquireLease({
          teamName: input.teamName,
          laneId: normalizedLaneId,
          runId: input.runId,
          command: input.command,
          acquireBudgetMs: Math.max(1, preDispatchDeadlineMs - Date.now()),
          ttlMs: input.timeoutMs + OPEN_CODE_BRIDGE_TRANSPORT_WATCHDOG_GRACE_MS + 5_000,
        });
        let primary: unknown;
        try {
          context.phase = 'stop_recovery';
          const current = await this.manifestReader.read(input.teamName, normalizedLaneId, true);
          const bound = bindLifecycleManifest(input, current);
          return await recoverRuntimeStop<TData>({
            entry: existing,
            current: createStopTarget(
              {
                teamName: input.teamName,
                laneId: normalizedLaneId,
                runId: input.runId,
                capabilitySnapshotId: bound.capabilitySnapshotId,
                behaviorFingerprint: input.behaviorFingerprint,
                cwd: input.cwd,
                body: bound.body,
              },
              current
            ),
            manifest: current,
            expectedClient: this.expectedClientIdentity,
            handshakePort: this.handshakePort,
            bridge: this.bridge,
            ledger: this.ledger,
            timeoutMs: input.timeoutMs,
            handshakeTimeoutMs: Math.max(1, preDispatchDeadlineMs - Date.now()),
          });
        } catch (error) {
          primary = error;
          rememberFailure(error, context.phase);
          throw error;
        } finally {
          await this.leaseStore.release(lease.leaseId).catch((cleanup) => {
            if (primary && typeof primary === 'object')
              causalFailures.get(primary)!.cleanupErrno =
                projectOpenCodeStateChangingFailure(cleanup).errno;
            else {
              rememberFailure(cleanup, 'lease_release');
              throw cleanup;
            }
          });
        }
      }
    }
    context.phase = 'handshake';
    const handshake = await this.handshakePort.handshake({
      requiredCommand: input.command,
      expectedRunId: input.runId,
      expectedCapabilitySnapshotId: capabilitySnapshotId,
      expectedManifestHighWatermark,
      timeoutMs: Math.max(1, preDispatchDeadlineMs - Date.now()),
      cwd: input.cwd,
      teamId: input.teamName,
      laneId: normalizedLaneId,
      ...(isRecord(commandBody) && commandBody.allowEmptyLaneStop === true
        ? { allowEmptyLaneStop: true }
        : {}),
      ...(input.command === 'opencode.launchTeam' && isRecord(commandBody)
        ? {
            selectedModel:
              typeof commandBody.selectedModel === 'string' ? commandBody.selectedModel : null,
            toolApprovalMode:
              commandBody.skipPermissions === false ? ('manual' as const) : ('auto' as const),
          }
        : {}),
    });
    context.phase = 'handshake_validation';
    const handshakeValidation = validateOpenCodeBridgeHandshake({
      handshake,
      expectedClient: this.expectedClientIdentity,
      requiredCommand: input.command,
      expectedCapabilitySnapshotId: capabilitySnapshotId,
      expectedManifestHighWatermark,
      expectedRunId: input.runId,
      requiresDeliveryAcceptanceContract: requiresOpenCodeDeliveryAcceptanceContract(
        input.command,
        commandBody
      ),
      requiresVideoFilePartsContract: requiresOpenCodeVideoFilePartsContract(
        input.command,
        commandBody
      ),
    });

    if (!handshakeValidation.ok) {
      throw new Error(handshakeValidation.reason);
    }

    if (
      input.command === 'opencode.stopTeam' &&
      handshake.stopRecoveryContractVersion !== undefined &&
      (handshake.stopRecoveryContractVersion !== 1 ||
        !handshake.acceptedCommands.includes('opencode.stopOutcome') ||
        !handshake.acceptedCommands.includes('opencode.reconcileStop') ||
        !handshake.server.bridgeProtocol.supportedCommands.includes('opencode.stopOutcome') ||
        !handshake.server.bridgeProtocol.supportedCommands.includes('opencode.reconcileStop'))
    )
      throw new Error('Unsupported Stop recovery capability/version; reconciliation unknown');
    context.phase = 'lease_acquire';
    const commandRequestId = this.requestIdFactory();
    const lease = await this.acquireLease({
      teamName: input.teamName,
      laneId: normalizedLaneId,
      runId: input.runId,
      command: input.command,
      acquireBudgetMs: Math.max(1, preDispatchDeadlineMs - Date.now()),
      ttlMs: input.timeoutMs + OPEN_CODE_BRIDGE_TRANSPORT_WATCHDOG_GRACE_MS + 5_000,
    });

    try {
      context.phase = 'stop_target';
      const stopManifest =
        input.command === 'opencode.stopTeam'
          ? await this.manifestReader.read(input.teamName, normalizedLaneId, true)
          : manifest;
      const stopTarget =
        input.command === 'opencode.stopTeam'
          ? createStopTarget(
              {
                teamName: input.teamName,
                laneId: normalizedLaneId,
                runId: input.runId,
                capabilitySnapshotId,
                behaviorFingerprint: input.behaviorFingerprint,
                cwd: input.cwd,
                body: commandBody,
              },
              stopManifest
            )
          : null;
      if (
        stopTarget &&
        (stopManifest.activeRunId !== manifest.activeRunId ||
          stopManifest.capabilitySnapshotId !== manifest.capabilitySnapshotId ||
          stopManifest.sessionIdentityHash !== manifest.sessionIdentityHash)
      )
        throw new Error('Stop target changed before dispatch; reconciliation required');
      // Runtime v1 retains its explicit empty-lane command. It rechecks absence
      // before effects; empty lanes have no versioned session receipt target.
      const stopRequest =
        stopTarget &&
        handshake.stopRecoveryContractVersion === 1 &&
        !(isRecord(commandBody) && commandBody.allowEmptyLaneStop === true)
          ? runtimeStopRequest({ requestId: commandRequestId, idempotencyKey }, stopTarget)
          : null;
      const bodyWithPreconditions = attachBridgePreconditions(
        stopRequest
          ? {
              ...(isRecord(commandBody) && commandBody),
              projectPath: stopRequest.target.projectPath,
              stopRecovery: stopRequest,
            }
          : commandBody,
        {
          handshakeIdentityHash: handshake.identityHash,
          laneId: normalizedLaneId,
          expectedRunId: input.runId,
          expectedCapabilitySnapshotId: capabilitySnapshotId,
          expectedBehaviorFingerprint:
            stopRequest?.target.expectedBehaviorFingerprint ?? behaviorFingerprint,
          expectedManifestHighWatermark,
          commandLeaseId: lease.leaseId,
          idempotencyKey,
        }
      );

      context.phase = 'ledger_begin';
      const begin = await this.ledger.begin({
        idempotencyKey,
        requestId: commandRequestId,
        command: input.command,
        teamName: input.teamName,
        laneId: input.laneId,
        runId: input.runId,
        ...(stopTarget ? { stopTarget } : {}),
        requestHash: stableHash({
          command: input.command,
          teamName: input.teamName,
          laneId: normalizedLaneId,
          runId: input.runId,
          capabilitySnapshotId: capabilitySnapshotId,
          behaviorFingerprint: input.behaviorFingerprint,
          manifestHighWatermark: expectedManifestHighWatermark,
          body: commandBody,
        }),
      });

      if (begin === 'duplicate_same_payload_completed') {
        throw new Error(
          input.command === 'opencode.stopTeam'
            ? 'OpenCode bridge command completed concurrently; retry recovery'
            : 'OpenCode bridge command already completed; recover through commandStatus'
        );
      }

      context.phase = 'dispatch';
      const result = await this.bridge.execute<typeof bodyWithPreconditions, TData>(
        input.command,
        bodyWithPreconditions,
        {
          cwd: stopRequest?.target.projectPath ?? input.cwd,
          timeoutMs: input.timeoutMs,
          requestId: commandRequestId,
        }
      );

      context.phase = 'failure_persistence';
      if (!result.ok) {
        if (isOpenCodeBridgeUnknownOutcomeFailure(result)) {
          await this.ledger.markUnknownAfterTimeout({
            idempotencyKey,
            error: result.error.message,
          });
          await this.appendUnknownOutcomeDiagnostic({
            result,
            teamName: input.teamName,
            laneId: normalizedLaneId,
            runId: input.runId,
            command: input.command,
            idempotencyKey,
            leaseId: lease.leaseId,
          });
        } else {
          await this.ledger.markFailed({
            idempotencyKey,
            error: result.error.message,
            retryable: result.error.retryable,
          });
        }

        await this.leaseStore.release(lease.leaseId);
        return result;
      }

      context.phase = 'result_validation';
      try {
        assertBridgeEvidenceCanCommitToRuntimeStores({
          result,
          requestId: commandRequestId,
          command: input.command,
          runId: input.runId,
          capabilitySnapshotId: capabilitySnapshotId,
          manifest,
          idempotencyKey,
          enforceManifestHighWatermark,
          allowCapabilitySnapshotRecovery: isOpenCodeLaunchCapabilitySnapshotRecoveryAttempt(
            input.command,
            commandBody
          ),
        });
        assertLaunchResultBehaviorFingerprint(
          input.command,
          input.behaviorFingerprint,
          result.data
        );
      } catch (error) {
        if (
          isLaunchFingerprintEchoMismatch(
            input.command,
            input.behaviorFingerprint,
            result.data,
            error
          )
        ) {
          const ambiguousResult = reconciliationRequiredLaunchResult<TData>(result);
          await this.ledger
            .markUnknownAfterTimeout({
              idempotencyKey,
              error: ambiguousResult.error.message,
            })
            .catch(() => undefined); // The existing started ledger entry still fences replay.
          await this.appendUnknownOutcomeDiagnostic({
            result: ambiguousResult,
            teamName: input.teamName,
            laneId: normalizedLaneId,
            runId: input.runId,
            command: input.command,
            idempotencyKey,
            leaseId: lease.leaseId,
          }).catch(() => undefined); // Diagnostic storage cannot make a post-effect outcome terminal.
          await this.leaseStore.release(lease.leaseId).catch(() => undefined);
          return ambiguousResult;
        }
        await this.ledger.markFailed({
          idempotencyKey,
          error: stringifyError(error),
          retryable: false,
        });
        throw error;
      }
      if (input.command === 'opencode.launchTeam') {
        try {
          if (!input.runId || !result.runtime.capabilitySnapshotId || !input.behaviorFingerprint) {
            throw new Error('Validated OpenCode launch authority is incomplete');
          }
          await this.launchAuthorityWriter.publish({
            teamName: input.teamName,
            laneId: normalizedLaneId,
            runId: input.runId,
            capabilitySnapshotId: result.runtime.capabilitySnapshotId,
            behaviorFingerprint: input.behaviorFingerprint,
          });
        } catch (error) {
          const ambiguousResult = reconciliationRequiredLaunchResult<TData>(
            result,
            `OpenCode launch authority publication failed; reconcile before retry: ${stringifyError(error)}`
          );
          await this.ledger
            .markUnknownAfterTimeout({
              idempotencyKey,
              error: ambiguousResult.error.message,
            })
            .catch(() => undefined); // The existing started ledger entry still fences replay.
          await this.appendUnknownOutcomeDiagnostic({
            result: ambiguousResult,
            teamName: input.teamName,
            laneId: normalizedLaneId,
            runId: input.runId,
            command: input.command,
            idempotencyKey,
            leaseId: lease.leaseId,
          }).catch(() => undefined); // Diagnostic storage cannot make a post-effect outcome terminal.
          await this.leaseStore.release(lease.leaseId).catch(() => undefined);
          return ambiguousResult;
        }
      }
      context.phase = 'stop_result_validation';
      if (input.command === 'opencode.stopTeam') assertStopDomainResult(result);
      if (stopRequest) validateRuntimeStopData(result.data, stopRequest);
      context.phase = 'ledger_complete';
      await this.ledger.markCompleted({
        idempotencyKey,
        response: result,
        ...(stopTarget ? { stopRecovery: { target: stopTarget, result } } : {}),
      });
      context.phase = 'lease_release';
      await this.leaseStore.release(lease.leaseId);
      return result;
    } catch (error) {
      rememberFailure(error, context.phase);
      await this.leaseStore.release(lease.leaseId).catch((cleanup) => {
        const original = error && typeof error === 'object' ? causalFailures.get(error) : undefined;
        if (original) original.cleanupErrno = projectOpenCodeStateChangingFailure(cleanup).errno;
      });
      throw error;
    }
  }

  private async acquireLease(input: {
    teamName: string;
    laneId: string | null;
    runId: string | null;
    command: OpenCodeBridgeCommandName;
    ttlMs: number;
    acquireBudgetMs?: number;
  }): Promise<OpenCodeBridgeCommandLease> {
    const acquireTimeoutMs = resolveOpenCodeBridgeLeaseAcquireTimeoutMs({
      configuredTimeoutMs: this.leaseAcquireTimeoutMs,
      leaseTtlMs: input.ttlMs,
    });
    const deadlineMs =
      Date.now() +
      (input.acquireBudgetMs === undefined
        ? acquireTimeoutMs
        : Math.min(acquireTimeoutMs, input.acquireBudgetMs));
    while (true) {
      try {
        return await this.leaseStore.acquire(input);
      } catch (error) {
        if (
          !(error instanceof OpenCodeBridgeCommandLeaseError) ||
          !isActiveOpenCodeBridgeCommandLeaseError(error)
        ) {
          throw error;
        }
        if (Date.now() >= deadlineMs) {
          throw error;
        }
        await sleep(Math.max(1, this.leaseAcquireRetryDelayMs));
      }
    }
  }

  private async appendUnknownOutcomeDiagnostic(input: {
    result: OpenCodeBridgeResult<unknown>;
    teamName: string;
    laneId: string | null;
    runId: string | null;
    command: OpenCodeBridgeCommandName;
    idempotencyKey: string;
    leaseId: string;
  }): Promise<void> {
    const completedAt = this.clock().toISOString();
    await this.diagnostics?.append({
      id: this.diagnosticIdFactory(),
      type: 'opencode_bridge_unknown_outcome',
      providerId: 'opencode',
      teamName: input.teamName,
      ...(input.laneId
        ? {
            data: {
              laneId: input.laneId,
              command: input.command,
              idempotencyKey: input.idempotencyKey,
              leaseId: input.leaseId,
            },
          }
        : {
            data: {
              command: input.command,
              idempotencyKey: input.idempotencyKey,
              leaseId: input.leaseId,
            },
          }),
      runId: input.runId ?? extractRunId(input.result) ?? undefined,
      severity: 'warning',
      message: isOpenCodeBridgeEmptyOutputFailure(input.result)
        ? 'OpenCode bridge command exited without output; outcome must be reconciled before retry'
        : 'OpenCode bridge command outcome must be reconciled before retry',
      createdAt: completedAt,
    });
  }
}
