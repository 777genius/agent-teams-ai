import {
  type OpenCodeBridgePeerIdentity,
  type OpenCodeBridgeResult,
  parseSingleBridgeJsonResult,
  type RuntimeStoreManifestEvidence,
  stableHash,
  validateOpenCodeBridgeHandshake,
} from './OpenCodeBridgeCommandContract';
import {
  type OpenCodeBridgeCommandLedger,
  type OpenCodeBridgeCommandLedgerEntry,
} from './OpenCodeBridgeCommandLedgerStore';
import {
  object,
  parseRuntimeStopRequest,
  type RuntimeStopRequest,
  validateRuntimeStopObservation,
  validateRuntimeStopReceipt,
} from './OpenCodeRuntimeStopProtocol';
import { type OpenCodeStopTarget, recoverCompletedStop } from './OpenCodeStopOutcomeRecovery';

import type {
  OpenCodeBridgeCommandExecutor,
  OpenCodeBridgeHandshakePort,
} from './OpenCodeStateChangingBridgeCommandService';

export function createStopTarget(
  input: {
    teamName: string;
    laneId: string | null;
    runId: string | null;
    capabilitySnapshotId: string | null;
    behaviorFingerprint: string | null;
    cwd: string;
    body: unknown;
  },
  manifest: RuntimeStoreManifestEvidence
): OpenCodeStopTarget {
  const target: OpenCodeStopTarget = {
    ...input,
    body: structuredClone(input.body),
    sessionIdentityHash: manifest.sessionIdentityHash ?? null,
  };
  const body = object(input.body);
  if (body.projectPath !== undefined && body.projectPath !== input.cwd)
    throw new Error('Stop project identity mismatch; reconciliation unknown');
  const sessions = manifest.stopSessions;
  if (
    sessions?.length &&
    /^opencode:[a-f0-9]{32}$/.test(input.capabilitySnapshotId ?? '') &&
    /^[a-f0-9]{64}$/.test(input.behaviorFingerprint ?? manifest.behaviorFingerprint ?? '') &&
    sessions.every(
      (s) =>
        s.teamName === input.teamName &&
        s.laneId === (input.laneId ?? 'primary') &&
        s.runId === input.runId
    )
  ) {
    target.runtimeTarget = parseRuntimeStopRequest({
      contractVersion: 1,
      originalRequestId: 'validation',
      idempotencyKey: 'validation',
      target: {
        teamId: input.teamName,
        laneId: input.laneId ?? 'primary',
        runId: input.runId,
        projectPath: input.cwd,
        capabilitySnapshotId: input.capabilitySnapshotId,
        expectedBehaviorFingerprint: input.behaviorFingerprint ?? manifest.behaviorFingerprint,
        members: sessions.map((s) => ({ memberName: s.memberName, sessionId: s.sessionId })),
      },
    }).target;
  }
  return target;
}
export function runtimeStopRequest(
  entry: Pick<OpenCodeBridgeCommandLedgerEntry, 'requestId' | 'idempotencyKey'>,
  target: OpenCodeStopTarget
): RuntimeStopRequest {
  if (!target.runtimeTarget)
    throw new Error('Stop reconciliation unknown: incomplete original session target');
  return parseRuntimeStopRequest({
    contractVersion: 1,
    originalRequestId: entry.requestId,
    idempotencyKey: entry.idempotencyKey,
    target: target.runtimeTarget,
  });
}

/** Lookup and current observation never dispatch Stop or rewrite a legacy completion. */
export async function recoverRuntimeStop<TData>(input: {
  entry: OpenCodeBridgeCommandLedgerEntry;
  current: OpenCodeStopTarget;
  manifest: RuntimeStoreManifestEvidence;
  expectedClient: OpenCodeBridgePeerIdentity;
  handshakePort: OpenCodeBridgeHandshakePort;
  bridge: OpenCodeBridgeCommandExecutor;
  ledger: OpenCodeBridgeCommandLedger;
  timeoutMs: number;
}): Promise<OpenCodeBridgeResult<TData>> {
  const { entry, current, manifest } = input;
  if (entry.status === 'completed' && entry.stopRecovery)
    return recoverCompletedStop(entry, current, manifest);
  const retained = entry.stopTarget;
  if (!retained?.runtimeTarget || !current.sessionIdentityHash)
    throw new Error('Stop reconciliation unknown: insufficient retained original target evidence');
  if (
    entry.command !== 'opencode.stopTeam' ||
    entry.teamName !== current.teamName ||
    entry.laneId !== current.laneId ||
    entry.runId !== current.runId ||
    stableHash(retained) !== stableHash(current)
  )
    throw new Error('Stop original target mismatch; reconciliation required');
  const request = runtimeStopRequest(entry, retained);
  const handshake = await input.handshakePort.handshake({
    requiredCommand: 'opencode.stopOutcome',
    expectedRunId: null,
    expectedCapabilitySnapshotId: null,
    expectedManifestHighWatermark: null,
    cwd: retained.cwd,
    teamId: retained.teamName,
    laneId: retained.laneId,
  });
  const validation = validateOpenCodeBridgeHandshake({
    handshake,
    expectedClient: input.expectedClient,
    requiredCommand: 'opencode.stopOutcome',
    expectedRunId: null,
    expectedCapabilitySnapshotId: null,
    expectedManifestHighWatermark: null,
  });
  if (!validation.ok) throw new Error(validation.reason);
  if (
    handshake.stopRecoveryContractVersion !== 1 ||
    !handshake.acceptedCommands.includes('opencode.reconcileStop') ||
    !handshake.server.bridgeProtocol.supportedCommands.includes('opencode.reconcileStop')
  )
    throw new Error('Stop reconciliation unsupported: runtime contract version 1 required');
  const query = async (command: 'opencode.stopOutcome' | 'opencode.reconcileStop') => {
    // Transport request IDs identify observations only. Original authority stays in stopRecovery.
    const requestId = `${entry.requestId}:${command}`;
    const result = await input.bridge.execute(
      command,
      { stopRecovery: request },
      { cwd: retained.cwd, timeoutMs: input.timeoutMs, requestId }
    );
    const parsed = parseSingleBridgeJsonResult<unknown>(JSON.stringify(result));
    if (
      !parsed.ok ||
      !parsed.value.ok ||
      result.requestId !== requestId ||
      result.command !== command
    )
      throw new Error('Invalid Stop recovery response; reconciliation unknown');
    return parsed.value;
  };
  const outcome = await query('opencode.stopOutcome');
  const data = object(outcome.data);
  if (data.status === 'completed') {
    const receipt = validateRuntimeStopReceipt(data.receipt, request);
    // Reconstitute the original domain result from the durable receipt. Transport timing
    // belongs to this lookup; the receipt does not promise original transport metadata.
    const recovered = {
      ...outcome,
      command: 'opencode.stopTeam' as const,
      requestId: entry.requestId,
      runtime: receipt.runtime,
      data: receipt.data,
    };
    await input.ledger.markCompleted({
      idempotencyKey: entry.idempotencyKey,
      response: recovered,
      stopRecovery: { target: retained, result: recovered },
    });
    return recovered as OpenCodeBridgeResult<TData>;
  }
  if (data.status !== 'unknown' && data.status !== 'inflight')
    throw new Error(`Stop outcome ${String(data.status)}; reconciliation required`);
  const observed = await query('opencode.reconcileStop');
  validateRuntimeStopObservation(observed.data, request);
  // Return the actual observation envelope, without manufacturing a historical Stop
  // result or marking the original app ledger complete. Cleanup uses the app lane CAS.
  return observed as OpenCodeBridgeResult<TData>;
}
