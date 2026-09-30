import { ExecuteHostedTaskMutation } from '../../core/application/use-cases/ExecuteHostedTaskMutation';
import { GetHostedTaskBoardPage } from '../../core/application/use-cases/GetHostedTaskBoardPage';
import {
  HOSTED_TEAM_TASK_BOARD_MUTATION_ROUTE_DESCRIPTORS,
  HOSTED_TEAM_TASK_BOARD_OBSERVE_CREATION_ROUTE_DESCRIPTORS,
  HOSTED_TEAM_TASK_BOARD_ROUTE_DESCRIPTORS,
} from '../adapters/input/http/hostedTaskBoardRoutes';

import type {
  HostedTaskCreationCommand,
  ObserveHostedTaskCreationResult,
} from '../../contracts/hosted';
import type {
  HostedTaskBoardClockPort,
  HostedTaskBoardPageSourcePort,
  HostedTaskMutationAdmissionPort,
} from '../../core/application/ports/HostedTeamTaskBoardPorts';
import type { HostedTeamTaskBoardHttpFacade } from '../adapters/input/http/registerHostedTeamTaskBoardHttp';
import type { HostedRouteContribution } from '@main/composition/hosted/application';
import type { RouteDescriptor } from '@main/composition/hosted/routing';
import type { QueryContext } from '@shared/contracts/hosted';

export interface HostedTeamTaskBoardFeature extends HostedTeamTaskBoardHttpFacade {
  readonly routes: readonly RouteDescriptor[];
}

export function createHostedTeamTaskBoardFeature(dependencies: {
  readonly pageSource: HostedTaskBoardPageSourcePort;
  readonly mutationAdmission?: HostedTaskMutationAdmissionPort;
  readonly observeTaskCreation?: (
    original: HostedTaskCreationCommand,
    context: QueryContext
  ) => Promise<ObserveHostedTaskCreationResult>;
  readonly clock?: HostedTaskBoardClockPort;
}): HostedTeamTaskBoardFeature {
  const clock = dependencies.clock ?? Object.freeze({ now: Date.now });
  const getPage = new GetHostedTaskBoardPage(dependencies.pageSource, clock);
  const executeMutation =
    dependencies.mutationAdmission === undefined
      ? undefined
      : new ExecuteHostedTaskMutation(dependencies.mutationAdmission);

  return Object.freeze({
    routes: Object.freeze([
      ...HOSTED_TEAM_TASK_BOARD_ROUTE_DESCRIPTORS,
      ...(dependencies.observeTaskCreation === undefined
        ? []
        : HOSTED_TEAM_TASK_BOARD_OBSERVE_CREATION_ROUTE_DESCRIPTORS),
      ...(executeMutation === undefined ? [] : HOSTED_TEAM_TASK_BOARD_MUTATION_ROUTE_DESCRIPTORS),
    ]),
    getPage: getPage.execute.bind(getPage),
    ...(dependencies.observeTaskCreation === undefined
      ? {}
      : { observeTaskCreation: dependencies.observeTaskCreation }),
    ...(executeMutation === undefined
      ? {}
      : { executeMutation: executeMutation.execute.bind(executeMutation) }),
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
