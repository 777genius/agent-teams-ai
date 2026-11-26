import { isProjectCopyName } from '@features/team-project-context/core';
import { TeamProjectContextRegistry } from '@features/team-project-context/main';
import { namedTeamId } from '@features/token-usage/contracts';
import {
  assertTeamBudgetLaunchAllowed,
  evaluateTeamBudgetEnforcement,
} from '@features/token-usage/main';

import { stopTeamWithVerifiedEscalation } from '../lifecycle/stopTeamWithVerifiedEscalation';

import { TeamBudgetStopObserver } from './TeamBudgetStopObserver';

import type {
  TokenUsageBudgetSettingsDto,
  TokenUsageBudgetStatusDto,
} from '@features/token-usage/contracts';

interface TeamBudgetReader {
  getBudgetSettings(): Promise<TokenUsageBudgetSettingsDto>;
  getBudgetStatus(): Promise<TokenUsageBudgetStatusDto>;
  refreshSnapshot(): Promise<unknown>;
}

interface TeamBudgetRuntime {
  getAliveTeams(): string[];
  isTeamManagedByThisProfile(teamName: string): Promise<boolean>;
  stopTeam(teamName: string): Promise<void>;
  isTeamAlive(teamName: string): boolean | Promise<boolean>;
}

export interface TeamBudgetNotificationFlags {
  notifyOnUsageBudgetAlerts: boolean;
  notifyOnUsageBudgetWarning: boolean;
  notifyOnUsageBudgetCritical: boolean;
  notifyOnUsageBudgetNativeToast: boolean;
}

function createBudgetAccess(getReader: () => TeamBudgetReader | null) {
  const projectContexts = () => TeamProjectContextRegistry.fromCurrentApp();
  const resolveBudgetAliases = async (names: readonly string[]) => {
    const lookup = await projectContexts().resolveOwnedExecutionAliases(names);
    const aliases = new Map<string, string>();
    const unresolvedNames: string[] = [];
    for (const name of names) {
      const result = lookup.get(name);
      if (!result || 'error' in result) {
        // A foreign or corrupted entry must not hide unrelated teams' budgets.
        unresolvedNames.push(name);
      } else if (result.alias) {
        aliases.set(name, result.alias.logicalTeamName);
      }
    }
    return { aliases, unresolvedNames };
  };
  const read = (): TeamBudgetReader => {
    const reader = getReader();
    if (!reader) throw new Error('TEAM_BUDGET_BLOCKED: Budget service unavailable');
    return reader;
  };
  return { read, resolveBudgetAliases, projectContexts };
}

/** Created before provisioning. Required factory injection prevents an unguarded launch gap. */
export function createTeamBudgetAdmission(
  getReader: () => TeamBudgetReader | null
): (teamName: string) => Promise<void> {
  const { read, projectContexts } = createBudgetAccess(getReader);
  return async (teamName) => {
    const reader = read();
    // Admission is strict: never treat an unreadable runtime alias as a native team.
    const owner = await projectContexts().resolveOwnedExecutionAlias(teamName);
    if (!owner && isProjectCopyName(teamName)) {
      throw new Error(
        `TEAM_BUDGET_BLOCKED: Cannot verify project runtime ownership for "${teamName}"`
      );
    }
    const logicalTeam = owner?.logicalTeamName ?? teamName;
    const settings = await reader.getBudgetSettings();
    if ((settings.teams?.[namedTeamId(logicalTeam)]?.onExceeded ?? 'notify') === 'notify') return;
    let status = await reader.getBudgetStatus();
    // A known subtotal at the limit needs no expensive provider refresh.
    // The stop/launch decision is already conclusive even if other data is late.
    if (evaluateTeamBudgetEnforcement(status, logicalTeam).state === 'exceeded') {
      assertTeamBudgetLaunchAllowed(status, logicalTeam);
    }
    // Refresh first-use and rolled-over budgets once. No stale/unknown zero-spend assumption.
    if (
      status.stale ||
      status.degraded ||
      status.targets.some(
        (target) =>
          target.scope === 'team' &&
          target.id === namedTeamId(logicalTeam) &&
          target.metrics.some((metric) => metric.incomplete || metric.value === null)
      )
    ) {
      await reader.refreshSnapshot();
      status = await reader.getBudgetStatus();
    }
    assertTeamBudgetLaunchAllowed(status, logicalTeam);
  };
}

/** Reuses the existing usage ledger and native process lifecycle. */
export function createTeamBudgetControls(
  getReader: () => TeamBudgetReader | null,
  runtime: TeamBudgetRuntime,
  getNotificationFlags: () => TeamBudgetNotificationFlags,
  warn: (message: string, error: unknown) => void
) {
  const { read, resolveBudgetAliases, projectContexts } = createBudgetAccess(getReader);
  const observer = new TeamBudgetStopObserver({
    readCurrentStatus: async () => read().getBudgetStatus(),
    aliveTeams: () => runtime.getAliveTeams(),
    resolveRuntimeNames: async (logicalTeam) => {
      const { candidates, refused } = await projectContexts().listOwnedStopCandidates(logicalTeam);
      for (const failure of refused) {
        warn(
          `Budget stop skipped unverified runtime "${failure.executionTeamName}" for "${logicalTeam}"`,
          failure.error
        );
      }
      return [logicalTeam, ...candidates];
    },
    ownsTeam: (teamName) => runtime.isTeamManagedByThisProfile(teamName),
    stopTeam: (teamName) =>
      stopTeamWithVerifiedEscalation(teamName, runtime, {
        warn: (message) => warn(message, undefined),
      }),
    isTeamAlive: (teamName) => runtime.isTeamAlive(teamName),
    warn,
  });
  return {
    observer,
    resolveBudgetAliases,
    notificationSettings: {
      getSettings: () => {
        const flags = getNotificationFlags();
        return {
          enabled: flags.notifyOnUsageBudgetAlerts,
          notifyAtWarning: flags.notifyOnUsageBudgetWarning,
          notifyAtCritical: flags.notifyOnUsageBudgetCritical,
          nativeToasts: flags.notifyOnUsageBudgetNativeToast,
        };
      },
    },
  };
}
