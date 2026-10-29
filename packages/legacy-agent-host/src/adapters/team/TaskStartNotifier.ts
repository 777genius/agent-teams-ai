import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { JsonValue } from '../../contracts.js';
import type { TaskBoardPolicy } from '../../team/ports.js';

const require = createRequire(import.meta.url);
const { protocols } = require('agent-teams-controller') as {
  protocols: {
    buildTaskStartNotification(
      team: string,
      task: unknown,
      label: string,
      notification: 'legacy' | 'user',
      leadName?: string,
      toolProtocol?: 'legacy' | 'captured-team'
    ): { member: string; from: string; text: string; summary: string; taskRefs?: JsonValue };
  };
};

/** Runs only in the detached canonical Task plan; failures publish no partial live decision. */
export function startTaskNotifying(options: {
  board: Omit<TaskBoardPolicy, 'startTaskNotifying'>;
  send(flags: Record<string, unknown>): { messageId: string; message: JsonValue };
  root: string;
  teamName: string;
  input: Parameters<TaskBoardPolicy['startTaskNotifying']>[0];
}): ReturnType<TaskBoardPolicy['startTaskNotifying']> {
  const { board, input, teamName } = options;
  const before = board.getTask(input.taskId);
  if (before.status !== (input.created ? 'in_progress' : 'pending'))
    throw new Error('Task is not ready for this start notification');
  const owner = before.owner;
  if (owner !== undefined && (typeof owner !== 'string' || !input.recipients.includes(owner)))
    throw new Error('Task owner unavailable');
  const isLead =
    typeof owner === 'string' &&
    (owner.trim().toLowerCase() === input.leadName?.trim().toLowerCase() ||
      owner.trim().toLowerCase() === 'team-lead');
  const notify = !!owner && !(input.notification === 'legacy' && isLead);
  if (notify && input.notification === 'legacy' && !input.leadName)
    throw new Error('Task lead unavailable');
  if (notify) {
    let inbox: unknown;
    try {
      inbox = JSON.parse(
        readFileSync(join(options.root, 'teams', teamName, 'inboxes', `${owner}.json`), 'utf8')
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      inbox = [];
    }
    if (
      !Array.isArray(inbox) ||
      inbox.some(
        (row: unknown) =>
          !!row &&
          typeof row === 'object' &&
          'messageId' in row &&
          row.messageId === input.messageId
      )
    )
      throw new Error('Task notification identity conflict');
  }
  const task = input.created ? before : board.startTask(input.taskId, 'user');
  if (!notify) return { task, notifiedOwner: false };
  const label = `#${before.displayId || before.id}`;
  const notification = protocols.buildTaskStartNotification(
    teamName,
    before,
    label,
    input.notification,
    input.leadName,
    'captured-team'
  );
  const sent = options.send({
    ...notification,
    messageId: input.messageId,
    timestamp: input.timestamp,
  });
  if (
    sent.messageId !== input.messageId ||
    !sent.message ||
    typeof sent.message !== 'object' ||
    Array.isArray(sent.message) ||
    sent.message.messageId !== input.messageId ||
    sent.message.text !== notification.text ||
    sent.message.from !== notification.from ||
    sent.message.to !== owner ||
    sent.message.source !== 'system_notification'
  )
    throw new Error('Task notification not published');
  return { task, notifiedOwner: true };
}
