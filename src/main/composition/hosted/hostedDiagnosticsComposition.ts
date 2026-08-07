// eslint-disable-next-line no-restricted-imports -- Hosted operations exposes a bounded server-only facet.
import {
  createHostedDiagnosticsAdapters,
  createHostedDiagnosticsFeature,
  createHostedDiagnosticsRouteContribution,
  type HostedDiagnosticsRecorderPort,
  registerHostedDiagnosticsHttp,
} from '@features/hosted-operations/main/hosted';
// eslint-disable-next-line no-restricted-imports -- Hosted query context exposes a bounded server-only facet.
import { createAuthenticatedHostedQueryContextFactory } from '@features/hosted-query-context/main/hosted';

import {
  HOSTED_READINESS_DIMENSIONS,
  HOSTED_TERMINAL_READINESS,
  HostedRouteAdmission,
} from './application';
import { createRouteCatalog } from './routing';

import type { HostedReadinessDimensionStates } from './application';
import type { HostedAuthenticatedPrincipal } from '@features/hosted-access';
import type { RuntimeInstanceContext } from '@features/runtime-instance-context/contracts';
import type { FastifyInstance } from 'fastify';

export interface HostedDiagnosticsComposition {
  readonly recorder: HostedDiagnosticsRecorderPort;
  register(app: FastifyInstance): void;
  close(): void;
}

export interface CreateHostedDiagnosticsCompositionDependencies {
  readonly authentication: {
    authenticatedPrincipalFor(request: object): HostedAuthenticatedPrincipal | null;
  };
  readonly runtimeInstance: RuntimeInstanceContext | null;
  readonly expectedDeploymentId: string;
  readonly routeAdmission?: HostedRouteAdmission;
}

function readyDimensions(): HostedReadinessDimensionStates {
  return Object.freeze({
    ...Object.fromEntries(
      HOSTED_READINESS_DIMENSIONS.map((dimension) => [
        dimension,
        Object.freeze({ dimension, status: 'ready' as const, reasons: Object.freeze([]) }),
      ])
    ),
    terminal: HOSTED_TERMINAL_READINESS,
  }) as HostedReadinessDimensionStates;
}

/** Owns only the bounded in-memory diagnostics adapters and their HTTP contribution. */
export function createHostedDiagnosticsComposition(
  dependencies: CreateHostedDiagnosticsCompositionDependencies
): HostedDiagnosticsComposition {
  if (
    dependencies.runtimeInstance !== null &&
    dependencies.runtimeInstance.deploymentId !== dependencies.expectedDeploymentId
  ) {
    throw new TypeError('hosted-diagnostics-deployment-binding-invalid');
  }

  const adapters = createHostedDiagnosticsAdapters();
  try {
    const queryContexts =
      dependencies.runtimeInstance === null
        ? null
        : createAuthenticatedHostedQueryContextFactory({
            authentication: Object.freeze({
              authenticatedPrincipalFor: (request: object) =>
                dependencies.authentication.authenticatedPrincipalFor(request),
            }),
            runtimeInstance: dependencies.runtimeInstance,
          });
    const feature = createHostedDiagnosticsFeature(adapters);
    const contribution = createHostedDiagnosticsRouteContribution(feature);
    const routeAdmission =
      dependencies.routeAdmission ??
      new HostedRouteAdmission(createRouteCatalog(contribution.routes, 'production'), {
        readiness: async () => Object.freeze({ revision: 0, dimensions: readyDimensions() }),
      });
    let closed = false;
    let registered = false;

    return Object.freeze({
      recorder: adapters.recorder,
      register(app: FastifyInstance): void {
        if (closed || registered) {
          throw new Error('hosted-diagnostics-http-composition-unavailable');
        }
        registered = true;
        registerHostedDiagnosticsHttp(
          app,
          contribution,
          routeAdmission,
          (_descriptor, request, signal) => {
            if (closed || queryContexts === null) {
              throw new Error('hosted-diagnostics-http-composition-unavailable');
            }
            const result = queryContexts.create(request, signal);
            if (result.kind !== 'success') {
              throw new Error(`hosted-diagnostics-query-context-${result.code}`);
            }
            return result.context;
          }
        );
      },
      close(): void {
        if (closed) return;
        closed = true;
        adapters.close();
      },
    });
  } catch (error) {
    adapters.close();
    throw error;
  }
}
