import { createHmac, timingSafeEqual } from 'node:crypto';

import type { OrchestratorLifecycleOwnerProofKey } from '@main/composition/hosted/hostedLifecycleOrchestratorReadiness';

export const HOSTED_APPROVAL_ACTIVATION_PROOF_DOMAIN =
  'agent-teams.hosted-approval-activation-proof/v2' as const;

const HEX_32 = /^[0-9a-f]{64}$/u;

export function createHostedApprovalActivationProof(
  key: OrchestratorLifecycleOwnerProofKey | Uint8Array,
  direction: string,
  serializedUnsignedEnvelope: string
): string {
  return createHmac('sha256', keyBytes(key))
    .update(
      `${HOSTED_APPROVAL_ACTIVATION_PROOF_DOMAIN}\u0000${direction}\u0000${serializedUnsignedEnvelope}`
    )
    .digest('hex');
}

export function requireHostedApprovalActivationProof(
  key: OrchestratorLifecycleOwnerProofKey | Uint8Array,
  direction: string,
  unsigned: string,
  supplied: string
): void {
  const expected = createHostedApprovalActivationProof(key, direction, unsigned);
  const suppliedBytes = HEX_32.test(supplied) ? Buffer.from(supplied, 'hex') : Buffer.alloc(0);
  const expectedBytes = Buffer.from(expected, 'hex');
  if (
    suppliedBytes.byteLength !== expectedBytes.byteLength ||
    !timingSafeEqual(suppliedBytes, expectedBytes)
  ) {
    throw new TypeError('hosted-approval-activation-proof-invalid');
  }
}

export function parseHostedApprovalActivationProofLastFrame(
  source: string,
  expectedKeys: readonly string[]
): Readonly<{
  value: Record<string, unknown>;
  proof: string;
  serializedUnsignedEnvelope: string;
}> {
  if (source.length < 2 || source.includes('\n') || source.includes('\r')) throw new TypeError();
  const value = JSON.parse(source) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError();
  const record = value as Record<string, unknown>;
  if (!exactOrderedKeys(record, expectedKeys) || JSON.stringify(record) !== source) {
    throw new TypeError('hosted-approval-activation-frame-noncanonical');
  }
  const proof = record.controllerProof;
  if (typeof proof !== 'string' || !HEX_32.test(proof)) throw new TypeError();
  const suffix = `,"controllerProof":"${proof}"}`;
  if (!source.endsWith(suffix)) throw new TypeError('hosted-approval-activation-proof-not-last');
  return Object.freeze({
    value: record,
    proof,
    serializedUnsignedEnvelope: `${source.slice(0, -suffix.length)}}`,
  });
}

export function appendHostedApprovalActivationProofLast(unsigned: string, proof: string): string {
  return `${unsigned.slice(0, -1)},"controllerProof":"${proof}"}`;
}

function keyBytes(key: OrchestratorLifecycleOwnerProofKey | Uint8Array): Uint8Array {
  if (typeof key === 'string') {
    if (!HEX_32.test(key)) throw new TypeError('hosted-approval-activation-proof-key-invalid');
    return Buffer.from(key, 'hex');
  }
  if (key.byteLength !== 32) throw new TypeError('hosted-approval-activation-proof-key-invalid');
  return key;
}

function exactOrderedKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
