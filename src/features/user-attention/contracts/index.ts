import type { InboxMessage } from '@shared/types/team';

export const USER_ATTENTION_CHANNEL = 'user-attention:get-snapshot';
export const USER_ATTENTION_HTTP_ROUTE = '/api/user-attention';

export interface AttentionTaskCandidate {
  teamName: string;
  teamDisplayName: string;
  taskId: string;
  displayId?: string;
  subject: string;
  requestedAt: string | null;
  projectPath?: string;
}

export interface AttentionTeamSnapshot {
  teamName: string;
  teamDisplayName: string;
  projectPath?: string;
  tasks: AttentionTaskCandidate[];
  /** Canonical, user-addressed message candidates. Read state remains client-owned. */
  messages: InboxMessage[];
  /** Optional labels from the existing group-chat catalog; no second group model. */
  groupNames?: Record<string, string>;
  error?: string;
}

export interface AttentionSnapshot {
  contextId: string;
  teams: AttentionTeamSnapshot[];
  complete: boolean;
}

export interface UserAttentionApi {
  getUserAttentionSnapshot(teamName?: string): Promise<AttentionSnapshot>;
}
