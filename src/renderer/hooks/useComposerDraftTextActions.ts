import { useCallback } from 'react';

import type { LocalDraftState } from './composerDraftLocal';
import type { InlineChip } from '@renderer/types/inlineChip';
import type { AgentActionMode } from '@shared/types';

export function useComposerDraftTextActions(
  edit: (update: (current: LocalDraftState) => LocalDraftState) => void
) {
  const setText = useCallback(
    (text: string) => edit((current) => ({ ...current, content: { ...current.content, text } })),
    [edit]
  );
  const addChip = useCallback(
    (chip: InlineChip) =>
      edit((current) => ({
        ...current,
        content: { ...current.content, chips: [...current.content.chips, chip] },
      })),
    [edit]
  );
  const removeChip = useCallback(
    (chipId: string) =>
      edit((current) => ({
        ...current,
        content: {
          ...current.content,
          chips: current.content.chips.filter((chip) => chip.id !== chipId),
        },
      })),
    [edit]
  );
  const setActionMode = useCallback(
    (actionMode: AgentActionMode) =>
      edit((current) => ({ ...current, content: { ...current.content, actionMode } })),
    [edit]
  );
  return { setText, addChip, removeChip, setActionMode };
}
