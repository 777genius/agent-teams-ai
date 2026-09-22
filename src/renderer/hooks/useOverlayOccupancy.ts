import { useLayoutEffect, useSyncExternalStore } from 'react';

export interface OverlaySnapshot {
  readonly count: number;
  readonly generation: number;
}

const occupants = new Set<symbol>();
const listeners = new Set<() => void>();
let snapshot: OverlaySnapshot = { count: 0, generation: 0 };

export const getOverlaySnapshot = (): OverlaySnapshot => snapshot;

export function subscribeOverlayOccupancy(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function publish(): void {
  snapshot = { count: occupants.size, generation: snapshot.generation + 1 };
  for (const listener of listeners) listener();
}

/** Register committed overlay lifetimes, including exit animation content. */
export function useOverlayOccupancy(active: boolean): void {
  useLayoutEffect(() => {
    if (!active) return;
    const occupant = Symbol('overlay');
    occupants.add(occupant);
    publish();
    return () => {
      if (occupants.delete(occupant)) publish();
    };
  }, [active]);
}

export function useOverlaySnapshot(): OverlaySnapshot {
  return useSyncExternalStore(subscribeOverlayOccupancy, getOverlaySnapshot, getOverlaySnapshot);
}

/** Place inside presence-managed content, never in an always-mounted wrapper. */
export const OverlayOccupancyMarker = ({ active = true }: { active?: boolean }): null => {
  useOverlayOccupancy(active);
  return null;
};
