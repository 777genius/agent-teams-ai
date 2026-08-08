import {
  DEFAULT_TERMINAL_APPEARANCE_SETTINGS,
  normalizeTerminalAppearanceSettings,
  type TerminalAppearanceSettings,
} from '../model/terminalAppearanceSettings';

export type TerminalWorkspacePreferenceKey =
  | 'appearance-settings'
  | 'font-scale'
  | 'line-wrap'
  | 'theme';

export interface TerminalWorkspacePreferencesStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
}

export function createTerminalWorkspacePreferenceKey(
  teamName: string,
  key: TerminalWorkspacePreferenceKey
): string {
  return `agent-teams:terminal-workspace:${teamName}:${key}`;
}

export function readStoredTerminalPreference(
  teamName: string,
  key: TerminalWorkspacePreferenceKey,
  storage: TerminalWorkspacePreferencesStorage | null = resolveBrowserStorage()
): string | null {
  if (!storage) {
    return null;
  }

  try {
    return storage.getItem(createTerminalWorkspacePreferenceKey(teamName, key));
  } catch {
    return null;
  }
}

export function readStoredTerminalBooleanPreference(
  teamName: string,
  key: TerminalWorkspacePreferenceKey,
  storage?: TerminalWorkspacePreferencesStorage | null
): boolean | null {
  const value = readStoredTerminalPreference(
    teamName,
    key,
    storage === undefined ? resolveBrowserStorage() : storage
  );
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

export function readStoredTerminalAppearanceSettings(
  teamName: string,
  storage?: TerminalWorkspacePreferencesStorage | null
): TerminalAppearanceSettings {
  const raw = readStoredTerminalPreference(
    teamName,
    'appearance-settings',
    storage === undefined ? resolveBrowserStorage() : storage
  );
  if (!raw) {
    return DEFAULT_TERMINAL_APPEARANCE_SETTINGS;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    return normalizeTerminalAppearanceSettings(parsed);
  } catch {
    return DEFAULT_TERMINAL_APPEARANCE_SETTINGS;
  }
}

export function persistTerminalPreference(
  teamName: string,
  key: TerminalWorkspacePreferenceKey,
  value: string,
  storage: TerminalWorkspacePreferencesStorage | null = resolveBrowserStorage()
): void {
  if (!storage) {
    return;
  }

  try {
    storage.setItem(createTerminalWorkspacePreferenceKey(teamName, key), value);
  } catch {
    // Best-effort UI preference persistence.
  }
}

export function persistTerminalAppearanceSettings(
  teamName: string,
  settings: TerminalAppearanceSettings,
  storage: TerminalWorkspacePreferencesStorage | null = resolveBrowserStorage()
): void {
  persistTerminalPreference(
    teamName,
    'appearance-settings',
    JSON.stringify(normalizeTerminalAppearanceSettings(settings)),
    storage
  );
}

function resolveBrowserStorage(): TerminalWorkspacePreferencesStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
