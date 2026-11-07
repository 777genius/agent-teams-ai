import { JsonScheduleRepository } from './JsonScheduleRepository';
import { ScheduledTaskExecutor } from './ScheduledTaskExecutor';
import { SchedulerService } from './SchedulerService';
import { SmartScheduleDispatcher } from './SmartScheduleDispatcher';

import type { TeamIpcHandlerApis } from '../team/contracts/TeamProvisioningApis';
import type { TeamDataService } from '../team/TeamDataService';
import type { TeamProvisioningService } from '../team/TeamProvisioningService';

/** Composes the scheduler from existing main-process APIs; no new runtime owner. */
export function createSchedulerService(
  apis: Pick<TeamIpcHandlerApis, 'runtime' | 'provisioningRun' | 'diagnostics' | 'memberLifecycle'>,
  data: Pick<TeamDataService, 'getLeadMemberName' | 'getSavedRequest' | 'createTask'>,
  provisioning: Pick<TeamProvisioningService, 'launchTeam' | 'prepareForProvisioning' | 'hasTeamOperationInProgress'>
): SchedulerService {
  const executor = new ScheduledTaskExecutor();
  const dispatcher = new SmartScheduleDispatcher({
    isTeamAlive: (teamName) => apis.runtime.isTeamAlive(teamName),
    isTeamLaunching: (teamName) => apis.provisioningRun.hasProvisioningRun(teamName),
    isTeamBusy: (teamName) => provisioning.hasTeamOperationInProgress(teamName),
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

  return new SchedulerService(
    new JsonScheduleRepository(),
    executor,
    async (cwd) => {
      const result = await provisioning.prepareForProvisioning(cwd, { forceFresh: true });
      return { ready: result.ready, message: result.message };
    },
    dispatcher
  );
}
