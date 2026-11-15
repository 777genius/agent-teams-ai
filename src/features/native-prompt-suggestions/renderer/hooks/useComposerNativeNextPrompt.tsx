import { useCallback, useMemo, useRef } from 'react';

import { normalizeConversationParticipant } from '@features/team-direct-chats/renderer';
import { useStore } from '@renderer/store';

import { useNativeNextPrompt } from './useNativeNextPrompt';
import { NativeNextPromptRow } from '../ui/NativeNextPromptRow';

import type { UseComposerDraftResult } from '@renderer/hooks/useComposerDraft';

/** Existing editor adapter, without introducing another conversation owner. */
export function useComposerNativeNextPrompt(input: {
  teamName: string;
  recipient: string;
  memberId?: string;
  draft: UseComposerDraftResult;
  focusComposerTextarea(): void;
  editable: boolean;
  editingQueueOrRevision: boolean;
  compact: boolean;
  labels: readonly [insert: string, dismiss: string, tab: string];
}) {
  const { draft } = input;
  const messages = useStore(state => state.selectedTeamName === input.teamName
    ? state.teamMessagesByName[input.teamName]?.canonicalMessages : undefined);
  const latestDirectMessageId = useMemo(() => {
    const to = normalizeConversationParticipant(input.recipient);
    let latest: { messageId?: string; timestamp: string } | undefined;
    for (const message of messages ?? []) {
      if (message.from !== 'user' ||
          normalizeConversationParticipant(message.to) !== to ||
          !message.messageId || message.groupChatId || message.groupMessageId) continue;
      if (!latest || message.timestamp >= latest.timestamp) latest = message;
    }
    return latest?.messageId ?? null;
  }, [messages, input.recipient]);

  const composingRef = useRef(false);
  const onInsert = useCallback((text: string): boolean => {
    const current = draft.snapshot();
    if (composingRef.current || !draft.canSubmit || draft.isRestoring ||
        draft.renderedAddressKey !== draft.addressKey ||
        draft.address.target.kind !== 'direct' ||
        draft.editorContext.kind !== 'plain' ||
        current.text.length > 0 || current.chips.length > 0 ||
        current.attachments.length > 0 || current.restoredOrigin != null) return false;
    draft.setText(text);
    input.focusComposerTextarea();
    return true;
  }, [
    draft.snapshot, draft.canSubmit, draft.isRestoring, draft.renderedAddressKey,
    draft.addressKey, draft.address.target.kind, draft.editorContext.kind,
    draft.setText, input.focusComposerTextarea,
  ]);
  const suggestion = useNativeNextPrompt({
    teamName: input.teamName, recipient: input.recipient, memberId: input.memberId,
    latestDirectMessageId, editable: input.editable,
    draftText: draft.text, localEditCounter: draft.localEditCounter,
    hasAttachments: draft.attachments.length > 0,
    hasChips: draft.chips.length > 0,
    editingQueueOrRevision: input.editingQueueOrRevision ||
      draft.snapshot().restoredOrigin != null,
    onInsert,
  });
  const [insertLabel, dismissLabel, shortcutLabel] = input.labels;
  return {
    row: suggestion.candidate ? (
      <NativeNextPromptRow
        text={suggestion.candidate.text} compact={input.compact}
        insertLabel={insertLabel} dismissLabel={dismissLabel} shortcutLabel={shortcutLabel}
        onInsert={() => { suggestion.insert(); }} onDismiss={suggestion.dismiss}
      />
    ) : null,
    invalidate: suggestion.invalidate,
    onCompositionStart: () => { composingRef.current = true; suggestion.invalidate(); },
    onCompositionEnd: () => { composingRef.current = false; },
    onValueChange: (value: string) => { suggestion.invalidate(); draft.setText(value); },
    onTab: suggestion.visible ? suggestion.onTab : undefined,
    onEscape: suggestion.visible ? () => { suggestion.dismiss(); return true; } : undefined,
  };
}
