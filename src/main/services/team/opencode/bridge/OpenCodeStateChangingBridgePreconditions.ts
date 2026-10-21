import { isLowercaseSha256 } from '../readiness/OpenCodeExpectedBehaviorFingerprint';

import type {
  OpenCodeBridgeCommandName,
  OpenCodeBridgeCommandPreconditions,
  OpenCodeBridgeResult,
} from './OpenCodeBridgeCommandContract';
import type { OpenCodeBridgeCommandLeaseError } from './OpenCodeBridgeCommandLedgerStore';

const DEFAULT_COMMAND_LEASE_ACQUIRE_TIMEOUT_MS = 10_000;

export function assertLaunchBehaviorFingerprint(
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

export function assertLaunchResultBehaviorFingerprint(
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isOpenCodeLaunchCapabilitySnapshotRecoveryAttempt(
  command: OpenCodeBridgeCommandName,
  body: unknown
): boolean {
  if (command !== 'opencode.launchTeam' || !isRecord(body)) {
    return false;
  }
  const recoveryAttemptId = body.capabilitySnapshotRecoveryAttemptId;
  return typeof recoveryAttemptId === 'string' && recoveryAttemptId.trim().length > 0;
}

export function requiresOpenCodeDeliveryAcceptanceContract(
  command: OpenCodeBridgeCommandName,
  body: unknown
): boolean {
  if (command !== 'opencode.sendMessage' || !isRecord(body)) {
    return false;
  }
  return body.settlementMode === 'acceptance';
}

export function requiresOpenCodeVideoFilePartsContract(
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

export function commandRequiresRuntimeStoreManifestPrecondition(
  command: OpenCodeBridgeCommandName
): boolean {
  // App metadata and runtime stores own independent watermarks. Lifecycle commands
  // are fenced by exact lane/run/capability authority, not cross-domain counters.
  // Launch binds fresh capability/behavior proof and owned session materialization;
  // message delivery has its own durable acceptance evidence.
  return (
    command !== 'opencode.launchTeam' &&
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

export function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isLaunchFingerprintEchoMismatch(
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

export function reconciliationRequiredLaunchResult<TData>(
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

export function isActiveOpenCodeBridgeCommandLeaseError(
  error: OpenCodeBridgeCommandLeaseError
): boolean {
  return error.message.startsWith('OpenCode bridge command lease already active:');
}

export function isOpenCodeBridgeUnknownOutcomeFailure(
  result: OpenCodeBridgeResult<unknown>
): boolean {
  return (
    !result.ok &&
    (result.error.kind === 'timeout' ||
      result.error.kind === 'transport_watchdog_timeout' ||
      isOpenCodeBridgeEmptyOutputFailure(result))
  );
}

export function isOpenCodeBridgeEmptyOutputFailure(result: OpenCodeBridgeResult<unknown>): boolean {
  return (
    !result.ok &&
    result.error.kind === 'contract_violation' &&
    (result.error.message === 'Bridge stdout was empty' ||
      result.error.message === 'Bridge stdout was empty after retry')
  );
}

export function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
