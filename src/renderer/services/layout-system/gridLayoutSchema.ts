import type { PersistedGridLayoutItem, PersistedGridLayoutState } from './gridLayoutTypes';

const GRID_LAYOUT_SCHEMA_VERSION = 1;

function toPositiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.round(value))
    : fallback;
}

function toNonNegativeInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : fallback;
}

function sanitizeConstraint(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    return undefined;
  }

  return Math.round(value);
}

function sanitizeGridLayoutItem(
  raw: unknown,
  fallback?: PersistedGridLayoutItem
): PersistedGridLayoutItem | null {
  if (typeof raw !== 'object' || raw === null) {
    return fallback ?? null;
  }

  const candidate = raw as Record<string, unknown>;
  const id = typeof candidate.id === 'string' ? candidate.id : fallback?.id;
  if (!id) {
    return null;
  }

  return {
    id,
    x: toNonNegativeInt(candidate.x, fallback?.x ?? 0),
    y: toNonNegativeInt(candidate.y, fallback?.y ?? 0),
    w: toPositiveInt(candidate.w, fallback?.w ?? 1),
    h: toPositiveInt(candidate.h, fallback?.h ?? 1),
    minW: sanitizeConstraint(candidate.minW ?? fallback?.minW),
    minH: sanitizeConstraint(candidate.minH ?? fallback?.minH),
    maxW: sanitizeConstraint(candidate.maxW ?? fallback?.maxW),
    maxH: sanitizeConstraint(candidate.maxH ?? fallback?.maxH),
  };
}

export function createPersistedGridLayoutState(
  items: PersistedGridLayoutItem[]
): PersistedGridLayoutState {
  return {
    version: GRID_LAYOUT_SCHEMA_VERSION,
    updatedAt: Date.now(),
    items,
  };
}

export function sanitizePersistedGridLayoutState(raw: unknown): PersistedGridLayoutState | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }

  const candidate = raw as Record<string, unknown>;
  if (!Array.isArray(candidate.items)) {
    return null;
  }

  const items = candidate.items
    .map((item) => sanitizeGridLayoutItem(item))
    .filter((item): item is PersistedGridLayoutItem => item !== null);

  return {
    version: GRID_LAYOUT_SCHEMA_VERSION,
    updatedAt:
      typeof candidate.updatedAt === 'number' && Number.isFinite(candidate.updatedAt)
        ? candidate.updatedAt
        : Date.now(),
    items,
  };
}

export function normalizePersistedGridLayoutState(
  rawState: unknown,
  defaultItems: PersistedGridLayoutItem[]
): PersistedGridLayoutState {
  const sanitized = sanitizePersistedGridLayoutState(rawState);
  const persistedById = new Map(sanitized?.items.map((item) => [item.id, item]));

  const items = defaultItems.map((defaultItem) => {
    const persisted = persistedById.get(defaultItem.id);
    return sanitizeGridLayoutItem(persisted ?? defaultItem, defaultItem) ?? defaultItem;
  });

  return {
    version: GRID_LAYOUT_SCHEMA_VERSION,
    updatedAt: sanitized?.updatedAt ?? Date.now(),
    items,
  };
}

export function mergeGridLayoutItems(
  currentItems: PersistedGridLayoutItem[],
  updatedItems: PersistedGridLayoutItem[]
): PersistedGridLayoutItem[] {
  const updatedById = new Map(updatedItems.map((item) => [item.id, item]));

  return currentItems.map((item) => {
    const updated = updatedById.get(item.id);
    return updated ? { ...item, ...updated } : item;
  });
}

export function projectVisibleGridLayoutItems(
  allItems: PersistedGridLayoutItem[],
  visibleIds: string[],
  cols: number
): PersistedGridLayoutItem[] {
  const visibleIdSet = new Set(visibleIds);
  return allItems
    .filter((item) => visibleIdSet.has(item.id))
    .map((item) => {
      const width = Math.min(Math.max(1, item.w), cols);
      const maxX = Math.max(0, cols - width);

      return {
        ...item,
        w: width,
        x: Math.min(Math.max(0, item.x), maxX),
        y: Math.max(0, item.y),
      };
    })
    .sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y));
}
