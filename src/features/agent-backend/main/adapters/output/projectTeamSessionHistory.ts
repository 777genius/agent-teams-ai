import { projectTeamActivityLogs } from './projectTeamActivity';

import type { BackendActivityEvent } from '../../../contracts/operations';
import type {
  BackendTeamSessionHistory,
  BackendTeamSessionPage,
  BackendTeamSessionQuery,
} from '../../../contracts/sessionHistory';

const invalid = (): never => {
  throw new Error('Invalid original Team session history');
};
const row = (raw: unknown): Record<string, unknown> =>
  raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : invalid();
const text = (raw: unknown, limit = 8192): string =>
  typeof raw === 'string' && raw.length <= limit && !raw.includes('\0') ? raw : invalid();
const id = (raw: unknown): string => {
  const value = text(raw, 256);
  return /^host-session-[a-f0-9]{64}$/u.test(value) ? value : invalid();
};
const digest = (raw: unknown): string => {
  const value = text(raw, 64);
  return /^[a-f0-9]{64}$/u.test(value) ? value : invalid();
};
const count = (raw: unknown, limit = Number.MAX_SAFE_INTEGER): number =>
  typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 && raw <= limit
    ? raw
    : invalid();
const time = (raw: unknown): number | null =>
  raw === null ? null : count(raw, 8_640_000_000_000_000);
const list = (raw: unknown, limit: number): unknown[] =>
  Array.isArray(raw) && raw.length <= limit ? raw : invalid();
const gaps = (raw: unknown): string[] => list(raw, 256).map((value) => text(value));
const ongoing = (raw: unknown): boolean | null =>
  raw === null || typeof raw === 'boolean' ? raw : invalid();

/** Strict bounded consumer projection; qualified task windows must match the original launch catalogue. */
export function projectTeamSessionHistory(
  raw: unknown,
  query: BackendTeamSessionQuery,
  event: (raw: unknown) => BackendActivityEvent
): BackendTeamSessionHistory | BackendTeamSessionPage {
  if (Buffer.byteLength(JSON.stringify(raw)) > 256 * 1024) invalid();
  const source = row(raw);
  if (query.scope === 'sessions') {
    if (source.kind !== 'team-session-history') invalid();
    const sessions: BackendTeamSessionHistory['sessions'] = list(source.sessions, 256).map(
      (raw) => {
        const value = row(raw),
          startedAt = time(value.startedAt);
        if (
          value.kind !== 'host_session' ||
          !['qualified', 'unqualified'].includes(String(value.clock))
        )
          invalid();
        const window = value.window === null ? null : row(value.window);
        const projectedWindow =
          window === null
            ? null
            : { start: count(window.start, 8_640_000_000_000_000), end: time(window.end) };
        if (
          value.clock === 'qualified'
            ? startedAt === null ||
              projectedWindow === null ||
              projectedWindow.start !== startedAt ||
              (projectedWindow.end !== null && projectedWindow.end <= projectedWindow.start)
            : projectedWindow !== null
        )
          invalid();
        const members = count(value.members, 256),
          generations = count(value.generations, 256);
        if (members === 0 || generations < members) invalid();
        return {
          kind: 'host_session',
          id: id(value.id),
          startedAt,
          window: projectedWindow,
          clock: value.clock as 'qualified' | 'unqualified',
          members,
          generations,
          isOngoing: ongoing(value.isOngoing),
          gaps: gaps(value.gaps),
        };
      }
    );
    if (new Set(sessions.map((value) => value.id)).size !== sessions.length) invalid();
    const starts = sessions.map((value) => value.startedAt);
    for (const session of sessions) {
      if (session.clock !== 'qualified') continue;
      if (starts.some((value) => value === null) || new Set(starts).size !== starts.length)
        invalid();
      const next =
        starts
          .filter((value): value is number => value !== null && value > session.startedAt!)
          .sort((a, b) => a - b)[0] ?? null;
      if (session.window?.end !== next) invalid();
    }
    return { kind: 'team-session-history', revision: digest(source.revision), sessions };
  }
  if (
    source.kind !== 'team-session-page' ||
    source.sessionId !== query.sessionId ||
    source.stream !== query.stream
  )
    invalid();
  const log =
    source.log === null
      ? null
      : (() => {
          const value = row(source.log);
          if (
            !/^host-activity-[a-f0-9]{64}$/u.test(text(value.sessionId, 256)) ||
            value.taskId !== undefined ||
            value.generation === null
          )
            invalid();
          return projectTeamActivityLogs(
            { kind: 'team-activity-logs', logs: [source.log] },
            event,
            { memberName: text(value.memberName, 256) }
          ).logs[0]!;
        })();
  const messages = list(source.messages, 64).map((raw) => {
    const value = row(raw);
    const observedAt = value.observedAt === null ? null : text(value.observedAt, 128);
    const phase =
      value.phase === undefined
        ? undefined
        : (text(value.phase, 32) as BackendTeamSessionPage['messages'][number]['phase']);
    if (
      query.stream === 'inputs'
        ? observedAt !== null ||
          phase === undefined ||
          ![
            'admitted',
            'claimed',
            'consumed',
            'terminal',
            'cancelled',
            'rejected',
            'not-sent',
            'unknown',
          ].includes(phase)
        : observedAt === null || !Number.isFinite(Date.parse(observedAt)) || phase !== undefined
    )
      invalid();
    const messageId = text(value.messageId, 256),
      memberName = text(value.memberName, 256);
    if (
      !messageId ||
      !memberName ||
      (query.stream === 'inputs' && !/^host-input-[a-f0-9]{64}$/u.test(messageId))
    )
      invalid();
    const part = count(value.part, 4095),
      parts = count(value.parts, 4096);
    if (parts === 0 || part >= parts) invalid();
    return {
      messageId,
      memberName,
      observedAt,
      ...(phase === undefined ? {} : { phase }),
      text: text(value.text, 64 * 1024),
      part,
      parts,
    };
  });
  if (query.stream === 'activity' ? log === null || messages.length !== 0 : log !== null) invalid();
  const nextCursor = source.nextCursor === null ? null : text(source.nextCursor, 2048);
  if (nextCursor === '') invalid();
  return {
    kind: 'team-session-page',
    sessionId: id(source.sessionId),
    stream: query.stream,
    revision: digest(source.revision),
    log,
    messages,
    gaps: gaps(source.gaps),
    nextCursor,
  };
}
