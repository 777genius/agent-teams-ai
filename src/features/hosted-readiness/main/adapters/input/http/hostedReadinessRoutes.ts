import { HOSTED_READINESS_ROUTE } from '../../../../contracts';

import type { RouteDescriptor } from '@main/composition/hosted/routing';

const STATIC_READINESS = Object.freeze(['serve', 'auth'] as const);

export const HOSTED_READINESS_ROUTE_DESCRIPTORS = Object.freeze([
  Object.freeze({
    id: 'hosted-readiness.projection.v1',
    method: 'GET',
    path: HOSTED_READINESS_ROUTE,
    owner: 'hosted-readiness',
    trustKind: 'browser',
    authPolicyId: 'hosted.browser.session',
    readiness: STATIC_READINESS,
    requestSchemaId: 'hosted-readiness.projection.request.v1',
    responseSchemaId: 'hosted-readiness.projection.response.v1',
    handlerId: 'hosted-readiness.projection.handler.v1',
    clientId: 'hosted-readiness.projection.client.v1',
    semanticTestId: 'hosted-readiness.projection.semantic.v1',
    testOnly: false,
  } satisfies RouteDescriptor),
] satisfies readonly RouteDescriptor[]);
