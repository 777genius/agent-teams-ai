import { useEffect, useMemo, useState } from 'react';

import { normalizeTerminalCommandRunEventDetail } from '../adapters/terminalCommandRunEvents';
import {
  createTerminalLocalAutocompleteCandidates,
  isTerminalLocalAutocompleteDraftEligible,
  resolveTerminalLocalAutocompleteSuggestion,
} from '../model/terminalCommandAutocomplete';
import { isRecord } from '../utils/valueGuards';

import type { TerminalCommandRunPresentation } from '../model/terminalCommandRuns';

const TERMINAL_LOCAL_AUTOCOMPLETE_THROTTLE_MS = 75;

interface UseTerminalCommandAutocompleteOptions {
  commandHistory: readonly string[];
  commandRuns: readonly TerminalCommandRunPresentation[];
  cwd?: string | null;
  eventSource: EventTarget | null;
  paneId: string | null;
  sessionId: string | null;
}

interface UseTerminalCommandAutocompleteResult {
  autocompleteSuggestion: string | null;
}

export function useTerminalCommandAutocomplete({
  commandHistory,
  commandRuns,
  cwd,
  eventSource,
  paneId,
  sessionId,
}: UseTerminalCommandAutocompleteOptions): UseTerminalCommandAutocompleteResult {
  const [draft, setDraft] = useState('');
  const [autocompleteSuggestion, setAutocompleteSuggestion] = useState<string | null>(null);
  const [dismissedDraft, setDismissedDraft] = useState<string | null>(null);
  const candidates = useMemo(
    () =>
      createTerminalLocalAutocompleteCandidates({
        commandHistory,
        commandRuns,
        cwd,
      }),
    [commandHistory, commandRuns, cwd]
  );

  useEffect(() => {
    setDraft('');
    setDismissedDraft(null);
    setAutocompleteSuggestion(null);

    if (!eventSource) {
      return undefined;
    }

    const handleDraftChange = (event: Event): void => {
      const detail = (event as CustomEvent<unknown>).detail;
      const value = isRecord(detail) && typeof detail.value === 'string' ? detail.value : '';
      setDraft(value);
      setDismissedDraft((current) => (current === value ? current : null));
    };
    const handleAutocompleteAccept = (event: Event): void => {
      const detail = (event as CustomEvent<unknown>).detail;
      const value = isRecord(detail) && typeof detail.value === 'string' ? detail.value : '';
      setDraft(value);
      setDismissedDraft(null);
      setAutocompleteSuggestion(null);
    };
    const handleAutocompleteDismiss = (event: Event): void => {
      const detail = (event as CustomEvent<unknown>).detail;
      const value = isRecord(detail) && typeof detail.draft === 'string' ? detail.draft : '';
      setDismissedDraft(value);
      setAutocompleteSuggestion(null);
    };
    const handleCommandStarted = (event: Event): void => {
      if (!normalizeTerminalCommandRunEventDetail(event)) {
        return;
      }

      setDraft('');
      setDismissedDraft(null);
      setAutocompleteSuggestion(null);
    };

    eventSource.addEventListener('tp-terminal-command-draft-change', handleDraftChange);
    eventSource.addEventListener(
      'tp-terminal-command-autocomplete-accept',
      handleAutocompleteAccept
    );
    eventSource.addEventListener(
      'tp-terminal-command-autocomplete-dismiss',
      handleAutocompleteDismiss
    );
    eventSource.addEventListener('tp-terminal-command-started', handleCommandStarted);

    return () => {
      eventSource.removeEventListener('tp-terminal-command-draft-change', handleDraftChange);
      eventSource.removeEventListener(
        'tp-terminal-command-autocomplete-accept',
        handleAutocompleteAccept
      );
      eventSource.removeEventListener(
        'tp-terminal-command-autocomplete-dismiss',
        handleAutocompleteDismiss
      );
      eventSource.removeEventListener('tp-terminal-command-started', handleCommandStarted);
    };
  }, [eventSource]);

  useEffect(() => {
    if (!isTerminalLocalAutocompleteDraftEligible(draft) || dismissedDraft === draft) {
      setAutocompleteSuggestion(null);
      return undefined;
    }

    const timer = window.setTimeout(() => {
      setAutocompleteSuggestion(
        resolveTerminalLocalAutocompleteSuggestion({
          candidates,
          cwd,
          dismissedDraft,
          draft,
          paneId,
          sessionId,
        })
      );
    }, TERMINAL_LOCAL_AUTOCOMPLETE_THROTTLE_MS);

    return () => window.clearTimeout(timer);
  }, [candidates, cwd, dismissedDraft, draft, eventSource, paneId, sessionId]);

  return {
    autocompleteSuggestion,
  };
}
