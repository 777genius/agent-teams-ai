import type { MemberLogSummary } from '@shared/types/team';
import type { HostMemberActivityLog } from '@shared/types/teamActivity';

/** Application launch identities only. Native session IDs, paths and selectors never cross this boundary. */
export interface HostTeamSessionSummary {
  kind: 'host_session';
  id: string;
  startedAt: number | null;
  window: { start: number; end: number | null } | null;
  clock: 'qualified' | 'unqualified';
  members: number;
  generations: number;
  isOngoing: boolean | null;
  gaps: string[];
}
export interface BackendTeamSessionHistory {
  kind: 'team-session-history';
  revision: string;
  sessions: HostTeamSessionSummary[];
}
export type HostTeamSessionStream = 'activity' | 'conversation' | 'inputs';
export interface BackendTeamSessionPage {
  kind: 'team-session-page';
  sessionId: string;
  stream: HostTeamSessionStream;
  revision: string;
  log: HostMemberActivityLog | null;
  messages: {
    messageId: string;
    memberName: string;
    observedAt: string | null;
    phase?:
      | 'admitted'
      | 'claimed'
      | 'consumed'
      | 'terminal'
      | 'cancelled'
      | 'rejected'
      | 'not-sent'
      | 'unknown';
    text: string;
    part: number;
    parts: number;
  }[];
  gaps: string[];
  nextCursor: string | null;
}
export type BackendTeamSessionQuery =
  | { scope: 'sessions' }
  | { scope: 'session'; sessionId: string; stream: HostTeamSessionStream; cursor?: string };

/** Existing member logs and Host session history share the ordinary Teams API boundary. */
export interface TeamSessionsApi {
  getMemberLogs: (teamName: string, memberName: string) => Promise<MemberLogSummary[]>;
  getHostTeamSessions?: (teamName: string) => Promise<BackendTeamSessionHistory>;
  getHostTeamSessionPage?: (
    teamName: string,
    sessionId: string,
    stream: HostTeamSessionStream,
    cursor?: string
  ) => Promise<BackendTeamSessionPage>;
}
