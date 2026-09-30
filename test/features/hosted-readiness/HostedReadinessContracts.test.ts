import {
  HOSTED_READINESS_DIMENSIONS,
  HOSTED_READINESS_SCHEMA_VERSION,
  MAX_HOSTED_READINESS_FACETS,
  parseHostedReadinessProjection,
} from '@features/hosted-readiness/contracts';
import { describe, expect, it, vi } from 'vitest';

function dimensions(status: 'ready' | 'not_ready' = 'ready') {
  return [...HOSTED_READINESS_DIMENSIONS].reverse().map((dimension) => ({
    dimension,
    status,
    reasons: status === 'ready' ? [] : ['dependency_unavailable', 'dependency_unavailable'],
  }));
}

function projection(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: HOSTED_READINESS_SCHEMA_VERSION,
    kind: 'success',
    deploymentId: 'deployment_contract',
    bootId: 'boot_contract',
    revision: 3,
    requiredReadiness: ['auth', 'serve', 'auth'],
    dimensions: dimensions(),
    terminal: { dimension: 'terminal', status: 'not_offered', reasons: [] },
    facets: [
      {
        facetId: 'team.read',
        availability: 'available',
        requiredReadiness: ['read', 'serve'],
        reasons: [],
      },
      {
        facetId: 'approvals',
        availability: 'temporarily_unavailable',
        requiredReadiness: ['auth', 'read'],
        reasons: ['provider_unavailable', 'provider_unavailable'],
      },
    ],
    actions: [
      {
        actionId: 'team.read.list',
        facetId: 'team.read',
        implementation: 'implemented',
        availability: 'available',
        requiredReadiness: ['read', 'serve'],
        reasons: [],
      },
      {
        actionId: 'approvals.answer',
        facetId: 'approvals',
        implementation: 'implemented',
        availability: 'temporarily_unavailable',
        requiredReadiness: ['auth', 'read'],
        reasons: ['provider_unavailable'],
      },
    ],
    ...overrides,
  };
}

