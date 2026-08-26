import { createHash } from 'node:crypto';

import { type OpenCodeLaunchTeamCommandBody } from '../opencode/bridge/OpenCodeBridgeCommandContract';

import type {
  OpenCodeLaunchAttemptResponse,
  OpenCodeOpaqueIdentity,
} from '../opencode/bridge/OpenCodeLaunchAttemptContractV1';
import type {
  TeamRuntimeLaunchInput,
  TeamRuntimeLaunchResult,
  TeamRuntimeMemberLaunchEvidence,
} from './TeamRuntimeAdapter';
import type { PersistedOpenCodeStrictLaunchAttempt } from '@shared/types/openCodeStrictLaunch';

export function authorizeOpenCodeCommittedMemberSession(input: {
  response: OpenCodeLaunchAttemptResponse;
  memberIdentity: OpenCodeOpaqueIdentity | undefined;
  sessionId: string | undefined;
}): { committed: boolean; diagnostics: string[] } {
  const linkage = input.memberIdentity
    ? input.response.members.committed.find(
        (member) => member.memberIdentity === input.memberIdentity
      )
    : undefined;
  const committed = !!(
    linkage &&
    input.sessionId &&
    `sha256:${createHash('sha256')
      .update(JSON.stringify({ kind: 'opencode-session', id: input.sessionId }))
      .digest('hex')}` === linkage.sessionIdentity
  );
  return {
    committed,
    diagnostics:
      linkage && !committed
        ? [
            'OpenCode committed member session did not match its strict launch linkage; live runtime evidence was rejected.',
          ]
        : [],
  };
}

export function buildPersistedOpenCodeStrictLaunchAttempt(
  command: OpenCodeLaunchTeamCommandBody,
  response: OpenCodeLaunchAttemptResponse
): PersistedOpenCodeStrictLaunchAttempt | undefined {
  const outcome = response.launchAttempt.outcome;
  const continuationToken = response.members.continuationToken;
  if (outcome !== 'reconciliation_required' && !(outcome === 'partial' && continuationToken)) {
    return undefined;
  }
  return {
    contractVersion: 1,
    disposition:
      outcome === 'reconciliation_required' ? 'reconciliation_required' : 'continuation_eligible',
    attemptId: response.launchAttempt.attemptId,
    payloadHash: response.launchAttempt.payloadHash,
    generation: response.launchAttempt.generation,
    runId: command.runId,
    laneId: command.laneId,
    parent: { ...command.launchAttempt.parent },
    ...(outcome === 'partial' && continuationToken ? { continuationToken } : {}),
    inputDigest: response.launchAttempt.inputDigest,
    immutableDigest: response.launchAttempt.immutableDigest,
    providerId: response.launchAttempt.providerId,
    modelId: response.launchAttempt.modelId,
    roster: command.members.map((member) => ({
      name: member.name,
      memberIdentity: member.memberIdentity,
    })),
    partitions: {
      committed: response.members.committed.map((member) => member.memberIdentity),
      failed: response.members.failed.map((member) => member.memberIdentity),
      pending: [...response.members.pending],
      cleanupPending: [...response.members.cleanupPending],
    },
  };
}

export function buildOpenCodeReconciliationBlockResult(
  input: TeamRuntimeLaunchInput,
  command: OpenCodeLaunchTeamCommandBody,
  previous: PersistedOpenCodeStrictLaunchAttempt | undefined,
  diagnostic: string
): TeamRuntimeLaunchResult {
  const identities = command.members.map((member) => member.memberIdentity);
  const state: PersistedOpenCodeStrictLaunchAttempt = {
    contractVersion: 1,
    disposition: 'reconciliation_required',
    attemptId: previous?.attemptId ?? command.launchAttempt.attemptId,
    payloadHash: previous?.payloadHash ?? command.launchAttempt.payloadHash,
    generation: previous?.generation ?? command.launchAttempt.generation,
    runId: previous?.runId ?? command.runId,
    laneId: previous?.laneId ?? command.laneId,
    parent: { ...(previous?.parent ?? command.launchAttempt.parent) },
    inputDigest: previous?.inputDigest ?? null,
    immutableDigest: previous?.immutableDigest ?? null,
    providerId: previous?.providerId ?? command.launchAttempt.providerId,
    modelId: previous?.modelId ?? command.launchAttempt.modelId,
    roster:
      previous?.roster.map((member) => ({ ...member })) ??
      command.members.map((member) => ({
        name: member.name,
        memberIdentity: member.memberIdentity,
      })),
    partitions: previous
      ? {
          committed: [...previous.partitions.committed],
          failed: [...previous.partitions.failed],
          pending: [...previous.partitions.pending],
          cleanupPending: [...previous.partitions.cleanupPending],
        }
      : { committed: [], failed: [], pending: identities, cleanupPending: [] },
  };
  return {
    runId: input.runId,
    teamName: input.teamName,
    launchPhase: 'active',
    teamLaunchState: 'partial_pending',
    members: Object.fromEntries(
      input.expectedMembers.map((member) => [
        member.name,
        {
          memberName: member.name,
          providerId: 'opencode',
          ...(member.model ? { model: member.model } : {}),
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: false,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
          livenessKind: 'registered_only',
          diagnostics: [diagnostic],
        } satisfies TeamRuntimeMemberLaunchEvidence,
      ])
    ),
    warnings: [],
    diagnostics: [diagnostic],
    openCodeStrictLaunchAttempt: state,
  };
}
