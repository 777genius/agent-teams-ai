import { HOSTED_TEAM_CONFIGURATION_ROUTES } from '../../../../contracts/hosted';

import type { RouteDescriptor } from '@main/composition/hosted/routing';

const READ_READINESS = Object.freeze(['serve', 'auth', 'read'] as const);
const MUTATION_READINESS = Object.freeze(['serve', 'auth', 'mutation'] as const);
const MUTATION_REFERENCES = Object.freeze({
  createDraft: 'create-draft',
  updateDraft: 'update-draft',
  deleteDraft: 'delete-draft',
} as const);

export const HOSTED_TEAM_CONFIGURATION_ROUTE_DESCRIPTORS = Object.freeze([
  Object.freeze({
    id: 'team-configuration.saved-request.v1',
    method: 'POST',
    path: HOSTED_TEAM_CONFIGURATION_ROUTES.getSavedRequest,
    owner: 'team-configuration',
    trustKind: 'browser',
    authPolicyId: 'hosted.browser.session',
    readiness: READ_READINESS,
    requestSchemaId: 'team-configuration.saved-request.request.v1',
    responseSchemaId: 'team-configuration.saved-request.response.v1',
    handlerId: 'team-configuration.saved-request.handler.v1',
    clientId: 'team-configuration.saved-request.client.v1',
    semanticTestId: 'team-configuration.saved-request.semantic.v1',
    testOnly: false,
  }),
  ...(['createDraft', 'updateDraft', 'deleteDraft'] as const).map((operation): RouteDescriptor => {
    const reference = MUTATION_REFERENCES[operation];
    return Object.freeze({
      id: `team-configuration.${reference}.v1`,
      method: 'POST',
      path: HOSTED_TEAM_CONFIGURATION_ROUTES[operation],
      owner: 'team-configuration',
      trustKind: 'browser',
      authPolicyId: 'hosted.browser.session.csrf',
      readiness: MUTATION_READINESS,
      requestSchemaId: `team-configuration.${reference}.request.v1`,
      responseSchemaId: `team-configuration.${reference}.response.v1`,
      handlerId: `team-configuration.${reference}.handler.v1`,
      clientId: `team-configuration.${reference}.client.v1`,
      semanticTestId: `team-configuration.${reference}.semantic.v1`,
      testOnly: false,
    });
  }),
] satisfies readonly RouteDescriptor[]);
