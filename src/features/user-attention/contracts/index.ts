import type { InboxMessage } from '@shared/types/team';

export const USER_ATTENTION_CHANNEL = 'user-attention:get-snapshot';
export const USER_ATTENTION_HTTP_ROUTE = '/api/user-attention';

/** The backend does not expose this feature, as distinct from a transient read failure. */
export class UserAttentionUnsupportedError extends Error {
  constructor() {
    super('User Attention is not supported by this server');
    this.name = 'UserAttentionUnsupportedError';
  }
}

export interface AttentionTaskCandidate {
  teamName: string;
  /** Visible logical parent when source is a verified project execution alias. */
  logicalTeamName?: string;
  teamDisplayName: string;
  taskId: string;
  displayId?: string;
  subject: string;
  owner?: string;
  requestedAt: string | null;
  projectPath?: string;
}

export interface AttentionTeamSnapshot {
  teamName: string;
  logicalTeamName?: string;
  teamDisplayName: string;
  projectPath?: string;
  tasks: AttentionTaskCandidate[];
  /** Canonical, user-addressed message candidates. Read state remains client-owned. */
  messages: InboxMessage[];
  /** Active direct-chat roster from the canonical team summary (excluding removed members). */
  directParticipants?: readonly string[];
  leadName?: string;
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
