import type { RouteCatalog, RouteDescriptor } from '../routing';
import type {
  HostedReadinessDimension,
  HostedReadinessDimensionStates,
} from './HostedReadinessDimensions';

export const HOSTED_ROUTE_UNAVAILABLE_REASON = 'required_readiness_unavailable';
export const HOSTED_ROUTE_NOT_FOUND_DIAGNOSTIC = 'hosted-route-not-found';

export interface HostedRouteReadinessSource {
  readiness(): Promise<{
    readonly revision: number;
    readonly dimensions: HostedReadinessDimensionStates;
  }>;
}

export interface HostedRouteAdmissionGranted {
  readonly admitted: true;
  readonly routeId: string;
  readonly revision: number;
}

export interface HostedRouteAdmissionRejectionReason {
  readonly code: typeof HOSTED_ROUTE_UNAVAILABLE_REASON;
  readonly dimensions: readonly HostedReadinessDimension[];
}

export interface HostedRouteAdmissionRejected {
  readonly admitted: false;
  readonly routeId: string;
  readonly revision: number;
  readonly statusCode: 503;
  readonly reason: HostedRouteAdmissionRejectionReason;
}

export type HostedRouteAdmissionDecision =
  | HostedRouteAdmissionGranted
  | HostedRouteAdmissionRejected;

export type HostedRouteInvocation<TValue> =
  | (HostedRouteAdmissionGranted & {
      readonly value: TValue;
    })
  | HostedRouteAdmissionRejected;

export class HostedRouteNotFoundError extends Error {
  readonly routeId: string;

  constructor(routeId: string) {
    super(HOSTED_ROUTE_NOT_FOUND_DIAGNOSTIC);
    this.name = 'HostedRouteNotFoundError';
    this.routeId = routeId;
  }
}

function reject(
  routeId: string,
  revision: number,
  dimensions: readonly HostedReadinessDimension[]
): HostedRouteAdmissionRejected {
  return Object.freeze({
    admitted: false,
    routeId,
    revision,
    statusCode: 503,
    reason: Object.freeze({
      code: HOSTED_ROUTE_UNAVAILABLE_REASON,
      dimensions: Object.freeze([...dimensions]),
    }),
  });
}

function grant(routeId: string, revision: number): HostedRouteAdmissionGranted {
  return Object.freeze({
    admitted: true,
    routeId,
    revision,
  });
}

/**
 * Applies catalog-owned static requirements to one current readiness revision before a handler can
 * run. Dynamic resource policy remains the owning feature's separate responsibility.
 */
export class HostedRouteAdmission {
  private readonly routesById: ReadonlyMap<string, RouteDescriptor>;

  constructor(
    catalog: RouteCatalog,
    private readonly readinessSource: HostedRouteReadinessSource
  ) {
    this.routesById = new Map(catalog.routes.map((route) => [route.id, route]));
  }

  async admit(routeId: string): Promise<HostedRouteAdmissionDecision> {
    const route = this.getRoute(routeId);
    const snapshot = await this.readinessSource.readiness();
    const unavailableDimensions = route.readiness.filter(
      (dimension) => snapshot.dimensions[dimension].status !== 'ready'
    );

    return unavailableDimensions.length === 0
      ? grant(route.id, snapshot.revision)
      : reject(route.id, snapshot.revision, unavailableDimensions);
  }

  async invoke<TValue>(
    routeId: string,
    handler: () => TValue | Promise<TValue>
  ): Promise<HostedRouteInvocation<TValue>> {
    const decision = await this.admit(routeId);
    if (!decision.admitted) return decision;

    return Object.freeze({
      ...decision,
      value: await handler(),
    });
  }

  private getRoute(routeId: string): RouteDescriptor {
    const route = this.routesById.get(routeId);
    if (route === undefined) throw new HostedRouteNotFoundError(routeId);
    return route;
  }
}
