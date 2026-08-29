import { createHash } from 'node:crypto';

import type {
  OpenCodeLaunchAttemptCorrelationRequest,
  OpenCodeLaunchAttemptDecodeResult,
  OpenCodeLaunchAttemptResponse,
  OpenCodeOpaqueIdentity,
  OpenCodeRetainedHostIdentity,
} from './OpenCodeLaunchAttemptContractV1';

function sameHost(
  left: OpenCodeRetainedHostIdentity,
  right: OpenCodeRetainedHostIdentity
): boolean {
  return (
    left.hostKeyIdentity === right.hostKeyIdentity &&
    left.processId === right.processId &&
    left.processStartedAtMs === right.processStartedAtMs &&
    left.profileScopeIdentity === right.profileScopeIdentity
  );
}

export function validateOpenCodeLaunchAttemptCorrelationV1(input: {
  decodedResponse: OpenCodeLaunchAttemptResponse;
  request: OpenCodeLaunchAttemptCorrelationRequest;
  expectedMemberIdentities: readonly OpenCodeOpaqueIdentity[];
}): OpenCodeLaunchAttemptDecodeResult {
  const { launchAttempt, proof, members } = input.decodedResponse;
  const { request, expectedMemberIdentities } = input;
  for (const [field, actual, expected] of [
    ['launchAttempt.attemptId', launchAttempt.attemptId, request.attemptId],
    ['launchAttempt.payloadHash', launchAttempt.payloadHash, request.payloadHash],
    ['launchAttempt.generation', launchAttempt.generation, request.generation],
    ['launchAttempt.providerId', launchAttempt.providerId, request.providerId],
    ['launchAttempt.modelId', launchAttempt.modelId, request.modelId],
  ] as const) {
    if (actual !== expected) return { ok: false, field };
  }
  if (
    request.requestCorrelationDigest === undefined ||
    launchAttempt.requestCorrelationDigest !== request.requestCorrelationDigest
  ) {
    return { ok: false, field: 'launchAttempt.requestCorrelationDigest' };
  }
  const partition = [
    ...members.committed.map((member) => member.memberIdentity),
    ...members.failed.map((member) => member.memberIdentity),
    ...members.pending,
  ];
  if (
    partition.length !== expectedMemberIdentities.length ||
    new Set(expectedMemberIdentities).size !== expectedMemberIdentities.length ||
    expectedMemberIdentities.some((identity) => !partition.includes(identity))
  ) {
    return { ok: false, field: 'members' };
  }
  const rosterOrder = new Map(
    expectedMemberIdentities.map((identity, index) => [identity, index] as const)
  );
  const orderedPartitions: readonly (readonly OpenCodeOpaqueIdentity[])[] = [
    members.committed.map((member) => member.memberIdentity),
    members.failed.map((member) => member.memberIdentity),
    members.pending,
    members.cleanupPending,
  ];
  if (
    orderedPartitions.some((identities) =>
      identities.some(
        (identity, index) =>
          index > 0 &&
          (rosterOrder.get(identities[index - 1]) ?? -1) >= (rosterOrder.get(identity) ?? -1)
      )
    )
  ) {
    return { ok: false, field: 'members' };
  }
  const cleanupEligible = new Set<OpenCodeOpaqueIdentity>([
    ...members.failed.map((member) => member.memberIdentity),
    ...members.pending,
  ]);
  if (members.cleanupPending.some((identity) => !cleanupEligible.has(identity))) {
    return { ok: false, field: 'members.cleanupPending' };
  }
  if (proof) {
    for (const [field, actual, expected] of [
      ['proof.attemptId', proof.attemptId, request.attemptId],
      ['proof.generation', proof.generation, request.generation],
      ['proof.providerId', proof.providerId, request.providerId],
      ['proof.modelId', proof.modelId, request.modelId],
    ] as const) {
      if (actual !== expected) return { ok: false, field };
    }
    const expectedNonceHash = createHash('sha256').update(request.proofNonce, 'utf8').digest('hex');
    if (proof.nonceHash !== expectedNonceHash) {
      return { ok: false, field: 'proof.nonceHash' };
    }
    if (proof.parent.sessionIdentity !== request.parent.sessionIdentity) {
      return { ok: false, field: 'proof.parent.sessionIdentity' };
    }
    if (proof.parent.messageIdentity !== request.parent.messageIdentity) {
      return { ok: false, field: 'proof.parent.messageIdentity' };
    }
    if (launchAttempt.profileIdentity !== launchAttempt.retainedHostIdentity.profileScopeIdentity) {
      return { ok: false, field: 'launchAttempt.profileIdentity' };
    }
    if (!sameHost(proof.retainedHostIdentity, launchAttempt.retainedHostIdentity)) {
      return { ok: false, field: 'proof.retainedHostIdentity' };
    }
    if (proof.observedMcpTools.join('|') !== request.requiredMcpTools.join('|')) {
      return { ok: false, field: 'proof.observedMcpTools' };
    }
    if (proof.requestCorrelationDigest !== request.requestCorrelationDigest) {
      return { ok: false, field: 'proof.requestCorrelationDigest' };
    }
  }
  return { ok: true, value: input.decodedResponse };
}
