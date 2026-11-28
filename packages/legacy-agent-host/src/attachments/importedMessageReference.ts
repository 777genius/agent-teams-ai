import { TeamOwnerError } from '../team/contracts.js';
import { digest, safeSegment } from '../team/identity.js';

/** Exact canonical namespace plus explicit Task, under the caller's owner-qualified Team fence. */
export function importedMessageReference(
  teamName: string,
  taskId: string,
  messageId: string
): string {
  safeSegment(teamName);
  safeSegment(taskId);
  if (!messageId || messageId.length > 512 || messageId.includes('\0'))
    throw new TeamOwnerError('hold');
  return `im1:${taskId}:${digest([teamName, taskId, messageId])}`;
}
export function importedMessageTaskId(reference: string): string {
  const match = /^im1:([A-Za-z0-9][A-Za-z0-9_-]{0,127}):[a-f0-9]{64}$/.exec(reference);
  if (!match) throw new TeamOwnerError('invalid');
  return match[1]!;
}
