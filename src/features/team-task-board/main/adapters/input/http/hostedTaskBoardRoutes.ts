import type { RouteDescriptor } from '@main/composition/hosted/routing';

export const HOSTED_TASK_BOARD_PAGE_ROUTE = '/api/hosted/v1/team-task-board/page' as const;
export const HOSTED_TASK_BOARD_MUTATION_ROUTE = '/api/hosted/v1/team-task-board/mutations' as const;

const PAGE_READINESS = Object.freeze(['serve', 'auth', 'read'] as const);

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
