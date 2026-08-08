import type { RouteDescriptor } from '@main/composition/hosted/routing';

export const validRoute = Object.freeze({
  id: 'team-lifecycle.list-summaries.v1',
  method: 'GET',
  path: '/api/v1/team-lifecycle/teams',
  owner: 'team-lifecycle',
  trustKind: 'browser',
  authPolicyId: 'browser.session.read',
  readiness: Object.freeze(['serve', 'auth', 'read']),
  requestSchemaId: 'team-lifecycle.list.request.v1',
  responseSchemaId: 'team-lifecycle.list.response.v1',
  handlerId: 'team-lifecycle.list.handler.v1',
  clientId: 'team-lifecycle.list.client.v1',
  semanticTestId: 'team-lifecycle.list.semantic.v1',
  testOnly: true,
  capabilityId: 'team-lifecycle.list.capability.v1',
} satisfies RouteDescriptor);

export const adjacentValidRoute = Object.freeze({
  ...validRoute,
  id: 'team-lifecycle.list-summaries-health.v1',
  method: 'HEAD',
  path: '/api/v1/team-lifecycle/teams/health',
  trustKind: 'health',
  authPolicyId: 'health.read',
  handlerId: 'team-lifecycle.health.handler.v1',
  clientId: 'team-lifecycle.health.client.v1',
  semanticTestId: 'team-lifecycle.health.semantic.v1',
  capabilityId: undefined,
} satisfies RouteDescriptor);

export const duplicateRoute = Object.freeze({
  ...validRoute,
} satisfies RouteDescriptor);
