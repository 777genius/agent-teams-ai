import {
  assertBridgeEvidenceCanCommitToRuntimeStores,
  type OpenCodeBridgeResult,
  parseSingleBridgeJsonResult,
  type RuntimeStoreManifestEvidence,
  stableHash,
} from './OpenCodeBridgeCommandContract';
import {
  parseRuntimeStopRequest,
  type RuntimeStopTarget,
  validateRuntimeStopData,
} from './OpenCodeRuntimeStopProtocol';

import type { OpenCodeBridgeCommandLedgerEntry } from './OpenCodeBridgeCommandLedgerStore';

/** Original authority, independent of transport request/lease IDs and mutable watermarks. */
export interface OpenCodeStopTarget {
  teamName: string;
  laneId: string | null;
  runId: string | null;
  capabilitySnapshotId: string | null;
  behaviorFingerprint: string | null;
  cwd: string;
  body: unknown;
  sessionIdentityHash: string | null;
  runtimeTarget?: RuntimeStopTarget;
}

export interface OpenCodeStopRecovery {
  target: OpenCodeStopTarget;
  result: OpenCodeBridgeResult<unknown>;
}

export function assertStopDomainResult(result: OpenCodeBridgeResult<unknown>): void {
  if (!result.ok) throw new Error('Stop recovery requires a validated success envelope');
  const data = result.data;
  if (
    !record(data) ||
    typeof data.runId !== 'string' ||
    typeof data.stopped !== 'boolean' ||
    !record(data.members) ||
    data.stopped !==
      Object.values(data.members).every((member) => record(member) && member.stopped === true) ||
    !Array.isArray(data.warnings) ||
    !Array.isArray(data.diagnostics) ||
    !data.warnings.every((item) => typeof item === 'string') ||
    !data.diagnostics.every(
      (item) =>
        record(item) &&
        typeof item.message === 'string' &&
        typeof item.code === 'string' &&
        typeof item.severity === 'string' &&
        ['info', 'warning', 'error'].includes(item.severity)
    ) ||
    !Object.values(data.members).every(
      (member) =>
        record(member) &&
        typeof member.stopped === 'boolean' &&
        (member.sessionId === undefined || typeof member.sessionId === 'string') &&
        Array.isArray(member.diagnostics) &&
        member.diagnostics.every((item) => typeof item === 'string')
    )
  ) {
    throw new Error('Invalid OpenCode Stop domain result; exact-target reconciliation required');
  }
}

export function recoverCompletedStop<TData>(
  entry: OpenCodeBridgeCommandLedgerEntry | null,
  target: OpenCodeStopTarget,
  manifest: RuntimeStoreManifestEvidence
): OpenCodeBridgeResult<TData> {
  const saved = entry?.stopRecovery;
  if (
    !entry ||
    entry.status !== 'completed' ||
    !saved ||
    !record(saved) ||
    !record(saved.target) ||
    !record(saved.result) ||
    !target.sessionIdentityHash
  ) {
    throw new Error(
      'OpenCode Stop requires authoritative exact-target reconciliation; no durable outcome'
    );
  }
  if (
    entry.command !== 'opencode.stopTeam' ||
    entry.teamName !== target.teamName ||
    entry.laneId !== target.laneId ||
    entry.runId !== target.runId ||
    stableHash(saved.target) !== stableHash(target) ||
    stableHash(saved.result) !== entry.responseHash
  ) {
    throw new Error('OpenCode Stop recovery target or outcome mismatch; reconciliation required');
  }
  const parsed = parseSingleBridgeJsonResult<TData>(JSON.stringify(saved.result));
  if (!parsed.ok)
    throw new Error(`OpenCode Stop recovery requires reconciliation: ${parsed.error}`);
  if (target.runtimeTarget) {
    // Version 1 binds the key in the retained request; its data echo is optional.
    if (
      !parsed.value.ok ||
      parsed.value.requestId !== entry.requestId ||
      parsed.value.command !== 'opencode.stopTeam' ||
      parsed.value.runtime.capabilitySnapshotId !== target.capabilitySnapshotId
    )
      throw new Error('Stop receipt envelope identity mismatch; reconciliation required');
    validateRuntimeStopData(
      parsed.value.data,
      parseRuntimeStopRequest({
        contractVersion: 1,
        originalRequestId: entry.requestId,
        idempotencyKey: entry.idempotencyKey,
        target: target.runtimeTarget,
      })
    );
  } else {
    assertBridgeEvidenceCanCommitToRuntimeStores({
      result: parsed.value,
      requestId: entry.requestId,
      command: 'opencode.stopTeam',
      runId: target.runId,
      capabilitySnapshotId: target.capabilitySnapshotId,
      manifest,
      idempotencyKey: entry.idempotencyKey,
      enforceManifestHighWatermark: false,
    });
  }
  assertStopDomainResult(parsed.value);
  return parsed.value;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
