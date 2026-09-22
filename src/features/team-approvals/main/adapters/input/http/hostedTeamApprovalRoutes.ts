import {
  HOSTED_TEAM_APPROVAL_DECISION_ROUTE,
  HOSTED_TEAM_APPROVAL_PAGE_ROUTE,
  HOSTED_TEAM_APPROVAL_PREVIEW_ROUTE,
} from '../../../../contracts/hosted';

import type { RouteDescriptor } from '@main/composition/hosted/routing';

export {
  HOSTED_TEAM_APPROVAL_DECISION_ROUTE,
  HOSTED_TEAM_APPROVAL_PAGE_ROUTE,
  HOSTED_TEAM_APPROVAL_PREVIEW_ROUTE,
};

const READ_READINESS = Object.freeze(['serve', 'auth', 'read'] as const);
const DECISION_READINESS = Object.freeze(['serve', 'auth', 'mutation'] as const);

export const HOSTED_TEAM_APPROVAL_ROUTE_DESCRIPTORS = Object.freeze([
  Object.freeze({
    id: 'team-approvals.page.v1',
    method: 'POST',
    path: HOSTED_TEAM_APPROVAL_PAGE_ROUTE,
    owner: 'team-approvals',
    trustKind: 'browser',
    authPolicyId: 'hosted.browser.session',
    readiness: READ_READINESS,
    requestSchemaId: 'team-approvals.page.request.v1',
    responseSchemaId: 'team-approvals.page.response.v1',
    handlerId: 'team-approvals.page.handler.v1',
    clientId: 'team-approvals.page.client.v1',
    semanticTestId: 'team-approvals.page.semantic.v1',
    testOnly: false,
  } satisfies RouteDescriptor),
  Object.freeze({
    id: 'team-approvals.preview.v1',
    method: 'POST',
    path: HOSTED_TEAM_APPROVAL_PREVIEW_ROUTE,
    owner: 'team-approvals',
    trustKind: 'browser',
    authPolicyId: 'hosted.browser.session',
    readiness: READ_READINESS,
    requestSchemaId: 'team-approvals.preview.request.v1',
    responseSchemaId: 'team-approvals.preview.response.v1',
    handlerId: 'team-approvals.preview.handler.v1',
    clientId: 'team-approvals.preview.client.v1',
    semanticTestId: 'team-approvals.preview.semantic.v1',
    testOnly: false,
  } satisfies RouteDescriptor),
  Object.freeze({
    id: 'team-approvals.decision.v1',
    method: 'POST',
    path: HOSTED_TEAM_APPROVAL_DECISION_ROUTE,
    owner: 'team-approvals',
    trustKind: 'browser',
    authPolicyId: 'hosted.browser.session',
    readiness: DECISION_READINESS,
    requestSchemaId: 'team-approvals.decision.request.v1',
    responseSchemaId: 'team-approvals.decision.response.v1',
    handlerId: 'team-approvals.decision.handler.v1',
    clientId: 'team-approvals.decision.client.v1',
    semanticTestId: 'team-approvals.decision.semantic.v1',
    testOnly: false,
  } satisfies RouteDescriptor),
] satisfies readonly RouteDescriptor[]);
