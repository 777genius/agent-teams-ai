import { TeamApplicationHost } from '@main/composition/team/TeamApplicationHost';
import {
  bindTeamApplicationDataApi,
  bindTeamApplicationProvisioningStartApi,
  bindTeamApplicationProvisioningStatusApi,
  bindTeamApplicationResumeApi,
  bindTeamApplicationRuntimeApi,
  bindTeamApplicationTaskActivityApi,
} from '@main/services/team/contracts/TeamApplicationCapabilityApiBinder';
import { TeamConfigReader } from '@main/services/team/TeamConfigReader';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { constants as fsConstants } from 'fs';
import { access } from 'fs/promises';
import { join } from 'path';

import type {
  TeamApplicationDataApi,
  TeamApplicationProvisioningStartApi,
  TeamApplicationProvisioningStatusApi,
  TeamApplicationResumeApi,
  TeamApplicationRuntimeApi,
  TeamApplicationTaskActivityApi,
} from '@main/services/team/contracts/TeamApplicationCapabilityApis';

export interface TeamApplicationHostSources {
  readonly data?: TeamApplicationDataApi;
  readonly provisioningStart?: TeamApplicationProvisioningStartApi;
  readonly provisioningStatus?: TeamApplicationProvisioningStatusApi;
  readonly runtime?: TeamApplicationRuntimeApi;
  readonly taskActivity?: TeamApplicationTaskActivityApi;
  readonly memberWorkSync?: TeamApplicationResumeApi;
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
  const data = sources.data ? bindTeamApplicationDataApi(sources.data) : undefined;
  const provisioningStart = sources.provisioningStart
    ? bindTeamApplicationProvisioningStartApi(sources.provisioningStart)
    : undefined;
  const provisioningStatus = sources.provisioningStatus
    ? bindTeamApplicationProvisioningStatusApi(sources.provisioningStatus)
    : undefined;
  const runtime = sources.runtime ? bindTeamApplicationRuntimeApi(sources.runtime) : undefined;
  const taskActivity = sources.taskActivity
    ? bindTeamApplicationTaskActivityApi(sources.taskActivity)
    : undefined;
  const memberWorkSync = sources.memberWorkSync
    ? bindTeamApplicationResumeApi(sources.memberWorkSync)
    : undefined;

  return new TeamApplicationHost({
    configPresence: {
      hasConfig: hasTeamConfig,
    },
    listInvalidation: {
      invalidate: () => TeamConfigReader.invalidateListTeamsCache(),
    },
    data,
    provisioningStart,
    provisioningStatus,
    runtime,
    taskActivity,
    resume: memberWorkSync,
  });
}
