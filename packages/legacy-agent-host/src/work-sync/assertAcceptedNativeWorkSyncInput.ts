import { TeamOwnerError } from '../team/contracts.js';
import { deliveryFingerprint, normalizeBinding, runtimeDigest } from '../runtime/identity.js';

import type { RuntimeDelivery, RuntimeSessionRecord } from '../runtime/contracts.js';
import type { NativeMcpAuthorityProof } from '../team/NativeMcpAuthority.js';
import type { WorkSyncCommandReceipt } from './commandContracts.js';

/** Accepted feature intent may outlive its input; it never borrows authority from whichever input runs next. */
export function assertAcceptedNativeWorkSyncInput(options: {
  original: Readonly<WorkSyncCommandReceipt>;
  readRuntime(): { record: RuntimeSessionRecord | undefined; attached: boolean };
  captureTeam(original: RuntimeDelivery): Readonly<NativeMcpAuthorityProof>;
  assertCurrent(): void;
}): void {
  options.assertCurrent();
  const receipt = options.original;
  const proof = receipt.nativeInput;
  const header = proof.runtime;
  if (receipt.phase !== 'completed' || !header) throw new TeamOwnerError('hold');
  const { record, attached } = options.readRuntime();
  if (
    !attached ||
    !record ||
    record.schemaVersion !== 1 ||
    record.phase !== 'allocated' ||
    record.sealed ||
    record.custody !== 'owned' ||
    !record.nativeReady ||
    record.control ||
    record.profileId !== header.profileId ||
    record.hostIncarnation !== header.hostIncarnation ||
    runtimeDigest(record.config) !== header.configHash ||
    record.openFingerprint !== header.openFingerprint ||
    record.sessionRef !== proof.original.sessionRef ||
    runtimeDigest(normalizeBinding(record.binding)) !==
      runtimeDigest(normalizeBinding(proof.team.source))
  )
    throw new TeamOwnerError('hold');
  const originals = record.inputs.filter(
    (input) => input.intent.inputId === proof.original.inputId
  );
  if (originals.length !== 1) throw new TeamOwnerError('hold');
  const input = originals[0]!;
  if (
    !['claimed', 'consumed', 'terminal'].includes(input.phase) ||
    input.operationRef !== proof.original.operationRef ||
    input.fingerprint !== proof.original.fingerprint ||
    input.fingerprint !== deliveryFingerprint(input.intent) ||
    runtimeDigest(normalizeBinding(input.intent.binding)) !==
      runtimeDigest(normalizeBinding(proof.team.source)) ||
    input.intent.deliveryId !== proof.team.original.deliveryId ||
    input.intent.messageId !== proof.team.original.messageId
  )
    throw new TeamOwnerError('hold');
  const current = options.captureTeam(structuredClone(input.intent));
  if (runtimeDigest(current) !== runtimeDigest(proof.team)) throw new TeamOwnerError('forbidden');
  options.assertCurrent();
}
