import { TeamOwnerError } from './contracts.js';
import type { CommandReceipt } from './contracts.js';
import type { TaskBoardPolicy } from './ports.js';
import type { JsonValue } from '../contracts.js';

/** Canonical create decides blockers/status; the existing notifier completes its user-start effect. */
export function createTeamTask(
  receipt: CommandReceipt,
  actor: string,
  board: TaskBoardPolicy,
  teamName: string
): JsonValue {
  if (receipt.command.operation !== 'task.create') throw new TeamOwnerError('invalid');
  const payload = receipt.command.payload;
  let task = board.createTask({
    ...payload,
    ...(payload.startImmediately === true ? { notifyOwner: false } : {}),
    id: receipt.effects.taskId,
    from: actor,
    createdAt: receipt.createdAt,
    allowLegacyAdoption: false,
    creationCommand: {
      namespace: 'legacy-agent-host',
      scopeKey: teamName,
      operation: receipt.command.operation,
      commandId: receipt.effects.taskId,
      payloadHash: receipt.fingerprint,
    },
  });
  if (payload.startImmediately === true && task.status === 'in_progress' && task.owner) {
    task = board.startTaskNotifying({
      taskId: task.id,
      notification: 'user',
      created: true,
      ...(receipt.taskStartLeadName ? { leadName: receipt.taskStartLeadName } : {}),
      messageId: receipt.effects.messageId,
      timestamp: receipt.createdAt,
      recipients: receipt.taskRecipients!.map(({ name }) => name),
    }).task;
  }
  return JSON.parse(JSON.stringify(task)) as JsonValue;
}