describe('hosted readiness contracts', () => {
  it('normalizes the complete ADR-21 lattice with deterministic ordering and dedupe', () => {
    const parsed = parseHostedReadinessProjection(projection());

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.requiredReadiness).toEqual(['serve', 'auth']);
    expect(parsed.value.dimensions.map((item) => item.dimension)).toEqual(
      HOSTED_READINESS_DIMENSIONS
    );
    expect(parsed.value.facets.map((item) => item.facetId)).toEqual(['approvals', 'team.read']);
    expect(parsed.value.actions.map((item) => item.actionId)).toEqual([
      'approvals.answer',
      'team.read.list',
    ]);
    expect(parsed.value.facets[0]?.reasons).toEqual(['provider_unavailable']);
    expect(parsed.value.terminal).toEqual({
      dimension: 'terminal',
      status: 'not_offered',
      reasons: [],
    });
    expect(Object.isFrozen(parsed.value.actions)).toBe(true);
    expect(Object.isFrozen(parsed.value.actions[0])).toBe(true);
  });

  it('keeps implementation support separate from temporary availability', () => {
    const parsed = parseHostedReadinessProjection(projection());
    expect(parsed.ok && parsed.value.actions[0]?.implementation).toBe('implemented');
    expect(parsed.ok && parsed.value.actions[0]?.availability).toBe('temporarily_unavailable');

    const conflated = projection({
      actions: [
        {
          actionId: 'approvals.answer',
          facetId: 'approvals',
          implementation: 'not_implemented',
          availability: 'temporarily_unavailable',
          requiredReadiness: ['auth'],
          reasons: ['provider_unavailable'],
        },
      ],
    });
    expect(parseHostedReadinessProjection(conflated).ok).toBe(false);

    const explicit = projection({
      actions: [
        {
          actionId: 'approvals.answer',
          facetId: 'approvals',
          implementation: 'not_implemented',
          availability: 'not_offered',
          requiredReadiness: [],
          reasons: ['not_implemented'],
        },
      ],
    });
    expect(parseHostedReadinessProjection(explicit).ok).toBe(true);
  });

  it('rejects available facets and actions whose required dimensions are not ready', () => {
    const mutationNotReady = dimensions().map((item) =>
      item.dimension === 'mutation'
        ? { ...item, status: 'not_ready', reasons: ['mutation_unavailable'] }
        : item
    );
    const availableMutationFacet = {
      facetId: 'team.mutation',
      availability: 'available',
      requiredReadiness: ['mutation'],
      reasons: [],
    };

    expect(
      parseHostedReadinessProjection(
        projection({
          dimensions: mutationNotReady,
          facets: [availableMutationFacet],
          actions: [],
        })
      ).ok
    ).toBe(false);
    expect(
      parseHostedReadinessProjection(
        projection({
          dimensions: [...mutationNotReady].reverse(),
          facets: [
            {
              ...availableMutationFacet,
              requiredReadiness: [],
            },
          ],
          actions: [
            {
              actionId: 'team.mutation.update',
              facetId: 'team.mutation',
              implementation: 'implemented',
              availability: 'available',
              requiredReadiness: ['mutation'],
              reasons: [],
            },
          ],
        })
      ).ok
    ).toBe(false);
  });

  it('rejects available actions that exceed their owning facet availability', () => {
    expect(
      parseHostedReadinessProjection(
        projection({
          facets: [
            {
              facetId: 'team.mutation',
              availability: 'temporarily_unavailable',
              requiredReadiness: ['mutation'],
              reasons: ['mutation_unavailable'],
            },
          ],
          actions: [
            {
              actionId: 'team.mutation.update',
              facetId: 'team.mutation',
              implementation: 'implemented',
              availability: 'available',
              requiredReadiness: ['mutation'],
              reasons: [],
            },
          ],
        })
      ).ok
    ).toBe(false);
    expect(
      parseHostedReadinessProjection(
        projection({
          facets: [
            {
              facetId: 'team.mutation',
              availability: 'not_offered',
              requiredReadiness: ['mutation'],
              reasons: ['not_offered'],
            },
          ],
          actions: [
            {
              actionId: 'team.mutation.update',
              facetId: 'team.mutation',
              implementation: 'implemented',
              availability: 'available',
              requiredReadiness: ['mutation'],
              reasons: [],
            },
          ],
        })
      ).ok
    ).toBe(false);
  });

  it('rejects extra keys, prototype-bearing records, accessors and private diagnostics', () => {
    const getter = vi.fn(() => 'private-value');
    const withAccessor = projection();
    Object.defineProperty(withAccessor.facets[0], 'rawPath', { get: getter, enumerable: true });

    expect(parseHostedReadinessProjection(withAccessor).ok).toBe(false);
    expect(getter).not.toHaveBeenCalled();
    expect(parseHostedReadinessProjection(Object.assign(new Date(), projection())).ok).toBe(false);
    expect(
      parseHostedReadinessProjection({
        ...projection(),
        probeId: 'probe.private',
        checks: ['/private/path'],
      }).ok
    ).toBe(false);
  });

  it('requires every offered dimension and terminal exactly not_offered', () => {
    expect(
      parseHostedReadinessProjection(projection({ dimensions: dimensions().slice(1) })).ok
    ).toBe(false);
    expect(
      parseHostedReadinessProjection(
        projection({ terminal: { dimension: 'terminal', status: 'ready', reasons: [] } })
      ).ok
    ).toBe(false);
    expect(
      parseHostedReadinessProjection(
        projection({
          dimensions: dimensions().map((item) =>
            item.dimension === 'read' ? { ...item, status: 'not_ready', reasons: [] } : item
          ),
        })
      ).ok
    ).toBe(false);
  });

  it('bounds collection counts, identifiers and reason codes', () => {
    const facets = Array.from({ length: MAX_HOSTED_READINESS_FACETS + 1 }, (_, index) => ({
      facetId: `facet.${index}`,
      availability: 'available',
      requiredReadiness: [],
      reasons: [],
    }));
    expect(parseHostedReadinessProjection(projection({ facets, actions: [] })).ok).toBe(false);
    expect(
      parseHostedReadinessProjection(
        projection({
          facets: [
            {
              facetId: 'facet.safe',
              availability: 'temporarily_unavailable',
              requiredReadiness: [],
              reasons: ['hostname_internal_example'],
            },
          ],
          actions: [],
        })
      ).ok
    ).toBe(false);
    expect(
      parseHostedReadinessProjection(
        projection({
          facets: [
            {
              facetId: `facet.${'a'.repeat(100)}`,
              availability: 'available',
              requiredReadiness: [],
              reasons: [],
            },
          ],
          actions: [],
        })
      ).ok
    ).toBe(false);
  });
});
