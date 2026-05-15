export type CommandCategory =
  | 'project'
  | 'session'
  | 'team'
  | 'task'
  | 'member'
  | 'action'
  | 'settings';

export type CommandIconKey =
  | 'dashboard'
  | 'extensions'
  | 'member'
  | 'notifications'
  | 'project'
  | 'schedules'
  | 'search'
  | 'session'
  | 'settings'
  | 'task'
  | 'team';

export interface CommandSearchNavigationTarget {
  query: string;
  messageTimestamp: number;
  matchedText: string;
  targetGroupId?: string;
  targetMatchIndexInItem?: number;
  targetMatchStartOffset?: number;
  targetMessageUuid?: string;
}

export type CommandTabTarget =
  | 'dashboard'
  | 'extensions'
  | 'notifications'
  | 'schedules'
  | 'settings'
  | 'teams';

export type CommandIntent =
  | { type: 'project.select'; repositoryId: string }
  | {
      type: 'session.open';
      projectId: string;
      sessionId: string;
      search: CommandSearchNavigationTarget;
    }
  | { type: 'tab.open'; tab: CommandTabTarget; settingsSection?: string }
  | { type: 'team.open'; teamName: string; projectPath?: string; taskId?: string }
  | { type: 'task.open'; teamName: string; taskId: string; commentId?: string }
  | {
      type: 'member.profile';
      teamName: string;
      memberName: string;
      focus?: 'profile' | 'messages' | 'logs';
    };

export interface CommandConfirmation {
  title: string;
  message?: string;
  confirmLabel?: string;
  variant?: 'default' | 'danger';
}

export interface CommandItem {
  id: string;
  providerId: string;
  category: CommandCategory;
  title: string;
  subtitle?: string;
  detail?: string;
  badge?: string;
  icon: CommandIconKey;
  keywords?: readonly string[];
  priority?: number;
  dedupeKey?: string;
  disabledReason?: string;
  confirmation?: CommandConfirmation;
  intent: CommandIntent;
}

export interface RankedCommandItem {
  item: CommandItem;
  score: number;
  providerIndex: number;
  itemIndex: number;
}
