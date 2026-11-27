import { isHostTeamSelectionKey } from '@features/agent-backend/contracts';
import { formatSessionLabel } from '@renderer/utils/sessionTitleParser';

import { loadTeamSessionMetadata } from './teamSessionFetchGuards';

import type { TeamSessionConfigLike, TeamSessionMetadataApi } from './teamSessionFetchGuards';
import type {
  BackendTeamSessionHistory,
  HostTeamSessionSummary,
} from '@features/agent-backend/contracts';
import type { Session } from '@renderer/types/data';

export type TeamSessionView = Session | HostTeamSessionSummary;
export const isHostTeamSession = (value: TeamSessionView): value is HostTeamSessionSummary =>
  'kind' in value && value.kind === 'host_session';
export function teamSessionLabel(value: TeamSessionView): string {
  if (!isHostTeamSession(value))
    return formatSessionLabel(value.firstMessage) || value.id.slice(0, 8);
  return value.startedAt === null
    ? 'Session start time unavailable'
    : new Date(value.startedAt).toLocaleString();
}
/** Host selection is resolved before any project lookup or legacy API call, including failures and empty history. */
export async function loadTeamSessionHistory(
  api: TeamSessionMetadataApi & {
    teams: { getHostTeamSessions?: (key: string) => Promise<BackendTeamSessionHistory> };
  },
  teamName: string,
  projectId: string | null,
  config: TeamSessionConfigLike
): Promise<TeamSessionView[]> {
  if (isHostTeamSelectionKey(teamName)) {
    if (!api.teams.getHostTeamSessions) throw new Error('Team session history is unavailable.');
    const value = await api.teams.getHostTeamSessions(teamName);
    if (value.kind !== 'team-session-history') throw new Error('Team session history changed.');
    return value.sessions;
  }
  return projectId ? loadTeamSessionMetadata(api, projectId, config) : [];
}
export function sessionsForTeam(
  teamName: string,
  config: TeamSessionConfigLike,
  sessions: readonly TeamSessionView[]
): TeamSessionView[] {
  if (isHostTeamSelectionKey(teamName)) return sessions.filter(isHostTeamSession);
  const ids = new Set(config.sessionHistory ?? []);
  if (config.leadSessionId) ids.add(config.leadSessionId);
  return sessions
    .filter((row): row is Session => !isHostTeamSession(row))
    .filter((row) => ids.size === 0 || ids.has(row.id));
}
/** Preserve the existing creation-time filter. Missing Host boundaries never exclude tasks. */
export function teamSessionWindow(
  selectedId: string | null,
  sessions: readonly TeamSessionView[]
): { start: number; end: number } | null {
  const selected = sessions.find((row) => row.id === selectedId);
  if (!selected) return null;
  if (isHostTeamSession(selected))
    return selected.clock === 'qualified' && selected.window
      ? { start: selected.window.start, end: selected.window.end ?? Infinity }
      : null;
  const legacy = sessions
    .filter((row): row is Session => !isHostTeamSession(row))
    .sort((left, right) => left.createdAt - right.createdAt);
  const index = legacy.findIndex((row) => row.id === selectedId);
  return index < 0
    ? null
    : { start: legacy[index]!.createdAt, end: legacy[index + 1]?.createdAt ?? Infinity };
}
