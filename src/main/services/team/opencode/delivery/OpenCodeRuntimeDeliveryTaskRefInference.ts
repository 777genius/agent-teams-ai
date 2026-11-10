import { getTaskDisplayId } from '@shared/utils/taskIdentity';

import type { InboxMessage, TaskRef, TeamTask } from '@shared/types';

function normalizeTaskRefs(taskRefs: readonly TaskRef[] | undefined): TaskRef[] {
  if (!Array.isArray(taskRefs) || taskRefs.length === 0) {
    return [];
  }
  const normalized: TaskRef[] = [];
  for (const rawTaskRef of taskRefs as readonly unknown[]) {
    if (!rawTaskRef || typeof rawTaskRef !== 'object') {
      continue;
    }
    const taskRef = rawTaskRef as Record<string, unknown>;
    const teamName = typeof taskRef.teamName === 'string' ? taskRef.teamName.trim() : '';
    const taskId = typeof taskRef.taskId === 'string' ? taskRef.taskId.trim() : '';
    const displayId = typeof taskRef.displayId === 'string' ? taskRef.displayId.trim() : '';
    if (teamName && taskId && displayId) {
      normalized.push({ teamName, taskId, displayId });
    }
  }
  return normalized;
}

function extractTaskReferenceTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const match of text.matchAll(/#([A-Za-z0-9][A-Za-z0-9_-]*)/g)) {
    const token = match[1]?.trim().toLowerCase();
    if (token) {
      tokens.add(token);
    }
  }
  for (const match of text.matchAll(
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
  )) {
    const token = match[0]?.trim().toLowerCase();
    if (token) {
      tokens.add(token);
    }
  }
  return tokens;
}

function taskRefForTask(teamName: string, task: Pick<TeamTask, 'id' | 'displayId'>): TaskRef {
  return {
    teamName,
    taskId: task.id.trim(),
    displayId: getTaskDisplayId(task),
  };
}

function findUniqueTaskRefInText(input: {
  teamName: string;
  text: string;
  tasks: readonly Pick<TeamTask, 'id' | 'displayId'>[];
}): TaskRef[] {
  const tokens = extractTaskReferenceTokens(input.text);
  if (tokens.size === 0) {
    return [];
  }

  const matches = new Map<string, TaskRef>();
  for (const task of input.tasks) {
    const taskId = task.id?.trim();
    if (!taskId) {
      continue;
    }
    const displayId = getTaskDisplayId(task);
    if (tokens.has(taskId.toLowerCase()) || tokens.has(displayId.toLowerCase())) {
      matches.set(taskId, taskRefForTask(input.teamName, task));
    }
  }

  return matches.size === 1 ? Array.from(matches.values()) : [];
}

function getCommentHeadingText(text: string): string {
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) {
    return '';
  }
  return /^\**Comment on(?: task)? #/i.test(firstLine) ? firstLine : '';
}

export function inferOpenCodeTaskRefsFromInboxMessage(input: {
  teamName: string;
  message: Pick<InboxMessage, 'commentId' | 'messageId' | 'summary' | 'taskRefs' | 'text'>;
  tasks: readonly Pick<TeamTask, 'id' | 'displayId'>[];
}): TaskRef[] {
  const structured = normalizeTaskRefs(input.message.taskRefs);
  if (structured.length > 0 || input.tasks.length === 0) {
    return structured;
  }

  const summary = input.message.summary?.trim() ?? '';
  const heading = getCommentHeadingText(input.message.text ?? '');
  const messageId = input.message.messageId?.trim() ?? '';
  const commentId = input.message.commentId?.trim() ?? '';
  const text = input.message.text?.trim() ?? '';

  for (const candidate of [summary, heading, messageId, commentId, text]) {
    if (!candidate) {
      continue;
    }
    const inferred = findUniqueTaskRefInText({
      teamName: input.teamName,
      text: candidate,
      tasks: input.tasks,
    });
    if (inferred.length > 0) {
      return inferred;
    }
  }

  return [];
}
