import { createHash, createPublicKey, verify } from 'node:crypto';

import type { HostedLifecycleProductionOwnerAdmission } from './hostedLifecycleProductionOwnerAdmission';
import type { NativeActivationHandleSelection } from './hostedNativeActivationHandleContract';

export const APPROVAL_GENERATION_TRANSITION = 'agent-teams.hosted-approval-generation-transition/v1';
export interface ApprovalGenerationTransition {
  readonly contract: typeof APPROVAL_GENERATION_TRANSITION;
  readonly predecessorManifestDigest: string;
  readonly predecessorProcessStartToken: string;
  readonly successorGeneration: number;
  readonly successorSessionId: string;
  readonly successorBootstrapDigest: string;
  readonly admissionDocument: string;
  readonly signature: string;
}

export function decodeApprovalGenerationTransition(value: unknown): ApprovalGenerationTransition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('approval_transition_message');
  const row = value as Record<string, unknown>;
  const keys = ['contract', 'predecessorManifestDigest', 'predecessorProcessStartToken',
    'successorGeneration', 'successorSessionId', 'successorBootstrapDigest', 'admissionDocument', 'signature'];
  if (Reflect.ownKeys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key)) ||
    !Number.isSafeInteger(row.successorGeneration) || (row.successorGeneration as number) < 2 ||
    typeof row.successorSessionId !== 'string' || !/^owner-session_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u.test(row.successorSessionId) ||
    typeof row.successorBootstrapDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(row.successorBootstrapDigest) ||
    typeof row.admissionDocument !== 'string' || typeof row.signature !== 'string' ||
    typeof row.predecessorManifestDigest !== 'string' || typeof row.predecessorProcessStartToken !== 'string' ||
    row.contract !== APPROVAL_GENERATION_TRANSITION || Buffer.byteLength(JSON.stringify(row)) > 300_000 ||
    !/^sha256:[0-9a-f]{64}$/u.test(row.predecessorManifestDigest) ||
    !/^[0-9a-f]{64}$/u.test(row.predecessorProcessStartToken) ||
    !/^[A-Za-z0-9_-]{86}$/u.test(row.signature)) throw new Error('approval_transition_message');
  return Object.freeze({ contract: APPROVAL_GENERATION_TRANSITION,
    predecessorManifestDigest: row.predecessorManifestDigest,
    predecessorProcessStartToken: row.predecessorProcessStartToken,
    successorGeneration: row.successorGeneration as number, successorSessionId: row.successorSessionId,
    successorBootstrapDigest: row.successorBootstrapDigest, admissionDocument: row.admissionDocument,
    signature: row.signature });
}

/** Exact domain-separated bytes to be signed by the independently pinned
 * launcher. Neither the Owner HMAC nor a supervisor IPC ACK substitutes for it. */
export function approvalGenerationTransitionSigningBytes(ticket: ApprovalGenerationTransition): Buffer {
  return Buffer.from(`${APPROVAL_GENERATION_TRANSITION}\0${JSON.stringify({
    contract: ticket.contract, predecessorManifestDigest: ticket.predecessorManifestDigest,
    predecessorProcessStartToken: ticket.predecessorProcessStartToken,
    successorGeneration: ticket.successorGeneration, successorSessionId: ticket.successorSessionId,
    successorBootstrapDigest: ticket.successorBootstrapDigest, admissionDocument: ticket.admissionDocument,
  })}`);
}

export function authenticateApprovalGenerationTransition(value: unknown,
  predecessor: HostedLifecycleProductionOwnerAdmission, selection: NativeActivationHandleSelection,
  serializedBootstrap: string) {
  const ticket = decodeApprovalGenerationTransition(value);
  const signature = Buffer.from(ticket.signature, 'base64url');
  if (ticket.predecessorManifestDigest !== predecessor.manifestDigest ||
    ticket.predecessorProcessStartToken !== selection.ownerProcessStartToken ||
    signature.toString('base64url') !== ticket.signature ||
    !verify(null, approvalGenerationTransitionSigningBytes(ticket), createPublicKey({ format: 'jwk',
      key: { kty: 'OKP', crv: 'Ed25519', x: predecessor.launcherPublicKey } }), signature)) {
    throw new Error('approval_transition_authentication');
  }
  if (ticket.successorGeneration !== predecessor.expectedOwnerBinding.ownerGeneration + 1 ||
    ticket.successorSessionId === predecessor.expectedOwnerBinding.ownerSessionId ||
    ticket.successorBootstrapDigest !== predecessor.bootstrapBinding.bootstrapDigest ||
    createHash('sha256').update(serializedBootstrap).digest('hex') !== ticket.successorBootstrapDigest) {
    throw new Error('approval_transition_successor_binding');
  }
  return Object.freeze({ ticket,
    admissionDocumentDigest: `sha256:${createHash('sha256').update(ticket.admissionDocument).digest('hex')}` as const,
    transitionSha256: createHash('sha256').update(approvalGenerationTransitionSigningBytes(ticket)).digest('hex'),
  });
}
