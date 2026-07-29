import { ExecuteHostedTaskMutation } from '../../core/application/use-cases/ExecuteHostedTaskMutation';
import { GetHostedTaskBoardPage } from '../../core/application/use-cases/GetHostedTaskBoardPage';
import { HOSTED_TEAM_TASK_BOARD_ROUTE_DESCRIPTORS } from '../adapters/input/http/hostedTaskBoardRoutes';

import type {
  HostedTaskBoardClockPort,
  HostedTaskBoardPageSourcePort,
  HostedTaskMutationAdmissionPort,
} from '../../core/application/ports/HostedTeamTaskBoardPorts';
import type { HostedTeamTaskBoardHttpFacade } from '../adapters/input/http/registerHostedTeamTaskBoardHttp';
import type { HostedRouteContribution } from '@main/composition/hosted/application';

export interface HostedTeamTaskBoardFeature extends HostedTeamTaskBoardHttpFacade {
  readonly routes: typeof HOSTED_TEAM_TASK_BOARD_ROUTE_DESCRIPTORS;
}

export function createHostedTeamTaskBoardFeature(dependencies: {
  readonly pageSource: HostedTaskBoardPageSourcePort;
  readonly mutationAdmission: HostedTaskMutationAdmissionPort;
  readonly clock?: HostedTaskBoardClockPort;
}): HostedTeamTaskBoardFeature {
  const clock = dependencies.clock ?? Object.freeze({ now: Date.now });
  const getPage = new GetHostedTaskBoardPage(dependencies.pageSource, clock);
  const executeMutation = new ExecuteHostedTaskMutation(dependencies.mutationAdmission);

  return Object.freeze({
    routes: HOSTED_TEAM_TASK_BOARD_ROUTE_DESCRIPTORS,
    getPage: getPage.execute.bind(getPage),
    executeMutation: executeMutation.execute.bind(executeMutation),
  });
}

export function createHostedTeamTaskBoardRouteContribution(
  feature: HostedTeamTaskBoardFeature
): HostedRouteContribution<HostedTeamTaskBoardHttpFacade> {
  return Object.freeze({
    id: 'team-task-board.hosted.v1',
    facade: feature,
    routes: feature.routes,
  });
}
