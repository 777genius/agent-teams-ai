import { digest } from './identity.js';
import type { CommandReceipt } from './contracts.js';

/** Canonical original command identity, including its retained delivery and audience selection. */
export function teamCommandFingerprint(input: Pick<CommandReceipt, 'binding' | 'principalId' | 'command'> & {
  [Key in 'deliveryBinding' | 'taskRecipients' | 'messageRecipientRole' | 'taskStartLeadName' | 'crossTeam' | 'group']?: CommandReceipt[Key] | undefined;
}): string {
  return digest({
    binding: input.binding,
    principalId: input.principalId,
    command: input.command,
    deliveryBinding: input.deliveryBinding,
    taskRecipients: input.taskRecipients,
    messageRecipientRole: input.messageRecipientRole,
    taskStartLeadName: input.taskStartLeadName,
    ...(input.crossTeam ? { crossTeam: input.crossTeam } : {}),
    ...(input.group ? { group: input.group } : {}),
  });
}
