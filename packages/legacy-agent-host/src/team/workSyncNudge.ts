import { memberBinding } from './DeliveryRecovery.js';
import { TeamOwnerError } from './contracts.js';
import { digest } from './identity.js';

import type { NativeMcpAuthorityProof } from './NativeMcpAuthority.js';
import type { CommandReceipt, DeliveryBinding, TeamCommand, TeamGrant } from './contracts.js';

/** Private composition callback; no function or semantic marker is accepted by a command schema. */
export type PrepareWorkSyncNudge = () => Readonly<NativeMcpAuthorityProof>;

function isNudgeCommand(command: TeamCommand): boolean {
  return (
    command.operation === 'message.send' &&
    /^work-sync-delivery:[a-f0-9]{64}$/u.test(command.commandId) &&
    command.payload.messageId === command.commandId &&
    command.payload.to !== 'user' &&
    command.payload.actionMode === 'do' &&
    command.payload.nativeCommand === undefined &&
    !command.payload.attachments?.length
  );
}

/** The captured native input must still own this exact self-recipient and original Runtime binding. */
export function captureWorkSyncNudge(
  prepare: PrepareWorkSyncNudge,
  command: TeamCommand,
  grant: TeamGrant,
  delivery: DeliveryBinding | undefined
): true {
  const proof = prepare();
  if (
    !isNudgeCommand(command) ||
    command.operation !== 'message.send' ||
    !delivery ||
    grant.memberName === 'user' ||
    command.payload.to !== grant.memberName ||
    proof.principalId !== grant.principalId ||
    proof.memberName !== grant.memberName ||
    proof.authorityRevision !== (grant.revision ?? 1) ||
    proof.mode !== 'do' ||
    proof.actorId !== delivery.memberId ||
    digest(memberBinding(proof.source)) !== digest(memberBinding(delivery))
  )
    throw new TeamOwnerError('forbidden');
  return true;
}

/** Optional original receipt metadata: old receipts remain byte-for-byte valid and unclassified. */
export function validateWorkSyncNudge(receipt: CommandReceipt): void {
  if (receipt.workSyncNudge === undefined) return;
  if (
    receipt.workSyncNudge !== true ||
    !isNudgeCommand(receipt.command) ||
    receipt.crossTeam ||
    receipt.group ||
    receipt.hostCommand ||
    !receipt.deliveryBinding ||
    receipt.deliveryBinding.backendId !== receipt.binding.backendId ||
    receipt.deliveryBinding.teamId !== receipt.binding.teamId ||
    receipt.deliveryBinding.teamName !== receipt.binding.teamName ||
    !Number.isSafeInteger(receipt.authorityRevision) ||
    receipt.authorityRevision! < 1
  )
    throw new TeamOwnerError('hold');
}
