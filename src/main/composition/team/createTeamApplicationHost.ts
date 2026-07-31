import { TeamApplicationHost } from '@main/composition/team/TeamApplicationHost';
import { TeamConfigReader } from '@main/services/team/TeamConfigReader';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { constants as fsConstants } from 'fs';
import { access } from 'fs/promises';
import { join } from 'path';

import type { MemberWorkSyncFeatureFacade } from '@features/member-work-sync/main';
import type {
  TeamHttpDataApi,
  TeamHttpHandlerApis,
} from '@main/services/team/contracts/TeamProvisioningApis';

export interface TeamApplicationHostSources {
  readonly data?: TeamHttpDataApi;
  readonly provisioningStart?: TeamHttpHandlerApis['provisioningStart'];
  readonly provisioningStatus?: TeamHttpHandlerApis['provisioningStatus'];
  readonly runtime?: TeamHttpHandlerApis['runtime'];
  readonly taskActivity?: TeamHttpHandlerApis['taskActivity'];
  readonly memberWorkSync?: Pick<MemberWorkSyncFeatureFacade, 'resumeTeam'>;
}

async function hasTeamConfig(teamName: string): Promise<boolean> {
  const configPath = join(getTeamsBasePath(), teamName, 'config.json');
  try {
    await access(configPath, fsConstants.F_OK);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

export function createTeamApplicationHost(
  sources: TeamApplicationHostSources
): TeamApplicationHost {
  const data = sources.data;
  const provisioningStart = sources.provisioningStart;
  const provisioningStatus = sources.provisioningStatus;
  const runtime = sources.runtime;
  const taskActivity = sources.taskActivity;
  const memberWorkSync = sources.memberWorkSync;

  return new TeamApplicationHost({
    configPresence: {
      hasConfig: hasTeamConfig,
    },
    listInvalidation: {
      invalidate: () => TeamConfigReader.invalidateListTeamsCache(),
    },
    data: data
      ? {
          listTeams: () => data.listTeams(),
          getTeamData: (teamName) => data.getTeamData(teamName),
          getSavedRequest: (teamName) => data.getSavedRequest(teamName),
          createTeamConfig: (request) => data.createTeamConfig(request),
        }
      : undefined,
    provisioningStart: provisioningStart
      ? {
          createTeam: (request, onProgress) => provisioningStart.createTeam(request, onProgress),
          launchTeam: (request, onProgress) => provisioningStart.launchTeam(request, onProgress),
        }
      : undefined,
    provisioningStatus: provisioningStatus
      ? {
          getProvisioningStatus: (runId) => provisioningStatus.getProvisioningStatus(runId),
        }
      : undefined,
    runtime: runtime
      ? {
          getRuntimeState: (teamName) => runtime.getRuntimeState(teamName),
          stopTeam: (teamName) => runtime.stopTeam(teamName),
          getAliveTeams: () => runtime.getAliveTeams(),
        }
      : undefined,
    taskActivity: taskActivity
      ? {
          repairStaleTaskActivityIntervalsBeforeSnapshot: (teamName) =>
            taskActivity.repairStaleTaskActivityIntervalsBeforeSnapshot(teamName),
        }
      : undefined,
    resume: memberWorkSync
      ? {
          resumeTeam: (teamName) => memberWorkSync.resumeTeam(teamName),
        }
      : undefined,
  });
}
