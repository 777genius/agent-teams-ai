import type {
  BackendTeamActivityLogs,
  BackendTeamActivityStats,
} from '../../../contracts/logStats';
import type { BackendActivityEvent } from '../../../contracts/operations';
const row = (raw: unknown): Record<string, unknown> => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Invalid runtime activity view');
  return raw as Record<string, unknown>;
};
const text = (raw: unknown, empty = false): string => {
  if (typeof raw !== 'string' || (!empty && !raw) || raw.length > 8192 || raw.includes('\0'))
    throw new Error('Invalid activity label');
  return raw;
};
const count = (raw: unknown): number => {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0)
    throw new Error('Invalid observed count');
  return raw;
};
const amount = (raw: unknown): number | null => {
  if (raw === null) return null;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0)
    throw new Error('Invalid observed amount');
  return raw;
};
const gaps = (raw: unknown): string[] => {
  if (!Array.isArray(raw) || raw.length > 256) throw new Error('Invalid activity gaps');
  return raw.map((value) => text(value));
};
export function projectTeamActivityLogs(
  raw: unknown,
  projectEvent: (value: unknown) => BackendActivityEvent,
  selected: { memberName: string } | { taskId: string }
): BackendTeamActivityLogs {
  if (Buffer.byteLength(JSON.stringify(raw)) > 512 * 1024)
    throw new Error('Oversized activity logs');
  const source = row(raw);
  if (
    source.kind !== 'team-activity-logs' ||
    !Array.isArray(source.logs) ||
    source.logs.length > 256
  )
    throw new Error('Invalid activity logs');
  return {
    kind: 'team-activity-logs',
    logs: source.logs.map((raw) => {
      const log = row(raw);
      if (
        log.kind !== 'host_activity' ||
        log.startTime !== null ||
        log.durationMs !== null ||
        (log.isOngoing !== null && typeof log.isOngoing !== 'boolean') ||
        !Array.isArray(log.events) ||
        log.events.length > 256
      )
        throw new Error('Invalid captured activity log');
      if (
        'memberName' in selected
          ? log.memberName !== selected.memberName
          : log.taskId !== selected.taskId
      )
        throw new Error('Wrong activity selection');
      return {
        kind: 'host_activity',
        sessionId: text(log.sessionId),
        memberId: text(log.memberId, true),
        memberName: text(log.memberName, true),
        ...(log.taskId === undefined ? {} : { taskId: text(log.taskId) }),
        generation: log.generation === null ? null : text(log.generation),
        description: text(log.description),
        startTime: null,
        durationMs: null,
        messageCount: count(log.messageCount),
        isOngoing: log.isOngoing,
        gaps: gaps(log.gaps),
        ...(log.lastOutputPreview === undefined
          ? {}
          : { lastOutputPreview: text(log.lastOutputPreview, true) }),
        events: log.events.map((raw) => {
          const event = projectEvent(raw);
          if (event.data.kind === 'state' || event.data.kind === 'interaction')
            throw new Error('Not a log content fact');
          return {
            eventId: event.eventId,
            sequence: event.sequence,
            ...(event.inputId === undefined ? {} : { inputId: event.inputId }),
            data: event.data,
          };
        }),
      };
    }),
  };
}
export function projectTeamActivityStats(
  raw: unknown,
  memberName: string
): BackendTeamActivityStats {
  if (Buffer.byteLength(JSON.stringify(raw)) > 64 * 1024)
    throw new Error('Oversized activity stats');
  const source = row(raw),
    stats = row(source.stats);
  if (
    source.kind !== 'team-activity-stats' ||
    stats.kind !== 'host_activity_stats' ||
    stats.memberName !== memberName ||
    stats.scope !== 'retained_runtime_activity'
  )
    throw new Error('Wrong member stats');
  const tools = row(stats.toolUsage);
  if (Object.keys(tools).length > 256) throw new Error('Oversized tool counts');
  return {
    kind: 'team-activity-stats',
    stats: {
      kind: 'host_activity_stats',
      memberName,
      scope: 'retained_runtime_activity',
      generations: count(stats.generations),
      observedMessages: count(stats.observedMessages),
      compactions: count(stats.compactions),
      toolUsage: Object.fromEntries(
        Object.entries(tools).map(([name, value]) => [text(name), count(value)])
      ),
      inputTokens: stats.inputTokens === null ? null : count(stats.inputTokens),
      outputTokens: stats.outputTokens === null ? null : count(stats.outputTokens),
      costUsd: amount(stats.costUsd),
      gaps: gaps(stats.gaps),
      computedAt: text(stats.computedAt),
    },
  };
}
