import { stripAgentBlocks } from '@shared/constants/agentBlocks';
import { formatTaskDisplayLabel } from '@shared/utils/taskIdentity';
import * as agentTeamsControllerModule from 'agent-teams-controller';

import type { TaskComment, TeamTask } from '@shared/types';

export function buildTaskCommentNotificationText(
  task: TeamTask,
  comment: TaskComment,
  isUserAnswer = false
): string {
  return agentTeamsControllerModule.buildTaskCommentForwardNotificationText(
    task,
    comment,
    isUserAnswer,
    formatTaskDisplayLabel(task)
  );
}

export function isAcknowledgementOnlyTaskComment(text: string): boolean {
  const normalized = stripAgentBlocks(text)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[«»"'`]/g, '')
    .replace(/[.!,;:…]+$/g, '')
    .trim();

  if (!normalized) return false;

  const exactMatches = new Set([
    'принято',
    'принял',
    'приняла',
    'ок',
    'ok',
    'okay',
    'на связи',
    'понял',
    'поняла',
    'roger',
    'ack',
  ]);

  if (exactMatches.has(normalized)) {
    return true;
  }

  const startsWithAckPrefix = Array.from(exactMatches).find((prefix) => {
    if (!normalized.startsWith(prefix)) {
      return false;
    }
    const remainder = normalized.slice(prefix.length);
    return remainder.length > 0 && /^[ ,.-]+/.test(remainder);
  });
  if (!startsWithAckPrefix) {
    return false;
  }

  const qualifier = normalized
    .slice(startsWithAckPrefix.length)
    .replace(/^[ ,.-]+/, '')
    .trim();
  if (!qualifier) {
    return true;
  }

  const matchesQualifierWithOptionalDetail = (phrase: string): boolean =>
    qualifier === phrase ||
    (qualifier.startsWith(`${phrase} `) && !/[.!?]/.test(qualifier.slice(phrase.length + 1)));

  return (
    qualifier === 'на связи' ||
    qualifier === 'остаюсь на связи' ||
    matchesQualifierWithOptionalDetail('жду') ||
    matchesQualifierWithOptionalDetail('ждём') ||
    matchesQualifierWithOptionalDetail('готов') ||
    matchesQualifierWithOptionalDetail('готова') ||
    matchesQualifierWithOptionalDetail('буду ждать')
  );
}
