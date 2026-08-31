import { randomUUID } from 'crypto';

import { isLowercaseSha256 } from '../readiness/OpenCodeExpectedBehaviorFingerprint';

import {
  assertBridgeEvidenceCanCommitToRuntimeStores,
  createOpenCodeBridgeIdempotencyKey,
  extractRunId,
  OPEN_CODE_BRIDGE_TRANSPORT_WATCHDOG_GRACE_MS,
  type OpenCodeBridgeCommandName,
  type OpenCodeBridgeCommandPreconditions,
  type OpenCodeBridgeDiagnosticEvent,
  type OpenCodeBridgeHandshake,
  type OpenCodeBridgePeerIdentity,
  type OpenCodeBridgeResult,
  type RuntimeStoreManifestEvidence,
  stableHash,
  validateOpenCodeBridgeHandshake,
} from './OpenCodeBridgeCommandContract';
import { OpenCodeBridgeCommandLeaseError } from './OpenCodeBridgeCommandLedgerStore';

import type {
  OpenCodeBridgeCommandLease,
  OpenCodeBridgeCommandLeaseStore,
  OpenCodeBridgeCommandLedger,
} from './OpenCodeBridgeCommandLedgerStore';

const DEFAULT_COMMAND_LEASE_ACQUIRE_TIMEOUT_MS = 10_000;
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
    cwd?: string;
    allowEmptyLaneStop?: boolean;
    selectedModel?: string | null;
    toolApprovalMode?: 'auto' | 'manual';
    teamId?: string;
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
  read(teamName: string, laneId?: string | null): Promise<RuntimeStoreManifestEvidence>;
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

  async execute<TBody, TData>(input: {
    command: OpenCodeBridgeCommandName;
    teamName: string;
    laneId?: string | null;
    runId: string | null;
    capabilitySnapshotId: string | null;
    behaviorFingerprint: string | null;
    body: TBody;
    cwd: string;
    timeoutMs: number;
  }): Promise<OpenCodeBridgeResult<TData>> {
    assertLaunchBehaviorFingerprint(input.command, input.behaviorFingerprint, input.body);
    const normalizedLaneId = input.laneId ?? null;
    const manifest = await this.manifestReader.read(input.teamName, normalizedLaneId);
    const { capabilitySnapshotId, body: commandBody } = bindLifecycleManifest(input, manifest);
    const enforceManifestHighWatermark = commandRequiresRuntimeStoreManifestPrecondition(
      input.command
    );
    const expectedManifestHighWatermark = enforceManifestHighWatermark
      ? manifest.highWatermark
      : null;
    const handshake = await this.handshakePort.handshake({
      requiredCommand: input.command,
      expectedRunId: input.runId,
      expectedCapabilitySnapshotId: capabilitySnapshotId,
      expectedManifestHighWatermark,
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

    const idempotencyKey = createOpenCodeBridgeIdempotencyKey({
      command: input.command,
      teamName: input.teamName,
      laneId: normalizedLaneId,
      runId: input.runId,
      body: commandBody,
    });
    const commandRequestId = this.requestIdFactory();
    const lease = await this.acquireLease({
      teamName: input.teamName,
      laneId: normalizedLaneId,
      runId: input.runId,
      command: input.command,
      ttlMs: input.timeoutMs + OPEN_CODE_BRIDGE_TRANSPORT_WATCHDOG_GRACE_MS + 5_000,
    });

    try {
      const bodyWithPreconditions = attachBridgePreconditions(commandBody, {
        handshakeIdentityHash: handshake.identityHash,
        laneId: normalizedLaneId,
        expectedRunId: input.runId,
        expectedCapabilitySnapshotId: capabilitySnapshotId,
        expectedBehaviorFingerprint: input.behaviorFingerprint,
        expectedManifestHighWatermark,
        commandLeaseId: lease.leaseId,
        idempotencyKey,
      });

      const begin = await this.ledger.begin({
        idempotencyKey,
        requestId: commandRequestId,
        command: input.command,
        teamName: input.teamName,
        laneId: input.laneId,
        runId: input.runId,
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
        throw new Error('OpenCode bridge command already completed; recover through commandStatus');
      }

      const result = await this.bridge.execute<typeof bodyWithPreconditions, TData>(
        input.command,
        bodyWithPreconditions,
        {
          cwd: input.cwd,
          timeoutMs: input.timeoutMs,
          requestId: commandRequestId,
        }
      );

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
      await this.ledger.markCompleted({ idempotencyKey, response: result });
      await this.leaseStore.release(lease.leaseId);
      return result;
    } catch (error) {
      await this.leaseStore.release(lease.leaseId).catch(() => undefined);
      throw error;
    }
  }

  private async acquireLease(input: {
    teamName: string;
    laneId: string | null;
    runId: string | null;
    command: OpenCodeBridgeCommandName;
    ttlMs: number;
  }): Promise<OpenCodeBridgeCommandLease> {
    const deadlineMs =
      Date.now() +
      resolveOpenCodeBridgeLeaseAcquireTimeoutMs({
        configuredTimeoutMs: this.leaseAcquireTimeoutMs,
        leaseTtlMs: input.ttlMs,
      });
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

function bindLifecycleManifest<TBody>(
  input: {
    command: OpenCodeBridgeCommandName;
    runId: string | null;
    teamName: string;
    laneId?: string | null;
    capabilitySnapshotId: string | null;
    body: TBody;
  },
  manifest: RuntimeStoreManifestEvidence
): { capabilitySnapshotId: string | null; body: TBody } {
  if (input.command !== 'opencode.stopTeam' && input.command !== 'opencode.reconcileTeam') {
    return { capabilitySnapshotId: input.capabilitySnapshotId, body: input.body };
  }
  const emptyStop =
    input.command === 'opencode.stopTeam' &&
    manifest.activeRunId === null &&
    manifest.capabilitySnapshotId === null &&
    input.capabilitySnapshotId === null;
  if (
    !emptyStop &&
    (!input.runId || manifest.activeRunId !== input.runId || !manifest.capabilitySnapshotId)
  ) {
    throw new Error(
      'OpenCode lifecycle command requires the exact persisted lane run and capability snapshot'
    );
  }
  const capabilitySnapshotId = manifest.capabilitySnapshotId;
  if (capabilitySnapshotId === undefined) {
    throw new Error('OpenCode lifecycle command requires a persisted lane capability snapshot');
  }
  const bodySnapshotId = isRecord(input.body) ? input.body.expectedCapabilitySnapshotId : null;
  if (
    (input.capabilitySnapshotId !== null && input.capabilitySnapshotId !== capabilitySnapshotId) ||
    (bodySnapshotId != null && bodySnapshotId !== capabilitySnapshotId)
  ) {
    throw new Error(
      'OpenCode lifecycle capability snapshot does not match the persisted lane manifest'
    );
  }
  if (
    !isRecord(input.body) ||
    input.body.runId !== input.runId ||
    input.body.teamId !== input.teamName ||
    input.body.laneId !== (input.laneId ?? 'primary') ||
    (input.body.allowEmptyLaneStop === true && !emptyStop)
  ) {
    throw new Error('OpenCode lifecycle command body does not match its persisted lane identity');
  }
  return {
    capabilitySnapshotId,
    body: {
      ...input.body,
      expectedCapabilitySnapshotId: capabilitySnapshotId,
      ...(emptyStop ? { allowEmptyLaneStop: true } : {}),
    },
  };
}

function assertLaunchBehaviorFingerprint(
  command: OpenCodeBridgeCommandName,
  behaviorFingerprint: string | null,
  body: unknown
): void {
  if (command !== 'opencode.launchTeam') {
    return;
  }
  if (!isLowercaseSha256(behaviorFingerprint)) {
    throw new Error('OpenCode launch requires a lowercase SHA-256 behavior fingerprint');
  }
  if (!isRecord(body) || body.expectedBehaviorFingerprint !== behaviorFingerprint) {
    throw new Error('OpenCode launch behavior fingerprint does not match its command body');
  }
}

function assertLaunchResultBehaviorFingerprint(
  command: OpenCodeBridgeCommandName,
  expectedBehaviorFingerprint: string | null,
  data: unknown
): void {
  if (command !== 'opencode.launchTeam') {
    return;
  }
  if (!isRecord(data) || data.expectedBehaviorFingerprint !== expectedBehaviorFingerprint) {
    throw new Error('OpenCode launch result behavior fingerprint mismatch');
  }
}

export function attachBridgePreconditions<TBody>(
  body: TBody,
  preconditions: OpenCodeBridgeCommandPreconditions
): TBody & { preconditions: OpenCodeBridgeCommandPreconditions } {
  if (isRecord(body)) {
    return {
      ...body,
      preconditions,
    } as TBody & { preconditions: OpenCodeBridgeCommandPreconditions };
  }

  return {
    payload: body,
    preconditions,
  } as unknown as TBody & { preconditions: OpenCodeBridgeCommandPreconditions };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOpenCodeLaunchCapabilitySnapshotRecoveryAttempt(
  command: OpenCodeBridgeCommandName,
  body: unknown
): boolean {
  if (command !== 'opencode.launchTeam' || !isRecord(body)) {
    return false;
  }
  const recoveryAttemptId = body.capabilitySnapshotRecoveryAttemptId;
  return typeof recoveryAttemptId === 'string' && recoveryAttemptId.trim().length > 0;
}

function requiresOpenCodeDeliveryAcceptanceContract(
  command: OpenCodeBridgeCommandName,
  body: unknown
): boolean {
  if (command !== 'opencode.sendMessage' || !isRecord(body)) {
    return false;
  }
  return body.settlementMode === 'acceptance';
}

function requiresOpenCodeVideoFilePartsContract(
  command: OpenCodeBridgeCommandName,
  body: unknown
): boolean {
  if (command !== 'opencode.sendMessage' || !isRecord(body) || !Array.isArray(body.fileParts)) {
    return false;
  }
  return body.fileParts.some(
    (part) => isRecord(part) && typeof part.mime === 'string' && part.mime.startsWith('video/')
  );
}

function commandRequiresRuntimeStoreManifestPrecondition(
  command: OpenCodeBridgeCommandName
): boolean {
  // App metadata and runtime stores own independent watermarks. Lifecycle commands
  // are fenced by exact lane/run/capability authority, not cross-domain counters.
  // Message delivery has its own durable acceptance evidence.
  return (
    command !== 'opencode.sendMessage' &&
    command !== 'opencode.stopTeam' &&
    command !== 'opencode.reconcileTeam'
  );
}

export function resolveOpenCodeBridgeLeaseAcquireTimeoutMs(input: {
  configuredTimeoutMs?: number | null;
  leaseTtlMs: number;
}): number {
  if (typeof input.configuredTimeoutMs === 'number') {
    return Math.max(0, input.configuredTimeoutMs);
  }
  return Math.max(DEFAULT_COMMAND_LEASE_ACQUIRE_TIMEOUT_MS, Math.max(0, input.leaseTtlMs));
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isLaunchFingerprintEchoMismatch(
  command: OpenCodeBridgeCommandName,
  expectedBehaviorFingerprint: string | null,
  data: unknown,
  error: unknown
): boolean {
  return (
    command === 'opencode.launchTeam' &&
    stringifyError(error) === 'OpenCode launch result behavior fingerprint mismatch' &&
    (!isRecord(data) || data.expectedBehaviorFingerprint !== expectedBehaviorFingerprint)
  );
}

function reconciliationRequiredLaunchResult<TData>(
  result: Extract<OpenCodeBridgeResult<TData>, { ok: true }>,
  message = 'OpenCode launch result behavior fingerprint mismatch'
): Extract<OpenCodeBridgeResult<TData>, { ok: false }> {
  return {
    ok: false,
    schemaVersion: result.schemaVersion,
    requestId: result.requestId,
    command: result.command,
    completedAt: result.completedAt,
    durationMs: result.durationMs,
    error: {
      kind: 'contract_violation',
      message,
      retryable: false,
    },
    diagnostics: [
      ...result.diagnostics,
      {
        type: 'opencode_bridge_unknown_outcome',
        providerId: 'opencode',
        severity: 'warning',
        message,
        createdAt: result.completedAt,
      },
    ],
  };
}

function isActiveOpenCodeBridgeCommandLeaseError(error: OpenCodeBridgeCommandLeaseError): boolean {
  return error.message.startsWith('OpenCode bridge command lease already active:');
}

function isOpenCodeBridgeUnknownOutcomeFailure(result: OpenCodeBridgeResult<unknown>): boolean {
  return (
    !result.ok &&
    (result.error.kind === 'timeout' ||
      result.error.kind === 'transport_watchdog_timeout' ||
      isOpenCodeBridgeEmptyOutputFailure(result))
  );
}

function isOpenCodeBridgeEmptyOutputFailure(result: OpenCodeBridgeResult<unknown>): boolean {
  return (
    !result.ok &&
    result.error.kind === 'contract_violation' &&
    (result.error.message === 'Bridge stdout was empty' ||
      result.error.message === 'Bridge stdout was empty after retry')
  );
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
