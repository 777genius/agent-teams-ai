import { HANDOFF_CARD } from '../constants/canvas-constants';
import type { GraphEdge, GraphNode, GraphParticle, GraphParticleKind } from '../ports/types';

type HandoffParticleKind = Exclude<GraphParticleKind, 'spawn'>;

export interface TransientHandoffCard {
  key: string;
  edgeId: string;
  sourceNodeId: string;
  destinationNodeId: string;
  sourceLabel: string;
  destinationLabel: string;
  destinationKind: GraphNode['kind'];
  kind: HandoffParticleKind;
  color: string;
  preview?: string;
  count: number;
  activatedAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface TransientHandoffState {
  cardsByKey: Map<string, TransientHandoffCard>;
  triggeredParticleIds: Set<string>;
}

export function createTransientHandoffState(): TransientHandoffState {
  return {
    cardsByKey: new Map<string, TransientHandoffCard>(),
    triggeredParticleIds: new Set<string>(),
  };
}

export function updateTransientHandoffState(
  state: TransientHandoffState,
  params: {
    particles: GraphParticle[];
    edgeMap: Map<string, GraphEdge>;
    nodeMap: Map<string, GraphNode>;
    time: number;
  }
): void {
  const { particles, edgeMap, nodeMap, time } = params;

  const activeParticleIds = new Set<string>();
  for (const particle of particles) activeParticleIds.add(particle.id);
  for (const particleId of Array.from(state.triggeredParticleIds)) {
    if (!activeParticleIds.has(particleId)) {
      state.triggeredParticleIds.delete(particleId);
    }
  }

  for (const [cardKey, card] of Array.from(state.cardsByKey.entries())) {
    if (card.expiresAt <= time) {
      state.cardsByKey.delete(cardKey);
    }
  }

  for (const particle of particles) {
    if (!isTransientHandoffKind(particle.kind)) continue;
    if (particle.progress < HANDOFF_CARD.triggerProgress) continue;
    if (state.triggeredParticleIds.has(particle.id)) continue;

    const edge = edgeMap.get(particle.edgeId);
    if (!edge) continue;

    const sourceNodeId = particle.reverse ? edge.target : edge.source;
    const destinationNodeId = particle.reverse ? edge.source : edge.target;
    const sourceNode = nodeMap.get(sourceNodeId);
    const destinationNode = nodeMap.get(destinationNodeId);
    if (!sourceNode || !destinationNode) continue;

    const previewText = normalizePreviewText(particle.preview ?? particle.label);
    if (particle.kind === 'inbox_message' && isLowSignalInboxPreview(previewText)) {
      state.triggeredParticleIds.add(particle.id);
      continue;
    }

    const cardKey = `${edge.id}:${particle.reverse ? 'rev' : 'fwd'}:${particle.kind}`;
    const existing = state.cardsByKey.get(cardKey);
    const nextCount = (existing?.count ?? 0) + 1;

    state.cardsByKey.set(cardKey, {
      key: cardKey,
      edgeId: edge.id,
      sourceNodeId,
      destinationNodeId,
      sourceLabel: sourceNode.label,
      destinationLabel: destinationNode.label,
      destinationKind: destinationNode.kind,
      kind: particle.kind,
      color: particle.color,
      preview: previewText ?? existing?.preview,
      count: nextCount,
      activatedAt: existing?.activatedAt ?? time,
      updatedAt: time,
      expiresAt: time + HANDOFF_CARD.lingerSeconds,
    });
    state.triggeredParticleIds.add(particle.id);
  }
}

export function selectRenderableTransientHandoffCards(
  state: TransientHandoffState,
  options?: {
    focusNodeIds?: ReadonlySet<string> | null;
    focusEdgeIds?: ReadonlySet<string> | null;
  }
): TransientHandoffCard[] {
  const focusNodeIds = options?.focusNodeIds ?? null;
  const focusEdgeIds = options?.focusEdgeIds ?? null;
  const hasFocus = (focusNodeIds?.size ?? 0) > 0 || (focusEdgeIds?.size ?? 0) > 0;

  const byDestination = new Map<string, TransientHandoffCard[]>();
  for (const card of state.cardsByKey.values()) {
    if (hasFocus && !isCardInFocus(card, focusNodeIds, focusEdgeIds)) continue;
    const destinationCards = byDestination.get(card.destinationNodeId);
    if (destinationCards) {
      destinationCards.push(card);
    } else {
      byDestination.set(card.destinationNodeId, [card]);
    }
  }

  const selected: TransientHandoffCard[] = [];
  for (const cards of byDestination.values()) {
    cards.sort((a, b) => b.updatedAt - a.updatedAt);
    selected.push(...cards.slice(0, HANDOFF_CARD.maxPerDestination));
  }

  selected.sort((a, b) => b.updatedAt - a.updatedAt);
  return selected;
}

function isTransientHandoffKind(kind: GraphParticleKind): kind is HandoffParticleKind {
  return kind !== 'spawn';
}

function isCardInFocus(
  card: TransientHandoffCard,
  focusNodeIds: ReadonlySet<string> | null,
  focusEdgeIds: ReadonlySet<string> | null
): boolean {
  return (
    !!focusEdgeIds?.has(card.edgeId) ||
    !!focusNodeIds?.has(card.sourceNodeId) ||
    !!focusNodeIds?.has(card.destinationNodeId)
  );
}

function normalizePreviewText(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const normalized = text
    .replace(/^(?:✉|💬)\s*/u, '')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length > 0 ? normalized : undefined;
}

function isLowSignalInboxPreview(preview: string | undefined): boolean {
  return preview === 'idle';
}
