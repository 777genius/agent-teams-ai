import { createRequire } from 'node:module';

import { createTeamController, createTeamPolicy } from './ControllerAdapter.js';
import { TeamOwnerError } from '../../team/contracts.js';
import type { CommandReceipt } from '../../team/contracts.js';
import type { JsonValue } from '../../contracts.js';

const require = createRequire(import.meta.url);
const helpers = require('agent-teams-controller/src/internal/runtimeHelpers.js') as {
  inferLeadName(paths: unknown): string;
  resolveLeadSessionId(paths: unknown): string | undefined;
};
const notice = require('agent-teams-controller/src/internal/taskCommentNotification.js') as {
  buildTaskCommentForwardNotificationText(task: unknown, comment: unknown, answer: boolean): string;
};
const refs = require('agent-teams-controller/src/internal/taskReferences.js') as {
  buildTaskRef(context: { teamName: string }, task: unknown): unknown;
  mergeTaskRefs(primary: unknown, extra: unknown): unknown;
};

/** Runs only in the original private task-plan snapshot. The resulting inbox
 * bytes join that same durable plan and cannot become a second live writer. */
export function prepareTaskClarificationAnswerNotification(
  root: string, teamName: string, receipt: CommandReceipt, actor: string, result: JsonValue,
  reviewFlowDefaultsDirectory: string
): void {
  const command = receipt.command;
  if (command.operation !== 'task.comment' || command.payload.answerClarificationRequestId === undefined) return;
  if (actor !== 'user' || !result || typeof result !== 'object' || Array.isArray(result))
    throw new TeamOwnerError('hold');
  const { task, comment } = result;
  if (!task || typeof task !== 'object' || Array.isArray(task) ||
      !comment || typeof comment !== 'object' || Array.isArray(comment) ||
      task.id !== command.payload.taskId || comment.author !== 'user' ||
      comment.id !== `clarification-answer-${command.payload.answerClarificationRequestId}`)
    throw new TeamOwnerError('hold');
  const controller = createTeamController(root, teamName, true, reviewFlowDefaultsDirectory);
  const lead = helpers.inferLeadName(controller.context.paths);
  const owner = typeof task.owner === 'string' ? task.owner.trim() : '';
  const member = !owner || owner.toLowerCase() === 'team-lead' || owner.toLowerCase() === lead.toLowerCase() ? lead : owner;
  if (!member) throw new TeamOwnerError('hold');
  const leadSessionId = member === lead ? helpers.resolveLeadSessionId(controller.context.paths) : undefined;
  createTeamPolicy(root, teamName, reviewFlowDefaultsDirectory).sendMessage('user', {
    member, from: 'user', source: 'system_notification', messageKind: 'task_comment_notification',
    messageId: `task-comment-forward:${teamName}:${task.id}:${comment.id}`,
    commentId: comment.id, timestamp: receipt.createdAt,
    text: notice.buildTaskCommentForwardNotificationText(task, comment, true),
    summary: `Answer on #${task.displayId || task.id}`,
    taskRefs: refs.mergeTaskRefs(refs.buildTaskRef({ teamName }, task), comment.taskRefs),
    ...(leadSessionId ? { leadSessionId } : {}),
  });
}
