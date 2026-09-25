import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { composerDraftRepository } from '@renderer/services/composerDraftRepository';
import { composerDraftTargetKey } from '@renderer/utils/composerDraftIdentity';

import type {
  ComposerPersistenceStatus,
  ComposerWorkingSummary,
} from '@renderer/types/composerDraft';

interface ComposerWorkingSummariesState {
  readonly summaries: readonly ComposerWorkingSummary[];
  readonly byTargetKey: ReadonlyMap<string, ComposerWorkingSummary>;
  readonly status: ComposerPersistenceStatus;
  readonly readError: string | null;
}

const EMPTY_STATE: ComposerWorkingSummariesState = {
  summaries: [],
  byTargetKey: new Map(),
  status: 'durable',
  readError: null,
};

export function useComposerWorkingSummaries(
  contextId: string,
  teamName: string,
  enabled = true
): ComposerWorkingSummariesState {
  const [state, setState] = useState<Omit<ComposerWorkingSummariesState, 'byTargetKey'>>({
    summaries: [],
    status: 'durable',
    readError: null,
  });
  const generationRef = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    if (!enabled) return;
    const generation = generationRef.current;
    const result = await composerDraftRepository.listWorkingSummaries(contextId, teamName);
    if (generation !== generationRef.current) return;
    setState({
      summaries: result.summaries,
      status: result.status,
      readError: result.readError ?? null,
    });
  }, [contextId, enabled, teamName]);

  useEffect(() => {
    generationRef.current += 1;
    if (!enabled) {
      setState({ summaries: [], status: 'durable', readError: null });
      return;
    }
    void refresh();
    return composerDraftRepository.subscribe((event) => {
      if (
        event.kind === 'working-index' &&
        event.contextId === contextId &&
        event.teamName === teamName
      ) {
        void refresh();
      }
    });
  }, [contextId, enabled, refresh, teamName]);

  const byTargetKey = useMemo(
    () =>
      new Map(
        state.summaries.map((summary) => [
          composerDraftTargetKey(summary.address.target),
          summary,
        ])
      ),
    [state.summaries]
  );

  if (!enabled) return EMPTY_STATE;
  return { ...state, byTargetKey };
}
