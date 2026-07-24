import {
  capTerminalCommandRuns,
  type TerminalCommandRunPresentation,
} from '../model/terminalCommandRuns';
import { isRecord } from '../utils/valueGuards';

export function readStoredTerminalCommandRuns(teamName: string): TerminalCommandRunPresentation[] {
  try {
    const raw = window.localStorage.getItem(storageKey(teamName));
    if (!raw) return [];

    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return capTerminalCommandRuns(
      parsed
        .map((entry) => normalizeStoredTerminalCommandRun(entry))
        .filter((entry): entry is TerminalCommandRunPresentation => entry !== null)
    );
  } catch {
    return [];
  }
}

export function persistTerminalCommandRuns(
  teamName: string,
  runs: readonly TerminalCommandRunPresentation[]
): void {
  try {
    window.localStorage.setItem(storageKey(teamName), JSON.stringify(capTerminalCommandRuns(runs)));
  } catch {
    // Best-effort command presentation persistence.
  }
}

function normalizeStoredTerminalCommandRun(value: unknown): TerminalCommandRunPresentation | null {
  if (!isRecord(value)) {
    return null;
  }

  const clientEventId =
    typeof value.clientEventId === 'string' && value.clientEventId.trim()
      ? value.clientEventId.trim()
      : null;
  const command = typeof value.command === 'string' ? value.command.trim() : '';
  const paneId = typeof value.paneId === 'string' && value.paneId.trim() ? value.paneId : null;
  const sessionId =
    typeof value.sessionId === 'string' && value.sessionId.trim() ? value.sessionId : null;
  const startedAtMs =
    typeof value.startedAtMs === 'number' && Number.isFinite(value.startedAtMs)
      ? value.startedAtMs
      : 0;
  const storedStatus = isTerminalCommandRunPresentationStatus(value.status)
    ? value.status
    : 'unknown';
  const status = storedStatus === 'running' ? 'unknown' : storedStatus;

  if (!clientEventId || !command || !paneId || !sessionId) {
    return null;
  }

  const run: TerminalCommandRunPresentation = {
    clientEventId,
    command,
    paneId,
    sessionId,
    startedAtMs,
    status,
  };

  if (typeof value.durationMs === 'number' && Number.isFinite(value.durationMs)) {
    run.durationMs = Math.max(0, value.durationMs);
  }
  if (typeof value.exitCode === 'number' && Number.isFinite(value.exitCode)) {
    run.exitCode = Math.trunc(value.exitCode);
  }

  return run;
}

function isTerminalCommandRunPresentationStatus(
  value: unknown
): value is TerminalCommandRunPresentation['status'] {
  return value === 'failed' || value === 'running' || value === 'succeeded' || value === 'unknown';
}

function storageKey(teamName: string): string {
  return `agent-teams:terminal-workspace:${teamName}:command-runs`;
}
