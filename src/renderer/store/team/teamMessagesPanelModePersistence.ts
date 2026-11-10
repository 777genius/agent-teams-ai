import type { TeamMessagesPanelMode } from '@renderer/types/teamMessagesPanelMode';

const MESSAGES_PANEL_MODE_STORAGE_KEY = 'team:messagesPanelMode';
const DEFAULT_MESSAGES_PANEL_MODE: TeamMessagesPanelMode = 'sidebar';
const VALID_MESSAGES_PANEL_MODES: ReadonlySet<TeamMessagesPanelMode> = new Set([
  'sidebar',
  'inline',
  'bottom-sheet',
  'floating-composer',
]);

export function loadPersistedMessagesPanelMode(): TeamMessagesPanelMode {
  try {
    const persisted = localStorage.getItem(MESSAGES_PANEL_MODE_STORAGE_KEY);
    return VALID_MESSAGES_PANEL_MODES.has(persisted as TeamMessagesPanelMode)
      ? (persisted as TeamMessagesPanelMode)
      : DEFAULT_MESSAGES_PANEL_MODE;
  } catch {
    return DEFAULT_MESSAGES_PANEL_MODE;
  }
}

export function savePersistedMessagesPanelMode(mode: TeamMessagesPanelMode): void {
  try {
    localStorage.setItem(MESSAGES_PANEL_MODE_STORAGE_KEY, mode);
  } catch {
    // ignore - best-effort UI preference persistence
  }
}
