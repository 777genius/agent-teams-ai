import { TeamOwnerError } from './contracts.js';
import { isTeamTaskActivelyWorked } from '../task-workflow/taskState.js';
import type { ExpectedTaskRecipient, TeamCommand, TeamMember } from './contracts.js';
import type { TaskBoardPolicy } from './ports.js';

export function validateExpectedTaskRecipient(value: unknown): asserts value is ExpectedTaskRecipient {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TeamOwnerError('invalid');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !['name', 'memberId', 'runId', 'generation', 'requireIdle'].includes(key)) ||
    ['name', 'memberId', 'runId', 'generation'].some(key => typeof row[key] !== 'string' ||
      !row[key] || row[key].length > 256 || row[key].includes('\0')) ||
    (row.requireIdle !== undefined && row.requireIdle !== true)) throw new TeamOwnerError('invalid');
}

/** New admission only. Completed/uncertain original commands keep their existing receipt recovery. */
export function assertExpectedTaskRecipient(
  command: TeamCommand,
  members: readonly TeamMember[],
  board: () => TaskBoardPolicy
): void {
  if (command.operation !== 'task.create' && command.operation !== 'task.start') return;
  const expected = command.payload.expectedRecipient;
  if (!expected) return;
  const member = members.find(row => row.name === expected.name);
  if (member?.memberId !== expected.memberId || member.delivery?.memberId !== expected.memberId ||
    member.delivery.runId !== expected.runId || member.delivery.generation !== expected.generation)
    throw new TeamOwnerError('hold');
  const taskId = command.operation === 'task.start' ? command.payload.taskId : undefined;
  const currentBoard = board();
  const owner = command.operation === 'task.create' ? command.payload.owner : currentBoard.getTask(command.payload.taskId).owner;
  if (owner !== expected.name) throw new TeamOwnerError('hold');
  if (expected.requireIdle && currentBoard.listTasks().some(task =>
    task.id !== taskId && task.owner === expected.name && isTeamTaskActivelyWorked(task)))
    throw new TeamOwnerError('hold');
}
