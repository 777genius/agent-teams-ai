import type { GraphParticle } from '../ports/types';

const MIN_PARTICLE_BUDGET = 120;
const MAX_PARTICLE_BUDGET = 360;
const FOCUSED_MIN_BUDGET = 180;

export function computeAdaptiveParticleBudget(params: {
  visibleNodeCount: number;
  visibleEdgeCount: number;
  frameTimeMs: number;
  hasFocusedEdges: boolean;
  zoom?: number;
}): number {
  const baseBudget = Math.max(
    MIN_PARTICLE_BUDGET,
    Math.min(MAX_PARTICLE_BUDGET, 48 + params.visibleNodeCount * 3 + params.visibleEdgeCount * 2)
  );

  let adjustedBudget = baseBudget;
  if ((params.zoom ?? 1) < 0.18) {
    adjustedBudget = Math.floor(adjustedBudget * 0.45);
  } else if ((params.zoom ?? 1) < 0.24) {
    adjustedBudget = Math.floor(adjustedBudget * 0.7);
  }

  if (params.frameTimeMs >= 24) {
    adjustedBudget = Math.floor(adjustedBudget * 0.55);
  } else if (params.frameTimeMs >= 18) {
    adjustedBudget = Math.floor(adjustedBudget * 0.72);
  } else if (params.frameTimeMs >= 14) {
    adjustedBudget = Math.floor(adjustedBudget * 0.88);
  }

  if (params.hasFocusedEdges) {
    adjustedBudget = Math.max(adjustedBudget, FOCUSED_MIN_BUDGET);
  }

  return Math.max(48, adjustedBudget);
}

function sampleEvenly<T>(items: T[], limit: number): T[] {
  if (items.length <= limit) {
    return items;
  }
  if (limit <= 0) {
    return [];
  }

  const sampled: T[] = [];
  for (let index = 0; index < limit; index += 1) {
    const itemIndex = Math.min(items.length - 1, Math.floor((index * items.length) / limit));
    sampled.push(items[itemIndex]);
  }
  return sampled;
}

export function selectRenderableParticles(params: {
  particles: GraphParticle[];
  visibleEdgeIds: ReadonlySet<string>;
  focusEdgeIds?: ReadonlySet<string> | null;
  budget: number;
}): GraphParticle[] {
  const visibleParticles = params.particles.filter(
    (particle) =>
      params.visibleEdgeIds.has(particle.edgeId) ||
      (params.focusEdgeIds?.has(particle.edgeId) ?? false)
  );
  if (visibleParticles.length <= params.budget) {
    return visibleParticles;
  }

  const indexed = visibleParticles.map((particle, index) => ({ particle, index }));
  const focused = params.focusEdgeIds
    ? indexed.filter(({ particle }) => params.focusEdgeIds?.has(particle.edgeId))
    : [];
  const nonFocused =
    focused.length === indexed.length
      ? []
      : indexed.filter(({ particle }) => !(params.focusEdgeIds?.has(particle.edgeId) ?? false));

  const selectedById = new Set<string>();
  const seenEdges = new Set<string>();
  const seed: Array<{ particle: GraphParticle; index: number }> = [];

  for (const pool of [focused, nonFocused]) {
    for (let cursor = pool.length - 1; cursor >= 0; cursor -= 1) {
      const candidate = pool[cursor];
      if (seenEdges.has(candidate.particle.edgeId)) {
        continue;
      }
      seenEdges.add(candidate.particle.edgeId);
      selectedById.add(candidate.particle.id);
      seed.push(candidate);
    }
  }

  const seedSorted = seed.sort((left, right) => left.index - right.index);
  if (seedSorted.length >= params.budget) {
    return sampleEvenly(seedSorted, params.budget).map(({ particle }) => particle);
  }

  const remaining = indexed.filter(({ particle }) => !selectedById.has(particle.id));
  const remainingBudget = params.budget - seedSorted.length;
  const extra = sampleEvenly(remaining, remainingBudget);

  return [...seedSorted, ...extra]
    .sort((left, right) => left.index - right.index)
    .map(({ particle }) => particle);
}
