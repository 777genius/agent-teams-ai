import {
  createDefaultTerminalTabPreferences,
  isTerminalTabColorId,
  TERMINAL_TAB_PREFERENCES_VERSION,
  type TerminalTabColorId,
  type TerminalTabPreferences,
} from '../model/terminalTabPreferences';

function storageKey(teamName: string, key: string): string {
  return `agent-teams:terminal-workspace:${teamName}:${key}`;
}

function readStoredValue(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function readStoredTerminalTabPreferences(teamName: string): TerminalTabPreferences {
  const raw = readStoredValue(storageKey(teamName, 'tab-preferences'));
  if (!raw) return createDefaultTerminalTabPreferences();

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return createDefaultTerminalTabPreferences();
    }

    const source = parsed as {
      order?: unknown;
      colors?: unknown;
    };
    const order = Array.isArray(source.order)
      ? source.order.filter((item): item is string => typeof item === 'string')
      : [];
    const colors: Record<string, TerminalTabColorId> = {};
    if (source.colors && typeof source.colors === 'object') {
      for (const [tabId, colorId] of Object.entries(source.colors)) {
        if (typeof tabId === 'string' && isTerminalTabColorId(colorId)) {
          colors[tabId] = colorId;
        }
      }
    }

    return {
      version: TERMINAL_TAB_PREFERENCES_VERSION,
      order,
      colors,
    };
  } catch {
    return createDefaultTerminalTabPreferences();
  }
}

export function persistTerminalTabPreferences(
  teamName: string,
  preferences: TerminalTabPreferences
): void {
  try {
    window.localStorage.setItem(
      storageKey(teamName, 'tab-preferences'),
      JSON.stringify(preferences)
    );
  } catch {
    // Best-effort tab UI preference persistence.
  }
}
