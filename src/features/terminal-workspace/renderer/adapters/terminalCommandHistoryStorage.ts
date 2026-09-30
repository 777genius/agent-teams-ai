import { normalizeStoredTerminalCommandHistoryEntry } from '../model/terminalCommandHistory';
import { TERMINAL_COMMAND_HISTORY_LIMIT } from '../model/terminalCommandRuns';

export function readStoredTerminalCommandHistory(teamName: string): string[] | null {
  try {
    const raw = window.localStorage.getItem(storageKey(teamName));
    if (!raw) return null;

    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => normalizeStoredTerminalCommandHistoryEntry(entry))
      .filter((entry): entry is string => Boolean(entry))
      .slice(-TERMINAL_COMMAND_HISTORY_LIMIT);
  } catch {
    return null;
  }
}

export function persistTerminalCommandHistory(teamName: string, entries: readonly string[]): void {
  try {
    window.localStorage.setItem(
      storageKey(teamName),
      JSON.stringify(entries.slice(-TERMINAL_COMMAND_HISTORY_LIMIT))
    );
  } catch {
    // Best-effort command history persistence.
  }
}

function storageKey(teamName: string): string {
  return `agent-teams:terminal-workspace:${teamName}:command-history`;
}
