import { SmartScheduleDispatcher } from './SmartScheduleDispatcher';

import type { ScheduledTaskExecutor } from './ScheduledTaskExecutor';
import type { TeamProvisioningService } from '../team/TeamProvisioningService';
import type { TeamDataService } from '../team/TeamDataService';
import type { TeamIpcHandlerApis } from '../team/contracts/TeamProvisioningApis';

/** Main-process composition; domain dispatch does not depend on Electron or team services. */
export function createSmartScheduleDispatcher(
  apis: Pick<TeamIpcHandlerApis, 'runtime' | 'provisioningRun' | 'diagnostics' | 'memberLifecycle'>,
  data: Pick<TeamDataService, 'getLeadMemberName' | 'getSavedRequest' | 'createTask'>,
  provisioning: Pick<TeamProvisioningService, 'launchTeam'>,
  executor: Pick<ScheduledTaskExecutor, 'execute'>
): SmartScheduleDispatcher {
  return new SmartScheduleDispatcher({
    isTeamAlive: (teamName) => apis.runtime.isTeamAlive(teamName),
    isTeamLaunching: (teamName) => apis.provisioningRun.hasProvisioningRun(teamName),
    getRuntime: (teamName) => apis.diagnostics.getTeamAgentRuntimeSnapshot(teamName),
    getMemberStatuses: (teamName) => apis.memberLifecycle.getMemberSpawnStatuses(teamName),
    getLeadName: (teamName) => data.getLeadMemberName(teamName),
    getSavedRequest: (teamName) => data.getSavedRequest(teamName),
    attachMember: (teamName, memberName) =>
      apis.memberLifecycle.attachLiveRosterMember(teamName, memberName, {
        reason: 'member_added',
      }),
    createTask: (teamName, request) => data.createTask(teamName, request),
    launchTeam: (request) => provisioning.launchTeam(request, () => undefined),
    runOneShot: (request) => executor.execute(request),
  });
}
