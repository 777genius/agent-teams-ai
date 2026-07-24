import {
  createRouteCatalog,
  type RouteCatalog,
  type RouteCatalogScope,
  type RouteDescriptor,
} from '../routing';

export type HostedRouteConflictKind = 'facade-id' | 'method-path' | 'route-id';

export class HostedRouteConflictError extends Error {
  readonly kind: HostedRouteConflictKind;
  readonly key: string;

  constructor(kind: HostedRouteConflictKind, key: string) {
    super(`Duplicate hosted route assembly ${kind}: ${key}`);
    this.name = 'HostedRouteConflictError';
    this.kind = kind;
    this.key = key;
  }
}

export interface HostedRouteContribution<TFacade = unknown> {
  readonly id: string;
  readonly facade: TFacade;
  readonly routes: readonly RouteDescriptor[];
}

export interface HostedFacadeBinding<TFacade = unknown> {
  readonly id: string;
  readonly facade: TFacade;
}

export interface HostedRouteAssembly<TFacade = unknown> {
  readonly catalog: RouteCatalog;
  readonly facades: readonly HostedFacadeBinding<TFacade>[];
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareRoutes(left: RouteDescriptor, right: RouteDescriptor): number {
  return (
    compareText(left.id, right.id) ||
    compareText(left.method, right.method) ||
    compareText(left.path, right.path)
  );
}

/** Builds immutable, deterministic route and facade views from explicitly supplied features. */
export function assembleHostedRoutes<TFacade>(
  contributions: readonly HostedRouteContribution<TFacade>[],
  scope: RouteCatalogScope = 'production'
): HostedRouteAssembly<TFacade> {
  const facadeIds = new Set<string>();
  const routeIds = new Set<string>();
  const methodPaths = new Set<string>();
  const routes: RouteDescriptor[] = [];

  for (const contribution of contributions) {
    if (facadeIds.has(contribution.id)) {
      throw new HostedRouteConflictError('facade-id', contribution.id);
    }
    facadeIds.add(contribution.id);

    for (const route of contribution.routes) {
      if (routeIds.has(route.id)) throw new HostedRouteConflictError('route-id', route.id);
      routeIds.add(route.id);

      const methodPath = `${route.method} ${route.path}`;
      if (methodPaths.has(methodPath)) {
        throw new HostedRouteConflictError('method-path', methodPath);
      }
      methodPaths.add(methodPath);
      routes.push(route);
    }
  }

  const facades = contributions
    .map(({ facade, id }) => Object.freeze({ facade, id }))
    .sort((left, right) => compareText(left.id, right.id));
  const catalog = createRouteCatalog([...routes].sort(compareRoutes), scope);

  return Object.freeze({
    catalog,
    facades: Object.freeze(facades),
  });
}
