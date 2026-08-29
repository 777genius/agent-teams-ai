import { randomUUID } from 'crypto';

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
  type OpenCodeLaunchTeamCommandBody,
  type OpenCodeLaunchTeamCommandData,
  type RuntimeStoreManifestEvidence,
  stableHash,
  validateOpenCodeBridgeHandshake,
} from './OpenCodeBridgeCommandContract';
import { OpenCodeBridgeCommandLeaseError } from './OpenCodeBridgeCommandLedgerStore';
import {
  correlateOpenCodeLaunchAttemptResponseV1,
  decodeOpenCodeLaunchAttemptResponseV1,
} from './OpenCodeLaunchAttemptContractV1';
import { createOpenCodeLaunchRequestCorrelationDigestV1 } from './OpenCodeLaunchAttemptDigestV1';
import {
  discoverOpenCodeStrictLaunchLedgerIdentity,
  hasRecoverableOpenCodeStrictLaunchSideEffects,
  resolveOpenCodeStrictLaunchLedgerIdentity,
} from './OpenCodeStrictLaunchLedgerIdentity';
import {
  collectValidatedStrictLaunchMemberLinkage,
  recoverStrictLaunchMemberLinkage,
  toReconciliationRequiredReplay,
} from './OpenCodeStrictLaunchMemberLinkage';

