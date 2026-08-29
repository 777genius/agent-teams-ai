import { createHash } from 'node:crypto';

import type {
  OpenCodeLaunchAttemptCorrelationRequest,
  OpenCodeOpaqueIdentity,
} from './OpenCodeLaunchAttemptContractV1';

export const OPEN_CODE_LAUNCH_REQUEST_CORRELATION_CONTRACT_VERSION = 1 as const;

export interface OpenCodeLaunchRequestCorrelationAuthorityV1 {
  command: {
    runId: string;
    laneId: string;
    teamId: string;
    projectPath: string;
    selectedModel: string;
    skipPermissions?: boolean;
    continuation?: boolean;
    members: readonly {
      name: string;
      memberIdentity: OpenCodeOpaqueIdentity;
      prompt?: string;
      effort?: string;
    }[];
    launchContractVersion: 1;
    launchAttempt: OpenCodeLaunchAttemptCorrelationRequest & {
      requireFreshRetainedHostProof: true;
    };
  };
  preconditions: {
    handshakeIdentityHash: string;
    laneId: string | null;
    expectedRunId: string | null;
    expectedCapabilitySnapshotId: string | null;
    expectedBehaviorFingerprint: string | null;
    expectedManifestHighWatermark: number | null;
    commandLeaseId: string | null;
    idempotencyKey: string;
  };
  requestedBudgetMs: number;
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

export function createOpenCodeLaunchAttemptIdV1(payloadHash: string, generation: number): string {
  const digest = hash({ contractVersion: 1, generation, payloadHash });
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

/**
 * Hashes the exact Desktop request values in the fixed order shared with the
 * Orchestrator worker. Call only after handshake/lease preconditions attach.
 */
export function createOpenCodeLaunchRequestCorrelationDigestV1(
  authority: OpenCodeLaunchRequestCorrelationAuthorityV1
): string {
  const { command, preconditions, requestedBudgetMs } = authority;
  const attempt = command.launchAttempt;
  const continuation = command.continuation === true || attempt.continuationToken !== undefined;
  return hash({
    domain: 'agent-teams/opencode-launch-request-correlation/v1',
    launchContractVersion: 1,
    attemptId: attempt.attemptId,
    payloadHash: attempt.payloadHash,
    generation: attempt.generation,
    proofNonce: attempt.proofNonce,
    parent: {
      sessionIdentity: attempt.parent.sessionIdentity,
      messageIdentity: attempt.parent.messageIdentity,
    },
    providerId: attempt.providerId,
    modelId: attempt.modelId,
    requiredMcpTools: [...attempt.requiredMcpTools],
    continuationToken: attempt.continuationToken ?? null,
    requireFreshRetainedHostProof: true,
    runId: command.runId,
    laneId: command.laneId,
    teamId: command.teamId,
    projectPath: command.projectPath,
    selectedModel: command.selectedModel,
    toolApprovalMode: command.skipPermissions === false ? 'manual' : 'auto',
    continuation,
    requestedBudgetMs,
    preconditions: {
      handshakeIdentityHash: preconditions.handshakeIdentityHash,
      laneId: preconditions.laneId,
      expectedRunId: preconditions.expectedRunId,
      expectedCapabilitySnapshotId: preconditions.expectedCapabilitySnapshotId,
      expectedBehaviorFingerprint: preconditions.expectedBehaviorFingerprint,
      expectedManifestHighWatermark: preconditions.expectedManifestHighWatermark,
      commandLeaseId: preconditions.commandLeaseId,
      idempotencyKey: preconditions.idempotencyKey,
    },
    members: command.members.map((member) => ({
      memberIdentity: member.memberIdentity,
      name: member.name,
      prompt: member.prompt ?? null,
      effort: member.effort ?? null,
    })),
  });
}
