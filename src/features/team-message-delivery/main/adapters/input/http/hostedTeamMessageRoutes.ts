import {
  HOSTED_TEAM_MESSAGE_PAGE_HTTP_PATH as HOSTED_TEAM_MESSAGE_PAGE_ROUTE,
  HOSTED_TEAM_MESSAGE_SEND_HTTP_PATH as HOSTED_TEAM_MESSAGE_SEND_ROUTE,
} from '../../../../contracts/hosted';

import type { RouteDescriptor } from '@main/composition/hosted/routing';

export { HOSTED_TEAM_MESSAGE_PAGE_ROUTE, HOSTED_TEAM_MESSAGE_SEND_ROUTE };

const PAGE_READINESS = Object.freeze(['serve', 'auth', 'read'] as const);
const SEND_READINESS = Object.freeze(['serve', 'auth', 'mutation'] as const);

export const HOSTED_TEAM_MESSAGE_ROUTE_DESCRIPTORS = Object.freeze([
  Object.freeze({
    id: 'team-messages.page.v1',
    method: 'POST',
    path: HOSTED_TEAM_MESSAGE_PAGE_ROUTE,
    owner: 'team-message-delivery',
    trustKind: 'browser',
    authPolicyId: 'hosted.browser.session',
    readiness: PAGE_READINESS,
    requestSchemaId: 'team-messages.page.request.v1',
    responseSchemaId: 'team-messages.page.response.v1',
    handlerId: 'team-messages.page.handler.v1',
    clientId: 'team-messages.page.client.v1',
    semanticTestId: 'team-messages.page.semantic.v1',
    testOnly: false,
  } satisfies RouteDescriptor),
  Object.freeze({
    id: 'team-messages.send.v1',
    method: 'POST',
    path: HOSTED_TEAM_MESSAGE_SEND_ROUTE,
    owner: 'team-message-delivery',
    trustKind: 'browser',
    authPolicyId: 'hosted.browser.session',
    readiness: SEND_READINESS,
    requestSchemaId: 'team-messages.send.request.v1',
    responseSchemaId: 'team-messages.send.response.v1',
    handlerId: 'team-messages.send.handler.v1',
    clientId: 'team-messages.send.client.v1',
    semanticTestId: 'team-messages.send.semantic.v1',
    testOnly: false,
  } satisfies RouteDescriptor),
] satisfies readonly RouteDescriptor[]);