import type {
  OpenCodeBridgeCommandLease,
  OpenCodeBridgeCommandLeaseStore,
  OpenCodeBridgeCommandLedger,
  OpenCodeBridgeCommandLedgerEntry,
} from './OpenCodeBridgeCommandLedgerStore';
import type { OpenCodeBridgeInvocationOptions } from './OpenCodeBridgeInvocationAuthority';
import type { OpenCodeLaunchAttemptResponse } from './OpenCodeLaunchAttemptContractV1';

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
    } & OpenCodeBridgeInvocationOptions
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
  failpoints?: {
    afterStrictLaunchReplayDisposition?(): Promise<void> | void;
    beforeStrictLaunchCompletionPersistence?(): Promise<void> | void;
    afterStrictLaunchCompletionPersistence?(): Promise<void> | void;
  };
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
  private readonly leaseAcquireTimeoutMs: number | null;
  private readonly leaseAcquireRetryDelayMs: number;
  private readonly failpoints: NonNullable<
    OpenCodeStateChangingBridgeCommandServiceOptions['failpoints']
  >;

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
    this.leaseAcquireTimeoutMs = options.leaseAcquireTimeoutMs ?? null;
    this.leaseAcquireRetryDelayMs =
      options.leaseAcquireRetryDelayMs ?? DEFAULT_COMMAND_LEASE_ACQUIRE_RETRY_DELAY_MS;
    this.failpoints = options.failpoints ?? {};
  }

  async execute<TBody, TData>(
    input: {
      command: OpenCodeBridgeCommandName;
      teamName: string;
      laneId?: string | null;
      runId: string | null;
      capabilitySnapshotId: string | null;
      behaviorFingerprint: string | null;
      body: TBody;
      cwd: string;
      timeoutMs: number;
    } & OpenCodeBridgeInvocationOptions
  ): Promise<OpenCodeBridgeResult<TData>> {
    const normalizedLaneId = input.laneId ?? null;
    let previousSideEffectsPublished = false;
    const publishPreviousSideEffects = async (): Promise<void> => {
      if (previousSideEffectsPublished) return;
      previousSideEffectsPublished = true;
      input.onInvocationDisposition?.('previous_side_effects_recovered');
      await this.failpoints.afterStrictLaunchReplayDisposition?.();
    };
    const genericCommandIdempotencyKey = createOpenCodeBridgeIdempotencyKey({
      command: input.command,
      teamName: input.teamName,
      laneId: normalizedLaneId,
      runId: input.runId,
      body: input.body,
    });
    const strictLaunchAttemptId =
      input.command === 'opencode.launchTeam' ? requireStrictLaunchAttemptId(input.body) : null;
    const strictLaunchRequestHash =
      input.command === 'opencode.launchTeam'
        ? createBridgeCommandRequestHash(input, normalizedLaneId, null)
        : null;
    let strictLaunchLedgerResolution: ReturnType<
      typeof resolveOpenCodeStrictLaunchLedgerIdentity
    > | null = null;
    if (input.command === 'opencode.launchTeam' && strictLaunchRequestHash) {
      const entries = await this.ledger.list();
      const body = input.body as OpenCodeLaunchTeamCommandBody;
      const discovery = discoverOpenCodeStrictLaunchLedgerIdentity({ body, entries });
      if (hasRecoverableOpenCodeStrictLaunchSideEffects(discovery.predecessorEntry)) {
        await publishPreviousSideEffects();
      }
      strictLaunchLedgerResolution = resolveOpenCodeStrictLaunchLedgerIdentity({
        body,
        requestHash: strictLaunchRequestHash,
        entries,
        discovery,
      });
    }
    const ledgerIdempotencyKey =
      strictLaunchLedgerResolution?.ledgerIdempotencyKey ?? genericCommandIdempotencyKey;

    if (input.command === 'opencode.launchTeam' && strictLaunchRequestHash) {
      const entry = strictLaunchLedgerResolution?.existingEntry ?? null;
      if (entry) {
        if (entry.requestHash !== strictLaunchRequestHash) {
          throw new Error('OpenCode bridge idempotency key reused with different payload');
        }
        const recoverable =
          entry.status === 'completed' ||
          (entry.status === 'started' && entry.strictLaunchResponseJson != null);
        if (recoverable) {
          await publishPreviousSideEffects();
          const replay = this.recoverStrictLaunchResult(
            input.body as OpenCodeLaunchTeamCommandBody,
            entry
          );
          if (entry.status === 'started') {
            await this.failpoints.beforeStrictLaunchCompletionPersistence?.();
            await this.ledger.markCompleted({ idempotencyKey: ledgerIdempotencyKey });
            await this.failpoints.afterStrictLaunchCompletionPersistence?.();
          }
          return replay as OpenCodeBridgeResult<TData>;
        }
      }
    }

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
      requiresVideoFilePartsContract: requiresOpenCodeVideoFilePartsContract(
        input.command,
        input.body
      ),
    });

    if (!handshakeValidation.ok) {
      throw new Error(handshakeValidation.reason);
    }

    const requestHash =
      strictLaunchRequestHash ??
      createBridgeCommandRequestHash(input, normalizedLaneId, expectedManifestHighWatermark);
    const commandRequestId = this.requestIdFactory();
    const lease = await this.acquireLease({
      teamName: input.teamName,
      laneId: normalizedLaneId,
      runId: input.runId,
      command: input.command,
      ttlMs: input.timeoutMs + OPEN_CODE_BRIDGE_TRANSPORT_WATCHDOG_GRACE_MS + 5_000,
    });

    try {
      const bridgeIdempotencyKey = strictLaunchAttemptId ?? genericCommandIdempotencyKey;
      const bodyWithPreconditions = attachBridgePreconditions(input.body, {
        handshakeIdentityHash: handshake.identityHash,
        laneId: normalizedLaneId,
        expectedRunId: input.runId,
        expectedCapabilitySnapshotId: input.capabilitySnapshotId,
        expectedBehaviorFingerprint: input.behaviorFingerprint,
        expectedManifestHighWatermark,
        commandLeaseId: lease.leaseId,
        idempotencyKey: bridgeIdempotencyKey,
      });
      let bodyForDispatch = bodyWithPreconditions;
      let requestCorrelationDigest: string | null = null;
      if (input.command === 'opencode.launchTeam') {
        const strictBody = bodyWithPreconditions as unknown as OpenCodeLaunchTeamCommandBody & {
          preconditions: OpenCodeBridgeCommandPreconditions;
        };
        requestCorrelationDigest = createOpenCodeLaunchRequestCorrelationDigestV1({
          command: strictBody,
          preconditions: strictBody.preconditions,
          requestedBudgetMs: input.timeoutMs > 0 ? input.timeoutMs : 300_000,
        });
        bodyForDispatch = {
          ...strictBody,
          launchAttempt: {
            ...strictBody.launchAttempt,
            requestCorrelationDigest,
          },
        } as unknown as typeof bodyWithPreconditions;
      }

      const begin = await this.ledger.begin({
        idempotencyKey: ledgerIdempotencyKey,
        requestId: commandRequestId,
        command: input.command,
        teamName: input.teamName,
        laneId: input.laneId,
        runId: input.runId,
        requestHash,
      });

      if (
        begin === 'duplicate_same_payload_completed' ||
        begin === 'duplicate_same_payload_recoverable'
      ) {
        if (input.command === 'opencode.launchTeam') {
          const entry = await this.ledger.getByIdempotencyKey(ledgerIdempotencyKey);
          await publishPreviousSideEffects();
          const replay = this.recoverStrictLaunchResult(
            input.body as OpenCodeLaunchTeamCommandBody,
            entry
          );
          if (begin === 'duplicate_same_payload_recoverable') {
            await this.failpoints.beforeStrictLaunchCompletionPersistence?.();
            await this.ledger.markCompleted({ idempotencyKey: ledgerIdempotencyKey });
            await this.failpoints.afterStrictLaunchCompletionPersistence?.();
          }
          await this.leaseStore.release(lease.leaseId);
          return replay as OpenCodeBridgeResult<TData>;
        }
        throw new Error('OpenCode bridge command already completed; recover through commandStatus');
      }

      const result = await this.bridge.execute<typeof bodyWithPreconditions, TData>(
        input.command,
        bodyForDispatch,
        {
          cwd: input.cwd,
          timeoutMs: input.timeoutMs,
          requestId: commandRequestId,
          invocationAuthority: input.invocationAuthority,
          onInvocationDispatched: input.onInvocationDispatched,
        }
      );

      if (!result.ok) {
        if (isOpenCodeBridgeUnknownOutcomeFailure(result)) {
          await this.ledger.markUnknownAfterTimeout({
            idempotencyKey: ledgerIdempotencyKey,
            error: result.error.message,
          });
          await this.appendUnknownOutcomeDiagnostic({
            result,
            teamName: input.teamName,
            laneId: normalizedLaneId,
            runId: input.runId,
            command: input.command,
            idempotencyKey: bridgeIdempotencyKey,
            leaseId: lease.leaseId,
          });
        } else {
          await this.ledger.markFailed({
            idempotencyKey: ledgerIdempotencyKey,
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
          idempotencyKey: bridgeIdempotencyKey,
          enforceManifestHighWatermark,
          allowCapabilitySnapshotRecovery: isOpenCodeLaunchCapabilitySnapshotRecoveryAttempt(
            input.command,
            input.body
          ),
        });
      } catch (error) {
        await this.ledger.markFailed({
          idempotencyKey: ledgerIdempotencyKey,
          error: stringifyError(error),
          retryable: false,
        });
        throw error;
      }
      if (input.command === 'opencode.launchTeam') {
        try {
          const strictResponse = this.correlateStrictLaunchResult(
            {
              command: bodyForDispatch as unknown as OpenCodeLaunchTeamCommandBody,
              preconditions: bodyForDispatch.preconditions,
              requestedBudgetMs: input.timeoutMs > 0 ? input.timeoutMs : 300_000,
            },
            result.data
          );
          if (isRecord(result.data)) {
            (result.data as Record<string, unknown>).launchAttempt = strictResponse;
          }
          await this.ledger.persistStrictLaunchResponse({
            idempotencyKey: ledgerIdempotencyKey,
            response: strictResponse,
            memberLinkage: collectValidatedStrictLaunchMemberLinkage(
              bodyForDispatch as unknown as OpenCodeLaunchTeamCommandBody,
              strictResponse,
              result.data
            ),
            requestCorrelationDigest: requireRequestCorrelationDigest(requestCorrelationDigest),
          });
        } catch (error) {
          const message = stringifyError(error);
          if (message.includes('launchAttempt.requestCorrelationDigest')) {
            await this.ledger.markUnknownAfterTimeout({
              idempotencyKey: ledgerIdempotencyKey,
              error: `${message}; outcome must be reconciled`,
            });
          } else {
            await this.ledger.markFailed({
              idempotencyKey: ledgerIdempotencyKey,
              error: message,
              retryable: false,
            });
          }
          throw error;
        }
        await this.failpoints.beforeStrictLaunchCompletionPersistence?.();
        await this.ledger.markCompleted({ idempotencyKey: ledgerIdempotencyKey });
        await this.failpoints.afterStrictLaunchCompletionPersistence?.();
      } else {
        await this.ledger.markCompleted({ idempotencyKey: ledgerIdempotencyKey, response: result });
      }
      await this.leaseStore.release(lease.leaseId);
      return result;
    } catch (error) {
      await this.leaseStore.release(lease.leaseId).catch(() => undefined);
      throw error;
    }
  }

  private correlateStrictLaunchResult(
    authority: {
      command: OpenCodeLaunchTeamCommandBody;
      preconditions: OpenCodeBridgeCommandPreconditions;
      requestedBudgetMs: number;
    },
    data: unknown
  ): OpenCodeLaunchAttemptResponse {
    const body = authority.command;
    if (!Array.isArray(body.members) || !isRecord(body.launchAttempt)) {
      throw new Error('OpenCode strict launch request is malformed');
    }
    const response = isRecord(data) ? data.launchAttempt : undefined;
    const correlated = correlateOpenCodeLaunchAttemptResponseV1({
      authority,
      response,
    });
    if (!correlated.ok) {
      throw new Error(`OpenCode strict launch response failed correlation at ${correlated.field}`);
    }
    return correlated.value;
  }

  private recoverStrictLaunchResult(
    body: OpenCodeLaunchTeamCommandBody,
    entry: OpenCodeBridgeCommandLedgerEntry | null
  ): OpenCodeBridgeResult<OpenCodeLaunchTeamCommandData> {
    if (!entry?.strictLaunchResponseJson || !entry.responseHash) {
      throw new Error('Completed OpenCode strict launch response is not durably recoverable');
    }
    let stored: unknown;
    try {
      stored = JSON.parse(entry.strictLaunchResponseJson);
    } catch {
      throw new Error('Durable OpenCode strict launch response is corrupt');
    }
    if (stableHash(stored) !== entry.responseHash) {
      throw new Error('Durable OpenCode strict launch response hash mismatch');
    }
    const decoded = decodeOpenCodeLaunchAttemptResponseV1(stored);
    if (!decoded.ok) {
      throw new Error(`Durable OpenCode strict launch response is invalid at ${decoded.field}`);
    }
    let response = decoded.value;
    if (
      !entry.requestCorrelationDigest ||
      response.launchAttempt.requestCorrelationDigest !== entry.requestCorrelationDigest
    ) {
      throw new Error(
        'Durable OpenCode strict launch response lacks matching request correlation evidence; outcome must be reconciled'
      );
    }
    const partition = [
      ...response.members.committed.map((member) => member.memberIdentity),
      ...response.members.failed.map((member) => member.memberIdentity),
      ...response.members.pending,
    ];
    const expectedMembers = body.members.map((member) => member.memberIdentity);
    if (
      response.launchAttempt.attemptId !== body.launchAttempt.attemptId ||
      response.launchAttempt.payloadHash !== body.launchAttempt.payloadHash ||
      response.launchAttempt.generation !== body.launchAttempt.generation ||
      response.launchAttempt.providerId !== body.launchAttempt.providerId ||
      response.launchAttempt.modelId !== body.launchAttempt.modelId ||
      partition.length !== expectedMembers.length ||
      expectedMembers.some((identity) => !partition.includes(identity))
    ) {
      throw new Error('Durable OpenCode strict launch response does not match its request');
    }
    const memberLinkage = recoverStrictLaunchMemberLinkage(entry, body, response);
    const missingCommittedLinkage = response.members.committed.some((committed) => {
      const member = body.members.find(
        (candidate) => candidate.memberIdentity === committed.memberIdentity
      );
      return !member || memberLinkage.members[member.name] === undefined;
    });
    if (missingCommittedLinkage) {
      response = toReconciliationRequiredReplay(response);
    }
    return {
      ok: true,
      schemaVersion: 1,
      requestId: entry.requestId,
      command: 'opencode.launchTeam',
      completedAt: entry.completedAt ?? this.clock().toISOString(),
      durationMs: 0,
      runtime: {
        providerId: 'opencode',
        binaryPath: null,
        binaryFingerprint: null,
        version: null,
        capabilitySnapshotId: null,
      },
      diagnostics: [],
      data: {
        runId: body.runId,
        members: Object.fromEntries(
          Object.entries(memberLinkage.members).map(([name, linkage]) => [
            name,
            {
              sessionId: linkage.sessionId,
              launchState: 'confirmed_alive' as const,
              model: body.selectedModel,
              evidence: [],
            },
          ])
        ),
        warnings: [],
        diagnostics: [
          {
            code: missingCommittedLinkage
              ? 'opencode_strict_launch_replay_reconciliation_required'
              : 'opencode_strict_launch_durable_replay',
            severity: 'warning',
            message: missingCommittedLinkage
              ? 'Recovered a strict launch without complete durable member linkage; reconciliation is required and runtime ownership is retained.'
              : 'Recovered the exact sanitized strict launch response and validated member linkage without bridge dispatch.',
          },
        ],
        launchAttempt: response,
      },
    };
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
        : 'OpenCode bridge command timed out; outcome must be reconciled before retry',
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
  // Message delivery has its own durable acceptance evidence. Stop is a
  // monotonic teardown fenced by exact team/lane/run ownership, so app-owned
  // manifest evidence must not prevent the runtime from being terminated.
  return command !== 'opencode.sendMessage' && command !== 'opencode.stopTeam';
}

