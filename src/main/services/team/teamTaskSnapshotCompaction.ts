import type { TaskComment, TeamTask, TeamTaskWithKanban } from '@shared/types';

const SNAPSHOT_COMMENT_TEXT_MAX_CHARS = 120;
const SNAPSHOT_DESCRIPTION_MAX_CHARS = 2_000;
const SNAPSHOT_PROMPT_MAX_CHARS = 2_000;
const SNAPSHOT_HISTORY_NOTE_MAX_CHARS = 500;
const SNAPSHOT_SOURCE_MESSAGE_TEXT_MAX_CHARS = 1_000;

function compactText(value: string | undefined, maxChars: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  return value.length > maxChars ? value.slice(0, maxChars) : value;
}

function compactComment(comment: TaskComment): TaskComment {
  return {
    ...comment,
    text: compactText(comment.text, SNAPSHOT_COMMENT_TEXT_MAX_CHARS) ?? '',
  };
}

export function compactTeamTaskForSnapshot<T extends TeamTask | TeamTaskWithKanban>(task: T): T {
  const compacted: T = {
    ...task,
    description: compactText(task.description, SNAPSHOT_DESCRIPTION_MAX_CHARS),
    prompt: compactText(task.prompt, SNAPSHOT_PROMPT_MAX_CHARS),
    comments: Array.isArray(task.comments) ? task.comments.map(compactComment) : undefined,
    historyEvents: Array.isArray(task.historyEvents)
      ? task.historyEvents.map((event) =>
          'note' in event && typeof event.note === 'string'
            ? {
                ...event,
                note: compactText(event.note, SNAPSHOT_HISTORY_NOTE_MAX_CHARS),
              }
            : event
        )
      : undefined,
    sourceMessage: task.sourceMessage
      ? {
          ...task.sourceMessage,
          text: compactText(task.sourceMessage.text, SNAPSHOT_SOURCE_MESSAGE_TEXT_MAX_CHARS) ?? '',
        }
      : undefined,
  };

  return compacted;
}
