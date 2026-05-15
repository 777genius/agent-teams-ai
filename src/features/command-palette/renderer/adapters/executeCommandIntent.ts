import type { CommandIntent, CommandTabTarget } from '../../core/domain/models/CommandItem';

export interface CommandExecutionResult {
  closePalette: boolean;
  resetQuery?: boolean;
  focusInput?: boolean;
}

export interface CommandIntentRuntime {
  selectRepository(repositoryId: string): void;
  navigateToSession(
    projectId: string,
    sessionId: string,
    fromSearch: boolean,
    searchContext: {
      query: string;
      messageTimestamp: number;
      matchedText: string;
      targetGroupId?: string;
      targetMatchIndexInItem?: number;
      targetMatchStartOffset?: number;
      targetMessageUuid?: string;
    }
  ): void;
  openDashboard(): void;
  openTeamsTab(): void;
  openSettingsTab(section?: string): void;
  openNotificationsTab(): void;
  openSchedulesTab(): void;
  openExtensionsTab(): void;
  openTeamTab(teamName: string, projectPath?: string, taskId?: string): void;
  openGlobalTaskDetail(teamName: string, taskId: string, commentId?: string): void;
  openMemberProfile(
    memberName: string,
    teamName?: string,
    focus?: 'profile' | 'messages' | 'logs'
  ): void;
}

function openTabTarget(
  tab: CommandTabTarget,
  intent: CommandIntent,
  runtime: CommandIntentRuntime
): void {
  switch (tab) {
    case 'dashboard':
      runtime.openDashboard();
      return;
    case 'extensions':
      runtime.openExtensionsTab();
      return;
    case 'notifications':
      runtime.openNotificationsTab();
      return;
    case 'schedules':
      runtime.openSchedulesTab();
      return;
    case 'settings':
      runtime.openSettingsTab(intent.type === 'tab.open' ? intent.settingsSection : undefined);
      return;
    case 'teams':
      runtime.openTeamsTab();
      return;
  }
}

export async function executeCommandIntent(
  intent: CommandIntent,
  runtime: CommandIntentRuntime
): Promise<CommandExecutionResult> {
  switch (intent.type) {
    case 'project.select':
      runtime.selectRepository(intent.repositoryId);
      return { closePalette: false, resetQuery: true, focusInput: true };

    case 'session.open':
      runtime.navigateToSession(intent.projectId, intent.sessionId, true, intent.search);
      return { closePalette: true };

    case 'tab.open':
      openTabTarget(intent.tab, intent, runtime);
      return { closePalette: true };

    case 'team.open':
      runtime.openTeamTab(intent.teamName, intent.projectPath, intent.taskId);
      return { closePalette: true };

    case 'task.open':
      runtime.openTeamTab(intent.teamName);
      runtime.openGlobalTaskDetail(intent.teamName, intent.taskId, intent.commentId);
      return { closePalette: true };

    case 'member.profile':
      runtime.openTeamTab(intent.teamName);
      runtime.openMemberProfile(intent.memberName, intent.teamName, intent.focus);
      return { closePalette: true };
  }
}
