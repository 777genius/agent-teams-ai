import { HOSTED_MEMBER_LOG_PAGE_HTTP_PATH } from '../../contracts/hosted';
import { GetHostedMemberLogPageUseCase } from '../../core/application/use-cases/GetHostedMemberLogPageUseCase';
import {
  HOSTED_MEMBER_LOG_PAGE_ROUTE,
  type HostedMemberLogHttpFacade,
} from '../adapters/input/http/registerHostedMemberLogHttp';

import type {
  HostedMemberLogAuthorityPort,
  HostedMemberLogClockPort,
} from '../../core/application/ports/HostedMemberLogPorts';
import type { HostedRouteContribution } from '@main/composition/hosted/application';
import type { RouteDescriptor } from '@main/composition/hosted/routing';

const READINESS = Object.freeze(['serve', 'auth', 'read'] as const);

export const HOSTED_MEMBER_LOG_ROUTE_DESCRIPTORS = Object.freeze([
  Object.freeze({
    id: 'member-log.page.v1',
    method: 'POST',
    path: HOSTED_MEMBER_LOG_PAGE_HTTP_PATH,
    owner: 'member-log-stream',
    trustKind: 'browser',
    authPolicyId: 'hosted.browser.session',
    readiness: READINESS,
    requestSchemaId: 'member-log.page.request.v1',
    responseSchemaId: 'member-log.page.response.v1',
    handlerId: 'member-log.page.handler.v1',
    clientId: 'member-log.page.client.v1',
    semanticTestId: 'member-log.page.semantic.v1',
    testOnly: false,
  } satisfies RouteDescriptor),
] satisfies readonly RouteDescriptor[]);

export interface HostedMemberLogFeature extends HostedMemberLogHttpFacade {
  readonly routes: typeof HOSTED_MEMBER_LOG_ROUTE_DESCRIPTORS;
}

export function createHostedMemberLogFeature(dependencies: {
  /** The host must supply the production-trusted authority, never a raw member-log reader. */
  readonly authority: HostedMemberLogAuthorityPort;
  readonly clock?: HostedMemberLogClockPort;
}): HostedMemberLogFeature {
  const clock = dependencies.clock ?? Object.freeze({ now: Date.now });
  const getPage = new GetHostedMemberLogPageUseCase(dependencies.authority, clock);
  return Object.freeze({
    routes: HOSTED_MEMBER_LOG_ROUTE_DESCRIPTORS,
    getPage: getPage.execute.bind(getPage),
  });
}

/** Deliberately returns an unmounted contribution; central hosted composition owns admission. */
export function createHostedMemberLogRouteContribution(
  feature: HostedMemberLogFeature
): HostedRouteContribution<HostedMemberLogHttpFacade> {
  return Object.freeze({
    id: 'member-log-stream.hosted.v1',
    facade: feature,
    routes: feature.routes,
  });
}

export { HOSTED_MEMBER_LOG_PAGE_ROUTE };
