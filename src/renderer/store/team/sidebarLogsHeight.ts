const SIDEBAR_LOGS_HEIGHT_STORAGE_KEY = 'team:sidebarLogsHeight';

export const SIDEBAR_LOGS_MIN_HEIGHT = 120;
export const SIDEBAR_LOGS_MAX_HEIGHT = 520;
/** Logs header plus the resize handle between messages and logs. */
export const SIDEBAR_LOGS_OPEN_CHROME_PX = 52;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function loadPersistedSidebarLogsHeight(): number | null {
  try {
    const persisted = localStorage.getItem(SIDEBAR_LOGS_HEIGHT_STORAGE_KEY);
    if (persisted == null) return null;
    const value = Number(persisted);
    if (!Number.isFinite(value)) return null;
    return clamp(Math.round(value), SIDEBAR_LOGS_MIN_HEIGHT, SIDEBAR_LOGS_MAX_HEIGHT);
  } catch {
    return null;
  }
}

export function savePersistedSidebarLogsHeight(height: number): void {
  try {
    localStorage.setItem(SIDEBAR_LOGS_HEIGHT_STORAGE_KEY, String(Math.round(height)));
  } catch {
    // ignore - best-effort UI preference persistence
  }
}

export function resolveOpenSidebarLogsHeight(
  sidebarHeight: number,
  persistedHeight: number | null
): number {
  const maxFit = Math.max(SIDEBAR_LOGS_MIN_HEIGHT, sidebarHeight - SIDEBAR_LOGS_OPEN_CHROME_PX);
  const upperBound = Math.min(SIDEBAR_LOGS_MAX_HEIGHT, maxFit);
  if (persistedHeight != null) {
    return clamp(Math.round(persistedHeight), SIDEBAR_LOGS_MIN_HEIGHT, upperBound);
  }
  return clamp(
    Math.round(sidebarHeight / 2) - SIDEBAR_LOGS_OPEN_CHROME_PX,
    SIDEBAR_LOGS_MIN_HEIGHT,
    upperBound
  );
}

export interface SidebarLogsHeightSlice {
  sidebarLogsHeight: number;
  sidebarLogsHeightCustom: boolean;
  setSidebarLogsHeight: (height: number) => void;
  applyDefaultSidebarLogsHeight: (height: number) => void;
}

export function createSidebarLogsHeightSlice(
  set: (partial: Partial<SidebarLogsHeightSlice>) => void,
  get: () => Pick<SidebarLogsHeightSlice, 'sidebarLogsHeight' | 'sidebarLogsHeightCustom'>
): SidebarLogsHeightSlice {
  const persisted = loadPersistedSidebarLogsHeight();
  return {
    sidebarLogsHeight: persisted ?? 213,
    sidebarLogsHeightCustom: persisted != null,
    setSidebarLogsHeight: (height: number) => {
      const next = Math.round(height);
      savePersistedSidebarLogsHeight(next);
      set({ sidebarLogsHeight: next, sidebarLogsHeightCustom: true });
    },
    applyDefaultSidebarLogsHeight: (height: number) => {
      if (get().sidebarLogsHeightCustom) return;
      const next = Math.round(height);
      if (get().sidebarLogsHeight === next) return;
      set({ sidebarLogsHeight: next });
    },
  };
}
