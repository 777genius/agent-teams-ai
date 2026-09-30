import {
  normalizePersistedTeamLaunchParams,
  type TeamLaunchAnalyticsCoordinatorDependencies,
  type TeamLaunchParams,
  type TeamProvisioningControlTransportPort,
  type TeamProvisioningLaunchPersistencePort,
  type TeamProvisioningLaunchTransportPort,
} from '@features/team-provisioning/renderer';
import * as productAnalytics from '@renderer/analytics/productAnalytics';
import { api } from '@renderer/api';
import { unwrapIpc } from '@renderer/utils/unwrapIpc';

import type { ToolApprovalSettings } from '@shared/types';

const LAUNCH_PARAMS_PREFIX = 'team:launchParams:';
const TOOL_APPROVAL_PREFIX = 'team:toolApprovalSettings:';

type TeamProvisioningRuntimeApi = Pick<typeof api, 'teams'>;

export interface TeamProvisioningRuntimeAdapters {
  control: TeamProvisioningControlTransportPort;
  launch: TeamProvisioningLaunchTransportPort;
  launchAnalytics: TeamLaunchAnalyticsCoordinatorDependencies;
  persistence: TeamProvisioningLaunchPersistencePort;
}

interface CurrentProductAnalytics {
  recordTeamLaunchStepEnd(
    input: Parameters<
      TeamLaunchAnalyticsCoordinatorDependencies['recorder']['recordLaunchStepEnd']
    >[0]
  ): void;
}

function loadAllLaunchParams(): Record<string, TeamLaunchParams> {
  const result: Record<string, TeamLaunchParams> = {};
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(LAUNCH_PARAMS_PREFIX)) continue;

      try {
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const teamName = key.slice(LAUNCH_PARAMS_PREFIX.length);
        if (!teamName) continue;
        const parsed = normalizePersistedTeamLaunchParams(JSON.parse(raw));
        if (parsed) result[teamName] = parsed;
      } catch {
        // Best-effort restore: ignore only the malformed team entry.
      }
    }
  } catch {
    // Storage may be unavailable in restricted renderer contexts.
  }
  return result;
}

function saveLaunchParams(teamName: string, params: TeamLaunchParams): void {
  try {
    localStorage.setItem(LAUNCH_PARAMS_PREFIX + teamName, JSON.stringify(params));
  } catch {
    // Best-effort persistence.
  }
}

function saveToolApprovalSettings(teamName: string, settings: ToolApprovalSettings): void {
  try {
    localStorage.setItem(TOOL_APPROVAL_PREFIX + teamName, JSON.stringify(settings));
  } catch {
    // Best-effort persistence.
  }
}

export function createTeamProvisioningRuntimeAdapters(
  appApi: TeamProvisioningRuntimeApi = api
): TeamProvisioningRuntimeAdapters {
  const getTeams = () => appApi.teams;
  const currentProductAnalytics = productAnalytics as unknown as Partial<CurrentProductAnalytics>;

  return {
    control: {
      cancel: (runId) =>
        unwrapIpc('team:cancelProvisioning', () => getTeams().cancelProvisioning(runId)),
      getStatus: (runId) =>
        unwrapIpc('team:provisioningStatus', () => getTeams().getProvisioningStatus(runId)),
      subscribe: (listener) => {
        const teams = getTeams();
        if (!teams.onProvisioningProgress) return null;
        return teams.onProvisioningProgress((_event, progress) => listener(progress));
      },
    },
    launch: {
      create: (request) => {
        const teams = getTeams();
        if (typeof teams.createTeam !== 'function') {
          throw new Error(
            'Current preload version does not support team:create. Restart the dev app.'
          );
        }
        return unwrapIpc('team:create', () => teams.createTeam(request));
      },
      launch: (request) => unwrapIpc('team:launch', () => getTeams().launchTeam(request)),
    },
    launchAnalytics: {
      metrics: {
        classifyError: productAnalytics.classifyAnalyticsError,
        elapsedMsBetweenIso: productAnalytics.elapsedMsBetweenIso,
        elapsedMsSince: productAnalytics.elapsedMsSince,
        hasMixedProviders: (providerIds) =>
          productAnalytics.buildProviderMix(providerIds).hasMixedProviders,
      },
      recorder: {
        recordCreate: productAnalytics.recordTeamCreate,
        recordLaunchEnd: productAnalytics.recordTeamLaunchEnd,
        recordLaunchStepEnd: currentProductAnalytics.recordTeamLaunchStepEnd ?? (() => undefined),
      },
    },
    persistence: {
      loadAllLaunchParams,
      saveLaunchParams,
      saveToolApprovalSettings,
    },
  };
}