function createBridgeCommandRequestHash(
  input: {
    command: OpenCodeBridgeCommandName;
    teamName: string;
    runId: string | null;
    capabilitySnapshotId: string | null;
    behaviorFingerprint: string | null;
    body: unknown;
  },
  normalizedLaneId: string | null,
  expectedManifestHighWatermark: number | null
): string {
  return stableHash({
    command: input.command,
    teamName: input.teamName,
    laneId: normalizedLaneId,
    runId: input.runId,
    capabilitySnapshotId: input.capabilitySnapshotId,
    behaviorFingerprint: input.behaviorFingerprint,
    manifestHighWatermark: expectedManifestHighWatermark,
    body: input.body,
  });
}

function requireStrictLaunchAttemptId(body: unknown): string {
  if (!isRecord(body) || !isRecord(body.launchAttempt)) {
    throw new Error('OpenCode strict launch request is malformed');
  }
  const attemptId = body.launchAttempt.attemptId;
  if (typeof attemptId !== 'string' || attemptId.length === 0) {
    throw new Error('OpenCode strict launch request is missing attemptId');
  }
  return attemptId;
}

function requireRequestCorrelationDigest(value: string | null): string {
  if (value === null) {
    throw new Error('OpenCode strict launch request correlation digest was not computed');
  }
  return value;
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
