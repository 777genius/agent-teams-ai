import { isHostTeamSelectionKey, parseHostTeamSelectionKey } from './teamSelection';

import type { NotificationTarget, TeamEventType } from '@shared/types/notifications';
import type { TeamMessageNotificationData } from '@shared/types/team';

const events: Record<TeamEventType, true> = {
  rate_limit: true,
  api_error: true,
  runtime_recovery: true,
  lead_inbox: true,
  user_inbox: true,
  task_clarification: true,
  task_status_change: true,
  task_comment: true,
  task_review_requested: true,
  task_blocked: true,
  task_created: true,
  all_tasks_completed: true,
  cross_team_message: true,
  schedule_completed: true,
  schedule_failed: true,
  team_launched: true,
  team_launch_incomplete: true,
  usage_budget_warning: true,
  usage_budget_exceeded: true,
};
const invalid = (): never => {
  throw new Error('Invalid captured Host notification');
};
function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 1024): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0'))
    return invalid();
  return value;
}
function choice<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  if (value === undefined) return undefined;
  if (!allowed.includes(value as T)) return invalid();
  return value as T;
}

/** Capture the original public handle before any await; names never select another owner. */
export function captureHostNotification(
  raw: unknown
): TeamMessageNotificationData & { teamName: string } {
  const row = object(raw, [
    'teamDisplayName',
    'teamName',
    'from',
    'to',
    'summary',
    'body',
    'color',
    'teamEventType',
    'target',
    'dedupeKey',
    'suppressToast',
  ]);
  const target =
    row.target === undefined
      ? undefined
      : object(row.target, [
          'kind',
          'teamName',
          'taskId',
          'commentId',
          'memberName',
          'focus',
          'section',
        ]);
  const selection = row.teamName ?? target?.teamName;
  if (
    !isHostTeamSelectionKey(selection) ||
    (row.teamName !== undefined && row.teamName !== selection) ||
    (target && target.teamName !== selection)
  )
    return invalid();
  parseHostTeamSelectionKey(selection);
  let destination: NotificationTarget = { kind: 'team', teamName: selection, section: 'overview' };
  if (target?.kind === 'task') {
    object(target, ['kind', 'teamName', 'taskId', 'commentId', 'focus']);
    destination = {
      kind: 'task',
      teamName: selection,
      taskId: text(target.taskId, 256),
      ...(target.commentId === undefined ? {} : { commentId: text(target.commentId, 256) }),
      ...(target.focus === undefined
        ? {}
        : { focus: choice(target.focus, ['detail', 'comments', 'status', 'review'])! }),
    };
  } else if (target?.kind === 'member') {
    object(target, ['kind', 'teamName', 'memberName', 'focus']);
    destination = {
      kind: 'member',
      teamName: selection,
      memberName: text(target.memberName, 256),
      ...(target.focus === undefined
        ? {}
        : { focus: choice(target.focus, ['profile', 'messages', 'logs'])! }),
    };
  } else if (target) {
    object(target, ['kind', 'teamName', 'section']);
    if (target.kind !== 'team') return invalid();
    destination = {
      kind: 'team',
      teamName: selection,
      ...(target.section === undefined
        ? {}
        : {
            section: choice(target.section, [
              'overview',
              'tasks',
              'members',
              'messages',
              'schedules',
            ])!,
          }),
    };
  }
  const result: TeamMessageNotificationData & { teamName: string } = {
    teamName: selection,
    teamDisplayName: text(row.teamDisplayName),
    from: text(row.from, 256),
    body: text(row.body, 64 * 1024),
    target: destination,
  };
  for (const key of ['to', 'summary', 'color', 'dedupeKey'] as const)
    if (row[key] !== undefined) result[key] = text(row[key], key === 'dedupeKey' ? 2048 : 1024);
  if (row.teamEventType !== undefined) {
    const event = text(row.teamEventType, 64);
    if (!Object.hasOwn(events, event)) return invalid();
    result.teamEventType = event as TeamEventType;
  }
  if (row.suppressToast !== undefined) {
    if (typeof row.suppressToast !== 'boolean') return invalid();
    result.suppressToast = row.suppressToast;
  }
  return result;
}
