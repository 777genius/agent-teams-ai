// eslint-disable-next-line no-restricted-imports -- Main composition consumes bounded hosted facets.
import {
  type HostedDiagnosticsContextFactory,
  type HostedDiagnosticsHttpFacade,
  registerHostedDiagnosticsHttp,
} from '@features/hosted-operations/main/hosted';
// eslint-disable-next-line no-restricted-imports -- Main composition consumes a bounded hosted facet.
import {
  HOSTED_READINESS_ROUTE_DESCRIPTORS,
  type HostedReadinessContextFactory,
  type HostedReadinessHttpFacade,
  registerHostedReadinessHttp,
} from '@features/hosted-readiness/main/hosted';
// eslint-disable-next-line no-restricted-imports -- Main composition consumes bounded hosted facets.
import {
  type HostedMemberLogContextFactory,
  type HostedMemberLogHttpFacade,
  registerHostedMemberLogHttp,
} from '@features/member-log-stream/main/hosted';
// eslint-disable-next-line no-restricted-imports -- Main composition consumes bounded hosted facets.
import {
  type HostedTeamApprovalsContextFactory,
  type HostedTeamApprovalsHttpFacade,
  registerHostedTeamApprovalsHttp,
} from '@features/team-approvals/main/hosted';

import type { HostedRouteAdmission, HostedRouteContribution } from './application';
import type { FastifyInstance } from 'fastify';

interface OperatorRoute<TFacade, TContextFactory> {
  readonly contribution: HostedRouteContribution<TFacade>;
  readonly createContext: TContextFactory;
}

export interface CreateHostedOperatorSurfacesCompositionDependencies {
  readonly routeAdmission: HostedRouteAdmission;
  /** Readiness reports admission state, so it must remain callable without self-admission. */
  readonly readiness?: OperatorRoute<HostedReadinessHttpFacade, HostedReadinessContextFactory>;
  readonly memberLog?: OperatorRoute<HostedMemberLogHttpFacade, HostedMemberLogContextFactory>;
  readonly approvals?: OperatorRoute<
    HostedTeamApprovalsHttpFacade,
    HostedTeamApprovalsContextFactory
  >;
  readonly diagnostics?: OperatorRoute<
    HostedDiagnosticsHttpFacade,
    HostedDiagnosticsContextFactory
  >;
}

export interface HostedOperatorSurfacesComposition {
  register(app: FastifyInstance): void;
}

/** Registers only caller-supplied contributions; it owns no lifecycle or runtime process policy. */
export function createHostedOperatorSurfacesComposition(
  dependencies: CreateHostedOperatorSurfacesCompositionDependencies
): HostedOperatorSurfacesComposition {
  let registered = false;
  return Object.freeze({
    register(app: FastifyInstance): void {
      if (registered) throw new Error('hosted-operator-surfaces-already-registered');
      registered = true;
      if (dependencies.readiness !== undefined) {
        if (
          dependencies.readiness.contribution.id !== 'hosted-readiness.projection.hosted.v1' ||
          dependencies.readiness.contribution.routes.length !== 1 ||
          dependencies.readiness.contribution.routes[0] !== HOSTED_READINESS_ROUTE_DESCRIPTORS[0]
        ) {
          throw new TypeError('hosted-readiness-route-contribution-invalid');
        }
        registerHostedReadinessHttp(
          app,
          dependencies.readiness.contribution.facade,
          dependencies.readiness.createContext
        );
      }
      if (dependencies.memberLog !== undefined) {
        registerHostedMemberLogHttp(
          app,
          dependencies.memberLog.contribution,
          dependencies.routeAdmission,
          dependencies.memberLog.createContext
        );
      }
      if (dependencies.approvals !== undefined) {
        registerHostedTeamApprovalsHttp(
          app,
          dependencies.approvals.contribution,
          dependencies.routeAdmission,
          dependencies.approvals.createContext
        );
      }
      if (dependencies.diagnostics !== undefined) {
        registerHostedDiagnosticsHttp(
          app,
          dependencies.diagnostics.contribution,
          dependencies.routeAdmission,
          dependencies.diagnostics.createContext
        );
      }
    },
  });
}
