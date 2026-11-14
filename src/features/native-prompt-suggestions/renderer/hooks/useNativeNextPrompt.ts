import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/api';

import { canDisplayNativeNextPrompt, mayAcceptNativeNextPromptWithTab } from '../../core/domain/policy';

import type { NativeNextPromptCandidate, NativeNextPromptProvider } from '../../contracts';

/** Main has already attached the notice to one captured, authorized Host handle. */
export function useNativeNextPrompt(input: {
  teamName: string;
  recipient: string;
  memberId?: string;
  provider: NativeNextPromptProvider | 'unsupported';
  latestDirectMessageId: string | null;
  editable: boolean;
  draftText: string;
  hasAttachments: boolean;
  hasChips: boolean;
  editingQueueOrRevision: boolean;
  onInsert(text: string): void;
}) {
  const [candidate, setCandidate] = useState<NativeNextPromptCandidate | null>(null);
  const dismissedOperationRef = useRef<string | null>(null);
  // A user editing an empty composer can precede the provider's late offer.
  // Dismiss by the original human message, not just an arrived operation.
  const invalidatedMessageIdRef = useRef<string | null>(null);
  const conversationRef = 'direct:' + input.recipient.trim().toLowerCase();

  useEffect(() => {
    setCandidate(null);
    dismissedOperationRef.current = null;
    invalidatedMessageIdRef.current = null;
  }, [input.teamName, input.recipient, input.memberId]);

  useEffect(() => {
    // A new direct human message is a new revision and may get a new offer.
    if (invalidatedMessageIdRef.current !== input.latestDirectMessageId)
      invalidatedMessageIdRef.current = null;
    if (candidate && candidate.messageId !== input.latestDirectMessageId)
      setCandidate(null);
  }, [input.latestDirectMessageId, candidate]);

  useEffect(() => {
    if (!input.editable) {
      if (input.latestDirectMessageId)
        invalidatedMessageIdRef.current = input.latestDirectMessageId;
      setCandidate(null);
    }
  }, [input.editable, input.latestDirectMessageId]);

  useEffect(() => {
    const unsubscribe = api.nativePromptSuggestions?.onUpdated((value) => {
      if (
        value.ownerHandle !== input.teamName ||
        value.memberId !== input.memberId ||
        value.conversationRef !== conversationRef ||
        value.messageId === undefined ||
        value.messageId === invalidatedMessageIdRef.current ||
        value.operationRef === dismissedOperationRef.current
      ) return;
      setCandidate(value);
    });
    return () => unsubscribe?.();
  }, [conversationRef, input.memberId, input.teamName]);

  const visible = useMemo(() => {
    if (!candidate || !input.memberId || !input.latestDirectMessageId) return false;
    return canDisplayNativeNextPrompt(candidate, {
      ownerHandle: input.teamName,
      teamId: candidate.teamId,
      runId: candidate.runId,
      memberId: input.memberId,
      generation: candidate.generation,
      conversationRef,
      provider: input.provider,
      latestDirectMessageId: input.latestDirectMessageId,
      // Host independently fenced the exact last executed operation/native turn.
      latestExecutedOperationRef: candidate.operationRef,
      latestCompletedTurnRef: candidate.completedTurnRef,
      userEnabled: true, // Captured Host emits only after its global opt-in.
      isHumanDirectConversation: true, // Original human DM proven before Host publication.
      isEditable: input.editable,
      draftText: input.draftText,
      hasAttachments: input.hasAttachments,
      hasChips: input.hasChips,
      isEditingQueueOrRevision: input.editingQueueOrRevision,
      hasOpenMentionOrCommand: false, // An open menu requires nonempty text; editor owns key priority.
    });
  }, [candidate, input.memberId, input.latestDirectMessageId, input.teamName, conversationRef,
    input.provider, input.editable, input.draftText, input.hasAttachments, input.hasChips,
    input.editingQueueOrRevision]);

  const dismiss = useCallback(() => {
    if (candidate) dismissedOperationRef.current = candidate.operationRef;
    setCandidate(null);
  }, [candidate]);

  const insert = useCallback((): boolean => {
    if (!candidate || !visible) return false;
    input.onInsert(candidate.text);
    dismissedOperationRef.current = candidate.operationRef;
    setCandidate(null);
    return true;
  }, [candidate, visible, input.onInsert]);

  const onTab = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>): boolean =>
    mayAcceptNativeNextPromptWithTab({
      visible, editorFocused: event.currentTarget === document.activeElement,
      isComposing: event.nativeEvent.isComposing, hasActiveEditorKeyboardMenu: false,
      shiftKey: event.shiftKey, ctrlKey: event.ctrlKey,
      altKey: event.altKey, metaKey: event.metaKey,
    }) && insert(), [visible, insert]);

  /** Invalidate a displayed or pending old offer before an ordinary user send. */
  const invalidate = useCallback(() => {
    if (input.latestDirectMessageId)
      invalidatedMessageIdRef.current = input.latestDirectMessageId;
    if (candidate) dismissedOperationRef.current = candidate.operationRef;
    setCandidate(null);
  }, [candidate, input.latestDirectMessageId]);

  return { candidate: visible ? candidate : null, visible, insert, dismiss, onTab, invalidate };
}
