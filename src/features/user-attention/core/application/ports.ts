import type { InboxMessage, TeamTask } from '@shared/types/team';

export interface AttentionTeamSource {
  teamName: string;
  displayName: string;
  projectPath?: string;
  deletedAt?: string;
}

export interface AttentionSourcePort {
  currentContextId(): string;
  listTeams(): Promise<readonly AttentionTeamSource[]>;
  listHumanTasks(teamName: string): Promise<readonly TeamTask[]>;
  listNormalizedMessages(teamName: string): Promise<readonly InboxMessage[]>;
}
