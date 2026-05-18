import { randomUUID } from 'crypto';

import {
  assertBridgeEvidenceCanCommitToRuntimeStores,
  createOpenCodeBridgeIdempotencyKey,
  extractRunId,
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
  }): Promise<OpenCodeBridgeHandshake>;
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
  private readonly manifestReader: RuntimeStoreManifestReader;
  private readonly diagnostics: OpenCodeStateChangingBridgeDiagnosticsSink | null;
  private readonly requestIdFactory: () => string;
  private readonly diagnosticIdFactory: () => string;
  private readonly clock: () => Date;
  private readonly leaseAcquireTimeoutMs: number;
  private readonly leaseAcquireRetryDelayMs: number;

  constructor(options: OpenCodeStateChangingBridgeCommandServiceOptions) {
    this.expectedClientIdentity = options.expectedClientIdentity;
    this.handshakePort = options.handshakePort;
    this.leaseStore = options.leaseStore;
    this.ledger = options.ledger;
    this.bridge = options.bridge;
    this.manifestReader = options.manifestReader;
    this.diagnostics = options.diagnostics ?? null;
    this.requestIdFactory = options.requestIdFactory ?? (() => `opencode-bridge-${randomUUID()}`);
    this.diagnosticIdFactory =
      options.diagnosticIdFactory ?? (() => `opencode-bridge-diagnostic-${randomUUID()}`);
    this.clock = options.clock ?? (() => new Date());
    this.leaseAcquireTimeoutMs =
      options.leaseAcquireTimeoutMs ?? DEFAULT_COMMAND_LEASE_ACQUIRE_TIMEOUT_MS;
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
    const normalizedLaneId = input.laneId ?? null;
    const manifest = await this.manifestReader.read(input.teamName, normalizedLaneId);
    const enforceManifestHighWatermark = commandRequiresRuntimeStoreManifestPrecondition(
      input.command
    );
    const expectedManifestHighWatermark = enforceManifestHighWatermark
      ? manifest.highWatermark
      : null;
    const handshake = await this.handshakePort.handshake({
      requiredCommand: input.command,
      expectedRunId: input.runId,
      expectedCapabilitySnapshotId: input.capabilitySnapshotId,
      expectedManifestHighWatermark,
      cwd: input.cwd,
    });
    const handshakeValidation = validateOpenCodeBridgeHandshake({
      handshake,
      expectedClient: this.expectedClientIdentity,
      requiredCommand: input.command,
      expectedCapabilitySnapshotId: input.capabilitySnapshotId,
      expectedManifestHighWatermark,
      expectedRunId: input.runId,
      requiresDeliveryAcceptanceContract: requiresOpenCodeDeliveryAcceptanceContract(
        input.command,
        input.body
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
      body: input.body,
    });
    const commandRequestId = this.requestIdFactory();
    const lease = await this.acquireLease({
      teamName: input.teamName,
      laneId: normalizedLaneId,
      runId: input.runId,
      command: input.command,
      ttlMs: input.timeoutMs + 5_000,
    });

    try {
      const bodyWithPreconditions = attachBridgePreconditions(input.body, {
        handshakeIdentityHash: handshake.identityHash,
        laneId: normalizedLaneId,
        expectedRunId: input.runId,
        expectedCapabilitySnapshotId: input.capabilitySnapshotId,
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
          capabilitySnapshotId: input.capabilitySnapshotId,
          behaviorFingerprint: input.behaviorFingerprint,
          manifestHighWatermark: expectedManifestHighWatermark,
          body: input.body,
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
        if (result.error.kind === 'timeout') {
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
          capabilitySnapshotId: input.capabilitySnapshotId,
          manifest,
          idempotencyKey,
          enforceManifestHighWatermark,
        });
      } catch (error) {
        await this.ledger.markFailed({
          idempotencyKey,
          error: stringifyError(error),
          retryable: false,
        });
        throw error;
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
    const deadlineMs = Date.now() + Math.max(0, this.leaseAcquireTimeoutMs);
    let lastError: unknown = null;

    do {
      try {
        return await this.leaseStore.acquire(input);
      } catch (error) {
        if (
          !(error instanceof OpenCodeBridgeCommandLeaseError) ||
          !isActiveOpenCodeBridgeCommandLeaseError(error)
        ) {
          throw error;
        }
        lastError = error;
        if (Date.now() >= deadlineMs) {
          throw error;
        }
        await sleep(Math.max(1, this.leaseAcquireRetryDelayMs));
      }
    } while (Date.now() < deadlineMs);

    throw lastError instanceof Error ? lastError : new Error('OpenCode bridge lease unavailable');
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
      message: 'OpenCode bridge command timed out; outcome must be reconciled before retry',
      createdAt: completedAt,
    });
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

function requiresOpenCodeDeliveryAcceptanceContract(
  command: OpenCodeBridgeCommandName,
  body: unknown
): boolean {
  if (command !== 'opencode.sendMessage' || !isRecord(body)) {
    return false;
  }
  return body.settlementMode === 'acceptance';
}

function commandRequiresRuntimeStoreManifestPrecondition(
  command: OpenCodeBridgeCommandName
): boolean {
  return command !== 'opencode.sendMessage';
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isActiveOpenCodeBridgeCommandLeaseError(error: OpenCodeBridgeCommandLeaseError): boolean {
  return error.message.startsWith('OpenCode bridge command lease already active:');
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
