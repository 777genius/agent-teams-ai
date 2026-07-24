import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { normalizeTerminalCommandRunEventDetail } from '../adapters/terminalCommandRunEvents';
import {
  persistTerminalCommandRuns,
  readStoredTerminalCommandRuns,
} from '../adapters/terminalCommandRunsStorage';
import {
  closeSupersededTerminalCommandRuns,
  settleScopedTerminalCommandRuns,
  type TerminalCommandRunPresentation,
  type TerminalCommandScreenLine,
  upsertTerminalCommandRun,
} from '../model/terminalCommandRuns';

interface UseTerminalCommandRunsOptions {
  activePaneId: string | null;
  activeSessionId: string | null;
  eventSource: EventTarget | null;
  onCommandStarted: () => void;
  onCommandSubmitted: () => void;
  screenLines: readonly TerminalCommandScreenLine[];
  screenSequence: unknown;
  teamName: string;
}

interface UseTerminalCommandRunsResult {
  activeCommandRuns: TerminalCommandRunPresentation[];
  commandRuns: TerminalCommandRunPresentation[];
}

interface TerminalCommandRunContext {
  onCommandStarted: () => void;
  onCommandSubmitted: () => void;
  paneId: string | null;
  screenLines: readonly TerminalCommandScreenLine[];
  sessionId: string | null;
}

const useCommitPhaseLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export function useTerminalCommandRuns({
  activePaneId,
  activeSessionId,
  eventSource,
  onCommandStarted,
  onCommandSubmitted,
  screenLines,
  screenSequence,
  teamName,
}: UseTerminalCommandRunsOptions): UseTerminalCommandRunsResult {
  const [commandRuns, setCommandRuns] = useState<TerminalCommandRunPresentation[]>(() =>
    readStoredTerminalCommandRuns(teamName)
  );
  const latestContextRef = useRef<TerminalCommandRunContext>({
    onCommandStarted,
    onCommandSubmitted,
    paneId: activePaneId,
    screenLines,
    sessionId: activeSessionId,
  });
  useCommitPhaseLayoutEffect(() => {
    latestContextRef.current = {
      onCommandStarted,
      onCommandSubmitted,
      paneId: activePaneId,
      screenLines,
      sessionId: activeSessionId,
    };
  }, [activePaneId, activeSessionId, onCommandStarted, onCommandSubmitted, screenLines]);

  const activeCommandRuns = useMemo(
    () =>
      commandRuns.filter((run) => run.sessionId === activeSessionId && run.paneId === activePaneId),
    [activePaneId, activeSessionId, commandRuns]
  );

  useEffect(() => {
    if (!eventSource) {
      return undefined;
    }

    const handleCommandSubmitted = (event: Event): void => {
      const context = latestContextRef.current;
      const detail = normalizeTerminalCommandRunEventDetail(event);
      if (detail) {
        setCommandRuns((current) =>
          upsertTerminalCommandRun(
            closeSupersededTerminalCommandRuns(current, detail, context.screenLines, Date.now()),
            detail,
            'running'
          )
        );
      }
      context.onCommandSubmitted();
    };
    const handleCommandStarted = (event: Event): void => {
      const detail = normalizeTerminalCommandRunEventDetail(event);
      if (!detail) {
        return;
      }

      const context = latestContextRef.current;
      context.onCommandStarted();
      setCommandRuns((current) =>
        upsertTerminalCommandRun(
          closeSupersededTerminalCommandRuns(current, detail, context.screenLines, Date.now()),
          detail,
          'running'
        )
      );
    };
    const handleCommandFailed = (event: Event): void => {
      const detail = normalizeTerminalCommandRunEventDetail(event);
      if (!detail) {
        return;
      }

      setCommandRuns((current) =>
        upsertTerminalCommandRun(
          current,
          {
            ...detail,
            durationMs: Math.max(0, Date.now() - detail.startedAtMs),
          },
          'failed'
        )
      );
    };

    eventSource.addEventListener('tp-terminal-command-started', handleCommandStarted);
    eventSource.addEventListener('tp-terminal-command-submitted', handleCommandSubmitted);
    eventSource.addEventListener('tp-terminal-command-failed', handleCommandFailed);
    eventSource.addEventListener('tp-terminal-paste-submitted', handleCommandSubmitted);

    return () => {
      eventSource.removeEventListener('tp-terminal-command-started', handleCommandStarted);
      eventSource.removeEventListener('tp-terminal-command-submitted', handleCommandSubmitted);
      eventSource.removeEventListener('tp-terminal-command-failed', handleCommandFailed);
      eventSource.removeEventListener('tp-terminal-paste-submitted', handleCommandSubmitted);
    };
  }, [eventSource]);

  useEffect(() => {
    if (screenLines.length === 0) {
      return;
    }

    setCommandRuns((current) =>
      settleScopedTerminalCommandRuns(
        current,
        activeSessionId,
        activePaneId,
        screenLines,
        Date.now(),
        false
      )
    );
  }, [activePaneId, activeSessionId, screenLines, screenSequence]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const context = latestContextRef.current;
      if (!context.sessionId || !context.paneId || context.screenLines.length === 0) {
        return;
      }

      setCommandRuns((current) => settlePendingCommandRuns(current, context));
    }, 900);

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    setCommandRuns(readStoredTerminalCommandRuns(teamName));
  }, [teamName]);

  useEffect(() => {
    persistTerminalCommandRuns(teamName, commandRuns);
  }, [commandRuns, teamName]);

  return {
    activeCommandRuns,
    commandRuns,
  };
}

function settlePendingCommandRuns(
  runs: TerminalCommandRunPresentation[],
  context: TerminalCommandRunContext
): TerminalCommandRunPresentation[] {
  const hasPendingScopedRun = runs.some(
    (run) =>
      run.sessionId === context.sessionId &&
      run.paneId === context.paneId &&
      (run.status === 'running' || run.status === 'unknown')
  );
  return hasPendingScopedRun
    ? settleScopedTerminalCommandRuns(
        runs,
        context.sessionId,
        context.paneId,
        context.screenLines,
        Date.now(),
        true
      )
    : runs;
}
