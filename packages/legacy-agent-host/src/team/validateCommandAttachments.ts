import { TeamOwnerError } from './contracts.js';
import type { TeamCommand } from './contracts.js';
import type { TeamAttachmentPort } from './ports.js';

/** Run under the original command's Team fence before any receipt or product publication. */
export function validateCommandAttachments(
  command: TeamCommand,
  attachments: TeamAttachmentPort | undefined
): void {
  if (command.operation === 'task.attachment.add') {
    if (!attachments) throw new TeamOwnerError('invalid');
    attachments.metadata([command.payload.attachment], {
      kind: 'task',
      taskId: command.payload.taskId,
    });
    return;
  }
  if (
    (command.operation !== 'task.comment' && command.operation !== 'message.send') ||
    !command.payload.attachments?.length
  )
    return;
  if (!attachments) throw new TeamOwnerError('invalid');
  attachments.metadata(
    command.payload.attachments,
    command.operation === 'task.comment'
      ? { kind: 'task', taskId: command.payload.taskId }
      : { kind: 'message', member: command.payload.to }
  );
}
