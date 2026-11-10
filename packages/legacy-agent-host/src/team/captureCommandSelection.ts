import { TeamOwnerError } from './contracts.js';
import { isUserTaskStartIntent } from './taskStartIntent.js';
import type { TeamMember, TeamCommand, CommandReceipt, TeamGrant } from './contracts.js';
/** Current role/binding and original task audience jointly determine receipt identity. */
export function captureCommandSelection(
  command: TeamCommand,
  receipt: CommandReceipt | undefined,
  members: TeamMember[],
  grant: TeamGrant
) {
  const messageRecipient =
    command.operation === 'message.send'
      ? members.find((member) => member.name === command.payload.to)
      : undefined;
  if (
    command.operation === 'message.send' &&
    grant.memberName === 'user' &&
    command.payload.actionMode === 'delegate' &&
    messageRecipient?.role !== 'lead'
  )
    throw new TeamOwnerError('forbidden');
  const messageRecipientRole = receipt
    ? receipt.messageRecipientRole
    : command.operation === 'message.send' &&
        (command.payload.messageId !== undefined ||
          command.payload.summary !== undefined ||
          command.payload.actionMode !== undefined)
      ? messageRecipient?.role
      : undefined;
  const deliveryBinding =
    receipt?.deliveryBinding ??
    (command.operation === 'message.send'
      ? members.find((member) => member.name === command.payload.to)?.delivery
      : undefined);
  const taskRecipients = receipt
    ? receipt.taskRecipients
    : command.operation !== 'message.send'
      ? members.map(({ name, delivery }) => ({
          name,
          ...(delivery ? { delivery: structuredClone(delivery) } : {}),
        }))
      : undefined;
  if (taskRecipients && taskRecipients.length > 256) throw new TeamOwnerError('hold');
  const currentLead = members.find((member) => member.role === 'lead')?.name;
  const taskStartLeadName = receipt
    ? receipt.taskStartLeadName
    : isUserTaskStartIntent(command)
      ? currentLead
      : undefined;
  if (isUserTaskStartIntent(command) && taskStartLeadName !== currentLead)
    throw new TeamOwnerError('hold');
  return {
    messageRecipient,
    messageRecipientRole,
    deliveryBinding,
    taskRecipients,
    taskStartLeadName,
  };
}
