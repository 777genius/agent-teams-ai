import { useSyncExternalStore } from 'react';

export type TeamSidebarSurface = 'team' | 'graph-tab' | 'graph-overlay';

interface TeamSidebarHostEntry {
  id: string;
  teamName: string;
  surface: TeamSidebarSurface;
  element: HTMLElement | null;
  isActive: boolean;
  isFocused: boolean;
  order: number;
}

interface TeamSidebarSourceEntry {
  id: string;
  teamName: string;
  isActive: boolean;
  isFocused: boolean;
  order: number;
}

interface TeamSidebarSnapshot {
  version: number;
  activeHostIdByTeam: Record<string, string>;
  activeSourceIdByTeam: Record<string, string>;
}

const SURFACE_PRIORITY: Record<TeamSidebarSurface, number> = {
  team: 1,
  'graph-tab': 2,
  'graph-overlay': 3,
};

const hostById = new Map<string, TeamSidebarHostEntry>();
const sourceById = new Map<string, TeamSidebarSourceEntry>();
const listeners = new Set<() => void>();
let version = 0;
let nextOrder = 1;

function emit(): void {
  version += 1;
  for (const listener of listeners) {
    listener();
  }
}

function sortHosts(a: TeamSidebarHostEntry, b: TeamSidebarHostEntry): number {
  const focusedDiff = Number(b.isFocused) - Number(a.isFocused);
  if (focusedDiff !== 0) return focusedDiff;
  const activeDiff = Number(b.isActive) - Number(a.isActive);
  if (activeDiff !== 0) return activeDiff;
  const priorityDiff = SURFACE_PRIORITY[b.surface] - SURFACE_PRIORITY[a.surface];
  if (priorityDiff !== 0) return priorityDiff;
  return b.order - a.order;
}

function sortSources(a: TeamSidebarSourceEntry, b: TeamSidebarSourceEntry): number {
  const focusedDiff = Number(b.isFocused) - Number(a.isFocused);
  if (focusedDiff !== 0) return focusedDiff;
  const activeDiff = Number(b.isActive) - Number(a.isActive);
  if (activeDiff !== 0) return activeDiff;
  return b.order - a.order;
}

function buildSnapshot(): TeamSidebarSnapshot {
  const activeHostIdByTeam: Record<string, string> = {};
  const activeSourceIdByTeam: Record<string, string> = {};

  const hostsByTeam = new Map<string, TeamSidebarHostEntry[]>();
  for (const host of hostById.values()) {
    if (!host.element) continue;
    const list = hostsByTeam.get(host.teamName) ?? [];
    list.push(host);
    hostsByTeam.set(host.teamName, list);
  }
  for (const [teamName, hosts] of hostsByTeam.entries()) {
    const winner = [...hosts].sort(sortHosts)[0];
    if (winner) activeHostIdByTeam[teamName] = winner.id;
  }

  const sourcesByTeam = new Map<string, TeamSidebarSourceEntry[]>();
  for (const source of sourceById.values()) {
    const list = sourcesByTeam.get(source.teamName) ?? [];
    list.push(source);
    sourcesByTeam.set(source.teamName, list);
  }
  for (const [teamName, sources] of sourcesByTeam.entries()) {
    const winner = [...sources].sort(sortSources)[0];
    if (winner) activeSourceIdByTeam[teamName] = winner.id;
  }

  return {
    version,
    activeHostIdByTeam,
    activeSourceIdByTeam,
  };
}

let cachedSnapshot = buildSnapshot();

function refreshSnapshot(): void {
  cachedSnapshot = buildSnapshot();
  emit();
}

export function upsertTeamSidebarHost(
  id: string,
  entry: Omit<TeamSidebarHostEntry, 'id' | 'order'>
): void {
  const existing = hostById.get(id);
  hostById.set(id, {
    id,
    order: existing?.order ?? nextOrder++,
    ...entry,
  });
  refreshSnapshot();
}

export function removeTeamSidebarHost(id: string): void {
  if (!hostById.delete(id)) return;
  refreshSnapshot();
}

export function upsertTeamSidebarSource(
  id: string,
  entry: Omit<TeamSidebarSourceEntry, 'id' | 'order'>
): void {
  const existing = sourceById.get(id);
  sourceById.set(id, {
    id,
    order: existing?.order ?? nextOrder++,
    ...entry,
  });
  refreshSnapshot();
}

export function removeTeamSidebarSource(id: string): void {
  if (!sourceById.delete(id)) return;
  refreshSnapshot();
}

export function getTeamSidebarHostElement(hostId: string): HTMLElement | null {
  return hostById.get(hostId)?.element ?? null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): TeamSidebarSnapshot {
  return cachedSnapshot;
}

export function useTeamSidebarPortalSnapshot(): TeamSidebarSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function getTeamSidebarPortalSnapshotForTests(): TeamSidebarSnapshot {
  return cachedSnapshot;
}

export function resetTeamSidebarPortalManagerForTests(): void {
  hostById.clear();
  sourceById.clear();
  listeners.clear();
  version = 0;
  nextOrder = 1;
  cachedSnapshot = buildSnapshot();
}
