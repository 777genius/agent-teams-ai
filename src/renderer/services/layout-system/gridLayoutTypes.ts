export interface PersistedGridLayoutItem {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
  maxW?: number;
  maxH?: number;
}

export interface PersistedGridLayoutState {
  version: number;
  updatedAt: number;
  items: PersistedGridLayoutItem[];
}
