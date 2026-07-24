import {
  parseTerminalTabPreferences,
  type TerminalTabPreferences,
} from '../model/terminalTabPreferences';

export function readStoredTerminalTabPreferences(teamName: string): TerminalTabPreferences {
  try {
    return parseTerminalTabPreferences(window.localStorage.getItem(storageKey(teamName)));
  } catch {
    return parseTerminalTabPreferences(null);
  }
}

export function persistTerminalTabPreferences(
  teamName: string,
  preferences: TerminalTabPreferences
): void {
  try {
    window.localStorage.setItem(storageKey(teamName), JSON.stringify(preferences));
  } catch {
    // Best-effort tab UI preference persistence.
  }
}

function storageKey(teamName: string): string {
  return `agent-teams:terminal-workspace:${teamName}:tab-preferences`;
}
