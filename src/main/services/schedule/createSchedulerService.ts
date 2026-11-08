import { TeamConfigReader } from '../team/TeamConfigReader';

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
  data: Pick<
    TeamDataService,
    'getLeadMemberName' | 'getSavedRequest' | 'createTask' | 'getTask' | 'startTaskByUser'
  >,
  provisioning: Pick<TeamProvisioningService, 'launchTeam' | 'prepareForProvisioning' | 'hasTeamOperationInProgress'>
): SchedulerService {
  const executor = new ScheduledTaskExecutor();
  const repository = new JsonScheduleRepository();
  const configReader = new TeamConfigReader();
  const dispatcher = new SmartScheduleDispatcher({
    isTeamAlive: (teamName) => apis.runtime.isTeamAlive(teamName),
    isTeamLaunching: (teamName) => apis.provisioningRun.hasProvisioningRun(teamName),
    isTeamBusy: (teamName) => provisioning.hasTeamOperationInProgress(teamName),
    getRuntime: (teamName) => apis.diagnostics.getTeamAgentRuntimeSnapshot(teamName),
    getMemberStatuses: (teamName) => apis.memberLifecycle.getMemberSpawnStatuses(teamName),
    getLeadName: (teamName) => data.getLeadMemberName(teamName),
    getSavedRequest: (teamName) => data.getSavedRequest(teamName),
    hasRunnableConfig: async (teamName) => {
      const config = await configReader.getConfig(teamName);
      return Boolean(config && !config.deletedAt);
    },
    getPreviousRun: async (scheduleId, runId) =>
      (await repository.listRuns(scheduleId, { limit: 2 })).find((run) => run.id !== runId) ?? null,
    getTask: (teamName, taskId) => data.getTask(teamName, taskId),
    startTaskByUser: (teamName, taskId) => data.startTaskByUser(teamName, taskId),
    attachMember: (teamName, memberName) =>
      apis.memberLifecycle.attachLiveRosterMember(teamName, memberName, {
        reason: 'member_added',
      }),
    createTask: (teamName, request) => data.createTask(teamName, request),
    launchTeam: (request) => provisioning.launchTeam(request, () => undefined),
    runOneShot: (request) => executor.execute(request),
  });

  return new SchedulerService(
    repository,
    executor,
    async (cwd) => {
      const result = await provisioning.prepareForProvisioning(cwd, { forceFresh: true });
      return { ready: result.ready, message: result.message };
    },
    dispatcher
  );
}
