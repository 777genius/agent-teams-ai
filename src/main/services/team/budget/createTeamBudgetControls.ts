import { assertTeamBudgetLaunchAllowed } from '@features/token-usage/core/domain';
import { namedTeamId } from '@features/token-usage/contracts';

import { TeamBudgetStopObserver } from './TeamBudgetStopObserver';

import type {
  TokenUsageBudgetSettingsDto,
  TokenUsageBudgetStatusDto,
} from '@features/token-usage/contracts';

interface TeamBudgetReader {
  getBudgetSettings(): Promise<TokenUsageBudgetSettingsDto>;
  getBudgetStatus(): Promise<TokenUsageBudgetStatusDto>;
}

interface TeamBudgetRuntime {
  setTeamBudgetAdmissionGuard(guard: (teamName: string) => Promise<void>): void;
  getAliveTeams(): string[];
  isTeamManagedByThisProfile(teamName: string): Promise<boolean>;
  stopTeam(teamName: string): Promise<void>;
  isTeamAlive(teamName: string): Promise<boolean>;
}

export interface TeamBudgetNotificationFlags {
  notifyOnUsageBudgetAlerts: boolean;
  notifyOnUsageBudgetWarning: boolean;
  notifyOnUsageBudgetCritical: boolean;
  notifyOnUsageBudgetNativeToast: boolean;
}

/**
 * Local main-process composition: only the existing usage feature accounts spend,
 * and only the existing runtime controls process ownership/stop.
 */
export function createTeamBudgetControls(
  getReader: () => TeamBudgetReader | null,
  runtime: TeamBudgetRuntime,
  getNotificationFlags: () => TeamBudgetNotificationFlags,
  warn: (message: string, error: unknown) => void
) {
  const read = (): TeamBudgetReader => {
    const reader = getReader();
    if (!reader) throw new Error('TEAM_BUDGET_BLOCKED: Budget service unavailable');
    return reader;
  };
  runtime.setTeamBudgetAdmissionGuard(async (teamName) => {
    const reader = read();
    const settings = await reader.getBudgetSettings();
    if ((settings.teams?.[namedTeamId(teamName)]?.onExceeded ?? 'notify') === 'notify') return;
    assertTeamBudgetLaunchAllowed(await reader.getBudgetStatus(), teamName);
  });
  const observer = new TeamBudgetStopObserver({
    readCurrentStatus: async () => read().getBudgetStatus(),
    aliveTeams: () => runtime.getAliveTeams(),
    ownsTeam: (teamName) => runtime.isTeamManagedByThisProfile(teamName),
    stopTeam: (teamName) => runtime.stopTeam(teamName),
    isTeamAlive: (teamName) => runtime.isTeamAlive(teamName),
    warn,
  });
  return {
    observer,
    notificationSettings: {
      getSettings: () => {
        const notifications = getNotificationFlags();
        return {
          enabled: notifications.notifyOnUsageBudgetAlerts,
          notifyAtWarning: notifications.notifyOnUsageBudgetWarning,
          notifyAtCritical: notifications.notifyOnUsageBudgetCritical,
          nativeToasts: notifications.notifyOnUsageBudgetNativeToast,
        };
      },
    },
  };
}
