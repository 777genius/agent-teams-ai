import {
  HostedLifecycle,
  type HostedLifecycleComponent,
  type HostedLifecycleState,
} from './HostedLifecycle';
import {
  type HostedDimensionReadinessProbe,
  HostedReadiness,
  type HostedReadinessReport,
} from './HostedReadiness';
import { HostedRouteAdmission } from './HostedRouteAdmission';
import {
  assembleHostedRoutes,
  type HostedFacadeBinding,
  type HostedRouteContribution,
} from './HostedRouteAssembly';

import type { RouteCatalog, RouteCatalogScope } from '../routing';

export interface HostedApplicationDependencies<TFacade = unknown> {
  readonly components: readonly HostedLifecycleComponent[];
  readonly readinessProbes: readonly HostedDimensionReadinessProbe[];
  readonly routeContributions: readonly HostedRouteContribution<TFacade>[];
  readonly routeScope?: RouteCatalogScope;
}

export interface HostedApplicationReadiness extends HostedReadinessReport {
  readonly lifecycleState: HostedLifecycleState;
}

export const HOSTED_APPLICATION_INACTIVE_REASON = 'application_lifecycle_inactive';

/** Feature-neutral hosted shell composed only from caller-owned ports. */
export class HostedApplication<TFacade = unknown> {
  readonly routeCatalog: RouteCatalog;
  readonly routeAdmission: HostedRouteAdmission;
  readonly facades: readonly HostedFacadeBinding<TFacade>[];

  private readonly lifecycle: HostedLifecycle;
  private readonly readinessCoordinator: HostedReadiness;

  constructor(dependencies: HostedApplicationDependencies<TFacade>) {
    this.lifecycle = new HostedLifecycle(dependencies.components);
    this.readinessCoordinator = new HostedReadiness(dependencies.readinessProbes);

    const routeAssembly = assembleHostedRoutes(
      dependencies.routeContributions,
      dependencies.routeScope
    );
    this.routeCatalog = routeAssembly.catalog;
    this.facades = routeAssembly.facades;
    this.routeAdmission = new HostedRouteAdmission(this.routeCatalog, {
      readiness: () => this.readiness(),
    });
  }

  start(): Promise<void> {
    return this.lifecycle.start();
  }

  async readiness(): Promise<HostedApplicationReadiness> {
    const beforeReadiness = this.lifecycle.snapshot();
    if (beforeReadiness.state !== 'started') {
      const report = await this.readinessCoordinator.unavailable(
        HOSTED_APPLICATION_INACTIVE_REASON
      );
      return Object.freeze({
        ...report,
        lifecycleState: beforeReadiness.state,
      });
    }

    const report = await this.readinessCoordinator.readiness({
      generation: beforeReadiness.generation,
      isCurrent: (generation) => {
        const snapshot = this.lifecycle.snapshot();
        return snapshot.state === 'started' && snapshot.generation === generation;
      },
      staleReason: HOSTED_APPLICATION_INACTIVE_REASON,
    });
    const afterReadiness = this.lifecycle.snapshot();
    return Object.freeze({
      ...report,
      lifecycleState: afterReadiness.state,
    });
  }

  stop(): Promise<void> {
    return this.lifecycle.stop();
  }
}

export function createHostedApplication<TFacade = unknown>(
  dependencies: HostedApplicationDependencies<TFacade>
): HostedApplication<TFacade> {
  return new HostedApplication(dependencies);
}
