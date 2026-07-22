import {
  HostedLifecycle,
  type HostedLifecycleComponent,
  type HostedLifecycleState,
} from './HostedLifecycle';
import {
  HostedReadiness,
  type HostedReadinessCheck,
  type HostedReadinessReport,
} from './HostedReadiness';
import {
  assembleHostedRoutes,
  type HostedFacadeBinding,
  type HostedRouteContribution,
} from './HostedRouteAssembly';

import type { RouteCatalog, RouteCatalogScope } from '../routing';

export interface HostedApplicationDependencies<TFacade = unknown> {
  readonly components: readonly HostedLifecycleComponent[];
  readonly routeContributions: readonly HostedRouteContribution<TFacade>[];
  readonly routeScope?: RouteCatalogScope;
}

export interface HostedApplicationReadiness extends HostedReadinessReport {
  readonly lifecycleState: HostedLifecycleState;
}

const NO_READINESS_CHECKS: readonly HostedReadinessCheck[] = Object.freeze([]);

/** Feature-neutral hosted shell composed only from caller-owned ports. */
export class HostedApplication<TFacade = unknown> {
  readonly routeCatalog: RouteCatalog;
  readonly facades: readonly HostedFacadeBinding<TFacade>[];

  private readonly lifecycle: HostedLifecycle;
  private readonly readinessCoordinator: HostedReadiness;

  constructor(dependencies: HostedApplicationDependencies<TFacade>) {
    this.lifecycle = new HostedLifecycle(dependencies.components);
    this.readinessCoordinator = new HostedReadiness(dependencies.components);

    const routeAssembly = assembleHostedRoutes(
      dependencies.routeContributions,
      dependencies.routeScope
    );
    this.routeCatalog = routeAssembly.catalog;
    this.facades = routeAssembly.facades;
  }

  start(): Promise<void> {
    return this.lifecycle.start();
  }

  async readiness(): Promise<HostedApplicationReadiness> {
    const beforeReadiness = this.lifecycle.snapshot();
    if (beforeReadiness.state !== 'started') {
      return Object.freeze({
        ready: false,
        lifecycleState: beforeReadiness.state,
        checks: NO_READINESS_CHECKS,
      });
    }

    const report = await this.readinessCoordinator.readiness();
    const afterReadiness = this.lifecycle.snapshot();
    if (
      afterReadiness.state !== 'started' ||
      afterReadiness.generation !== beforeReadiness.generation
    ) {
      return Object.freeze({
        ready: false,
        lifecycleState: afterReadiness.state,
        checks: NO_READINESS_CHECKS,
      });
    }

    return Object.freeze({
      ready: report.ready,
      lifecycleState: afterReadiness.state,
      checks: report.checks,
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
