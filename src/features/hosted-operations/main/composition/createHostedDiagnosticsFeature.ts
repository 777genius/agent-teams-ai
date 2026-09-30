import { DiagnosticContextService } from '../../core/application/DiagnosticContextService';
import { GetBoundedHostedDiagnostics } from '../../core/application/GetBoundedHostedDiagnostics';
import { HOSTED_DIAGNOSTICS_ROUTE_DESCRIPTORS } from '../adapters/input/http/hostedDiagnosticsRoutes';

import type { DiagnosticIdGeneratorPort } from '../../core/application/ports';
import type {
  HostedDiagnosticsCorrelationIdPort,
  HostedDiagnosticsDeadlineSchedulerPort,
  HostedDiagnosticsSourcePort,
} from '../../core/application/ports/HostedDiagnosticsPorts';
import type { HostedDiagnosticsHttpFacade } from '../adapters/input/http/registerHostedDiagnosticsHttp';
import type { HostedRouteContribution } from '@main/composition/hosted/application';

export interface HostedDiagnosticsFeature extends HostedDiagnosticsHttpFacade {
  readonly routes: typeof HOSTED_DIAGNOSTICS_ROUTE_DESCRIPTORS;
}

export interface CreateHostedDiagnosticsFeatureDependencies {
  readonly source: HostedDiagnosticsSourcePort;
  readonly diagnosticIds: DiagnosticIdGeneratorPort;
  readonly correlationIds: HostedDiagnosticsCorrelationIdPort;
  readonly deadlineScheduler: HostedDiagnosticsDeadlineSchedulerPort;
}

export function createHostedDiagnosticsFeature(
  dependencies: CreateHostedDiagnosticsFeatureDependencies
): HostedDiagnosticsFeature {
  const useCase = new GetBoundedHostedDiagnostics(
    dependencies.source,
    new DiagnosticContextService(dependencies.diagnosticIds),
    dependencies.correlationIds,
    dependencies.deadlineScheduler
  );
  return Object.freeze({
    routes: HOSTED_DIAGNOSTICS_ROUTE_DESCRIPTORS,
    getDiagnostics: useCase.execute.bind(useCase),
  });
}

export function createHostedDiagnosticsRouteContribution(
  feature: HostedDiagnosticsFeature
): HostedRouteContribution<HostedDiagnosticsHttpFacade> {
  return Object.freeze({
    id: 'hosted-operations.diagnostics.hosted.v1',
    facade: feature,
    routes: feature.routes,
  });
}
