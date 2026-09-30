import { type HostedReadinessProjection, parseHostedReadinessProjection } from '../../contracts';

export type HostedReadinessBannerState = 'ready' | 'degraded' | 'not_offered';

export type HostedReadinessFreshnessDecision =
  | 'accept'
  | 'stale_deployment'
  | 'stale_boot'
  | 'stale_revision'
  | 'revision_conflict';

export class HostedReadinessProjectionPolicyError extends Error {
  readonly code: 'source_invalid';

  constructor() {
    super('hosted-readiness-projection-source-invalid');
    this.name = 'HostedReadinessProjectionPolicyError';
    this.code = 'source_invalid';
  }
}

/** Reduces hostile source data to the exact browser-safe readiness contract. */
export function normalizeHostedReadinessProjection(value: unknown): HostedReadinessProjection {
  const parsed = parseHostedReadinessProjection(value);
  if (!parsed.ok) throw new HostedReadinessProjectionPolicyError();
  return parsed.value;
}

export function compareHostedReadinessFreshness(
  previous: HostedReadinessProjection | undefined,
  incoming: HostedReadinessProjection
): HostedReadinessFreshnessDecision {
  if (!previous) return 'accept';
  if (incoming.deploymentId !== previous.deploymentId) return 'stale_deployment';
  if (incoming.bootId !== previous.bootId) return 'stale_boot';
  if (incoming.revision < previous.revision) return 'stale_revision';
  if (
    incoming.revision === previous.revision &&
    JSON.stringify(incoming) !== JSON.stringify(previous)
  ) {
    return 'revision_conflict';
  }
  return 'accept';
}

export function deriveHostedReadinessBannerState(
  projection: HostedReadinessProjection
): HostedReadinessBannerState {
  const dimensions = new Map(
    projection.dimensions.map((dimension) => [dimension.dimension, dimension.status])
  );
  if (projection.requiredReadiness.some((dimension) => dimensions.get(dimension) !== 'ready')) {
    return 'degraded';
  }

  const offeredFacets = projection.facets.filter((facet) => facet.availability !== 'not_offered');
  const implementedActions = projection.actions.filter(
    (action) => action.implementation === 'implemented'
  );
  if (offeredFacets.length === 0 && implementedActions.length === 0) return 'not_offered';

  if (
    offeredFacets.some((facet) => facet.availability === 'temporarily_unavailable') ||
    implementedActions.some((action) => action.availability === 'temporarily_unavailable')
  ) {
    return 'degraded';
  }
  return 'ready';
}
