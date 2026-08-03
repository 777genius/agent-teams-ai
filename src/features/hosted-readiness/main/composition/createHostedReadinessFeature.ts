import { GetHostedReadinessProjection } from '../../core/application/GetHostedReadinessProjection';
import { HOSTED_READINESS_ROUTE_DESCRIPTORS } from '../adapters/input/http/hostedReadinessRoutes';

import type {
  HostedReadinessProjectionClockPort,
  HostedReadinessProjectionDeadlinePort,
  HostedReadinessProjectionSourcePort,
} from '../../core/application/ports/HostedReadinessProjectionPorts';
import type { HostedReadinessHttpFacade } from '../adapters/input/http/registerHostedReadinessHttp';
import type { HostedRouteContribution } from '@main/composition/hosted/application';
import type { QueryContext } from '@shared/contracts/hosted';

const SYSTEM_DEADLINE: HostedReadinessProjectionDeadlinePort = Object.freeze({
  schedule(delayMs: number, onDeadline: () => void) {
    const timer = setTimeout(onDeadline, delayMs);
    return () => clearTimeout(timer);
  },
});

export interface HostedReadinessFeature extends HostedReadinessHttpFacade {
  readonly routes: typeof HOSTED_READINESS_ROUTE_DESCRIPTORS;
}

export interface CreateHostedReadinessFeatureDependencies {
  readonly source: HostedReadinessProjectionSourcePort;
  readonly clock?: HostedReadinessProjectionClockPort;
  readonly deadline?: HostedReadinessProjectionDeadlinePort;
}

export function createHostedReadinessFeature(
  dependencies: CreateHostedReadinessFeatureDependencies
): HostedReadinessFeature {
  const useCase = new GetHostedReadinessProjection(
    dependencies.source,
    dependencies.deadline === undefined ? SYSTEM_DEADLINE : dependencies.deadline,
    dependencies.clock
  );
  return Object.freeze({
    routes: HOSTED_READINESS_ROUTE_DESCRIPTORS,
    getReadiness: (context: QueryContext) =>
      useCase.execute({
        deploymentId: context.deploymentId,
        bootId: context.bootId,
        deadlineAtMs: context.deadlineAtMs,
        signal: context.signal,
      }),
  });
}

export function createHostedReadinessRouteContribution(
  feature: HostedReadinessFeature
): HostedRouteContribution<HostedReadinessHttpFacade> {
  return Object.freeze({
    id: 'hosted-readiness.projection.hosted.v1',
    facade: feature,
    routes: feature.routes,
  });
}
