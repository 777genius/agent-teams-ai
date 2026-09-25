import { HOSTED_DIAGNOSTICS_QUERY_ROUTE } from '../../../../contracts';

import type { RouteDescriptor } from '@main/composition/hosted/routing';

const READINESS = Object.freeze(['serve', 'auth', 'read'] as const);

export const HOSTED_DIAGNOSTICS_ROUTE_DESCRIPTORS = Object.freeze([
  Object.freeze({
    id: 'hosted-operations.diagnostics.v1',
    method: 'POST',
    path: HOSTED_DIAGNOSTICS_QUERY_ROUTE,
    owner: 'hosted-operations',
    trustKind: 'browser',
    authPolicyId: 'hosted.browser.session',
    readiness: READINESS,
    requestSchemaId: 'hosted-operations.diagnostics.request.v1',
    responseSchemaId: 'hosted-operations.diagnostics.response.v1',
    handlerId: 'hosted-operations.diagnostics.handler.v1',
    clientId: 'hosted-operations.diagnostics.client.v1',
    semanticTestId: 'hosted-operations.diagnostics.semantic.v1',
    testOnly: false,
  } satisfies RouteDescriptor),
] satisfies readonly RouteDescriptor[]);
