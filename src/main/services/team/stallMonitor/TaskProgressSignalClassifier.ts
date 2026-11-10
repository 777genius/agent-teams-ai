import { stripAgentBlocks } from '@shared/constants/agentBlocks';

import type { BoardTaskActivityRecord } from '../taskLogs/activity/BoardTaskActivityRecord';
import type { TaskComment, TeamTask } from '@shared/types';

export type TaskProgressSignal =
  | 'strong_progress'
  | 'weak_start_only'
  | 'blocker_or_clarification'
  | 'terminal_progress'
  | 'unknown';

export interface TaskProgressTouchClassification {
  signal: TaskProgressSignal;
  reason: string;
}

const FILE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.cts',
  '.mts',
  '.ctsx',
  '.mtsx',
  '.json',
  '.md',
  '.css',
  '.scss',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.swift',
  '.yaml',
  '.yml',
  '.toml',
  '.lock',
  '.sh',
  '.sql',
] as const;

const TEST_OR_BUILD_KEYWORDS = [
  'test',
  'tests',
  'tested',
  'testing',
  'vitest',
  'jest',
  'playwright',
  'pnpm',
  'npm',
  'bun',
  'build',
  'typecheck',
  'lint',
  'passed',
  'failed',
  'green',
  'red',
  'error',
  'exception',
  'stack trace',
  'тест',
  'сборк',
  'линт',
  'ошибк',
  'упал',
  'прошел',
  'прошёл',
] as const;

const SUBSTANTIVE_WORK_KEYWORDS = [
  'implemented',
  'fixed',
  'added',
  'updated',
  'changed',
  'removed',
  'found',
  'verified',
  'confirmed',
  'completed',
  'created',
  'refactored',
  'patched',
  'root cause',
  'next step',
  'исправ',
  'добав',
  'обнов',
  'измен',
  'удал',
  'нашел',
  'нашёл',
  'подтверд',
  'готово',
  'сделал',
  'сделана',
  'причин',
  'следующ',
] as const;

const BLOCKER_OR_CLARIFICATION_KEYWORDS = [
  'blocked',
  'blocker',
  'cannot',
  "can't",
  'need',
  'needs',
  'waiting',
  'clarification',
  'question',
  'permission',
  'access denied',
  'not enough context',
  'не могу',
  'не получается',
  'нужн',
  'жду',
  'блок',
  'уточн',
  'вопрос',
  'нет доступа',
  'недостаточно контекст',
] as const;

const WEAK_START_ONLY_PHRASES = [
  'начинаю',
  'начинаю работу',
  'начну',
  'приступаю',
  'приступаю к работе',
  'беру в работу',
  'проверю',
  'сейчас проверю',
  'посмотрю',
  'разберусь',
  'готов приступить',
  'готова приступить',
  'готов к работе',
  'готова к работе',
  'will start',
  'starting work',
  'starting',
  'taking this',
  "i'll start",
  'i’ll start',
  'i will start',
  'i am starting',
  "i'll check",
  'i’ll check',
  'i will check',
  'checking now',
  'on it',
] as const;

function normalizeCommentText(text: string): string {
  return stripAgentBlocks(text).replace(/\s+/g, ' ').trim();
}

function includesAnyKeyword(text: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword));
}

function containsTaskOrIssueRef(text: string): boolean {
  return text.includes('task-') || /#[a-f0-9]{6,}/i.test(text);
}

function containsConcreteFileOrPath(text: string): boolean {
  const parts = text.split(/\s+/);
  return (
    parts.some(
      (part) => part.startsWith('./') || part.startsWith('../') || part.startsWith('~/')
    ) ||
    parts.some((part) => part.includes('/') && /[a-z0-9_]/i.test(part)) ||
    FILE_EXTENSIONS.some((extension) => text.includes(extension))
  );
}

function isWeakStartOnly(text: string): boolean {
  const normalized = text
    .replace(/[.!…\s]+$/g, '')
    .replace(/^я\s+/, '')
    .trim();
  return WEAK_START_ONLY_PHRASES.includes(normalized as (typeof WEAK_START_ONLY_PHRASES)[number]);
}

function isConcreteProgress(text: string): boolean {
  return (
    containsConcreteFileOrPath(text) ||
    containsTaskOrIssueRef(text) ||
    includesAnyKeyword(text, TEST_OR_BUILD_KEYWORDS) ||
    includesAnyKeyword(text, SUBSTANTIVE_WORK_KEYWORDS)
  );
}

function classifyTaskCommentText(text: string): TaskProgressTouchClassification {
  const normalized = normalizeCommentText(text);
  if (!normalized) {
    return { signal: 'unknown', reason: 'comment_text_empty' };
  }

  const lowerText = normalized.toLowerCase();

  if (lowerText.includes('?') || includesAnyKeyword(lowerText, BLOCKER_OR_CLARIFICATION_KEYWORDS)) {
    return {
      signal: 'blocker_or_clarification',
      reason: 'comment_mentions_blocker_or_clarification',
    };
  }

  if (isConcreteProgress(lowerText)) {
    return { signal: 'strong_progress', reason: 'comment_contains_concrete_progress' };
  }

  if (lowerText.length <= 120 && isWeakStartOnly(lowerText)) {
    return { signal: 'weak_start_only', reason: 'comment_is_start_only' };
  }

  return { signal: 'unknown', reason: 'comment_progress_signal_unclear' };
}

export function getTaskCommentForActivityRecord(
  task: TeamTask,
  record: BoardTaskActivityRecord
): TaskComment | null {
  const commentId = record.action?.details?.commentId?.trim();
  if (!commentId) {
    return null;
  }
  return task.comments?.find((comment) => comment.id === commentId) ?? null;
}

export function classifyTaskProgressTouch(args: {
  task: TeamTask;
  record: BoardTaskActivityRecord;
}): TaskProgressTouchClassification {
  const toolName = args.record.action?.canonicalToolName;
  if (toolName === 'task_start' || toolName === 'task_set_status') {
    return { signal: 'strong_progress', reason: `${toolName}_is_authoritative_touch` };
  }
  if (toolName === 'task_complete') {
    return { signal: 'terminal_progress', reason: 'task_complete_is_terminal' };
  }
  if (toolName === 'task_set_clarification') {
    return {
      signal: 'blocker_or_clarification',
      reason: 'task_set_clarification_is_blocker_signal',
    };
  }
  if (toolName !== 'task_add_comment') {
    return { signal: 'unknown', reason: 'tool_is_not_classified_for_task_progress' };
  }

  const comment = getTaskCommentForActivityRecord(args.task, args.record);
  if (!comment) {
    return { signal: 'unknown', reason: 'task_comment_text_unavailable' };
  }

  return classifyTaskCommentText(comment.text);
}
