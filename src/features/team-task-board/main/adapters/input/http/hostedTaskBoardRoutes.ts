import {
  HOSTED_TASK_BOARD_MUTATION_ROUTE,
  HOSTED_TASK_BOARD_PAGE_ROUTE,
} from '../../../../contracts/hosted';

import type { RouteDescriptor } from '@main/composition/hosted/routing';

export { HOSTED_TASK_BOARD_MUTATION_ROUTE, HOSTED_TASK_BOARD_PAGE_ROUTE };

const PAGE_READINESS = Object.freeze(['serve', 'auth', 'read'] as const);
const MUTATION_READINESS = Object.freeze(['serve', 'auth', 'mutation'] as const);

export const HOSTED_TEAM_TASK_BOARD_ROUTE_DESCRIPTORS = Object.freeze([
  Object.freeze({
    id: 'team-task-board.page.v1',
    method: 'POST',
    path: HOSTED_TASK_BOARD_PAGE_ROUTE,
    owner: 'team-task-board',
    trustKind: 'browser',
    authPolicyId: 'hosted.browser.session',
    readiness: PAGE_READINESS,
    requestSchemaId: 'team-task-board.page.request.v1',
    responseSchemaId: 'team-task-board.page.response.v1',
    handlerId: 'team-task-board.page.handler.v1',
    clientId: 'team-task-board.page.client.v1',
    semanticTestId: 'team-task-board.page.semantic.v1',
    testOnly: false,
  } satisfies RouteDescriptor),
] satisfies readonly RouteDescriptor[]);

export const HOSTED_TEAM_TASK_BOARD_MUTATION_ROUTE_DESCRIPTORS = Object.freeze([
  Object.freeze({
    id: 'team-task-board.mutation.v1',
    method: 'POST',
    path: HOSTED_TASK_BOARD_MUTATION_ROUTE,
    owner: 'team-task-board',
    trustKind: 'browser',
    authPolicyId: 'hosted.browser.session.csrf',
    readiness: MUTATION_READINESS,
    requestSchemaId: 'team-task-board.mutation.request.v1',
    responseSchemaId: 'team-task-board.mutation.response.v1',
    handlerId: 'team-task-board.mutation.handler.v1',
    clientId: 'team-task-board.mutation.client.v1',
    semanticTestId: 'team-task-board.mutation.semantic.v1',
    testOnly: false,
  } satisfies RouteDescriptor),
] satisfies readonly RouteDescriptor[]);
