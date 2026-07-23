import { isRecord } from '../utils/valueGuards';

import type { TerminalCommandRunPresentation } from '../model/terminalCommandRuns';

export function normalizeTerminalCommandRunEventDetail(
  event: Event
): (TerminalCommandRunPresentation & { durationMs?: number }) | null {
  const detail = (event as CustomEvent<unknown>).detail;
  if (!isRecord(detail)) {
    return null;
  }

  const command = typeof detail.command === 'string' ? detail.command.trim() : '';
  const clientEventId =
    typeof detail.clientEventId === 'string' && detail.clientEventId.trim()
      ? detail.clientEventId.trim()
      : null;
  const paneId = typeof detail.paneId === 'string' ? detail.paneId : null;
  const sessionId = typeof detail.sessionId === 'string' ? detail.sessionId : null;
  const startedAtMs =
    typeof detail.startedAtMs === 'number' && Number.isFinite(detail.startedAtMs)
      ? detail.startedAtMs
      : Date.now();

  if (!command || !clientEventId || !paneId || !sessionId) {
    return null;
  }

  const durationMs =
    typeof detail.durationMs === 'number' && Number.isFinite(detail.durationMs)
      ? detail.durationMs
      : undefined;

  return {
    clientEventId,
    command,
    durationMs,
    paneId,
    sessionId,
    startedAtMs,
    status: 'running',
  };
}
