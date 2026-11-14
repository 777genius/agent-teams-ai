import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/api';

import { canDisplayNativeNextPrompt, mayAcceptNativeNextPromptWithTab } from '../../core/domain/policy';

import { verifyCurrentNativeSuggestion } from './verifyCurrentNativeSuggestion';

import type { NativeNextPromptCandidate } from '../../contracts';

/** Main has already attached the notice to one captured, authorized Host handle. */
export function useNativeNextPrompt(input: {
  teamName: string;
  recipient: string;
  memberId?: string;
  latestDirectMessageId: string | null;
  editable: boolean;
  draftText: string;
  hasAttachments: boolean;
  hasChips: boolean;
  editingQueueOrRevision: boolean;
  onInsert(text: string): boolean | void;
}) {
  const [candidate, setCandidate] = useState<NativeNextPromptCandidate | null>(null);
  const candidateRef = useRef(candidate);
  candidateRef.current = candidate;
  const latestInputRef = useRef(input);
  latestInputRef.current = input;
  const validationEpochRef = useRef(0);
  const acceptingRef = useRef(false);
  const dismissedOperationRef = useRef<string | null>(null);
  // A user editing an empty composer can precede the provider's late offer.
  // Dismiss by the original human message, not just an arrived operation.
  const invalidatedMessageIdRef = useRef<string | null>(null);
  const conversationRef = 'direct:' + input.recipient.trim().toLowerCase();

  // An in-flight read must never resume insertion after the editor unmounts.
  useEffect(() => () => {
    validationEpochRef.current++;
    acceptingRef.current = false;
  }, []);

  useEffect(() => {
    validationEpochRef.current++;
    acceptingRef.current = false;
    setCandidate(null);
    dismissedOperationRef.current = null;
    invalidatedMessageIdRef.current = null;
  }, [input.teamName, input.recipient, input.memberId]);

  useEffect(() => {
    // A newer human message resets the dismissal for the previous message.
    // Do not discard an early offer for the NEW message while its inbox
    // readback is still catching up: the pure display guard hides it until
    // the exact messageId becomes the latest.
    if (invalidatedMessageIdRef.current !== input.latestDirectMessageId)
      invalidatedMessageIdRef.current = null;
  }, [input.latestDirectMessageId]);

  useEffect(() => {
    if (!input.editable) {
      // Temporary loading/restoring is not a human edit. Do not invalidate
      // an unseen offer for this message; it may arrive before hydration.
      // A previously displayed offer is dismissed for the exact operation,
      // so Stop/Restart cannot resurrect that visible row.
      validationEpochRef.current++;
      acceptingRef.current = false;
      if (candidateRef.current)
        dismissedOperationRef.current = candidateRef.current.operationRef;
      setCandidate(null);
    }
  }, [input.editable]);

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
      validationEpochRef.current++;
      acceptingRef.current = false;
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
      // Actual provider is proved by the captured native Host and Main,
      // not inferred from possibly stale UI model settings for a teammate.
      provider: candidate.provider,
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
    input.editable, input.draftText, input.hasAttachments, input.hasChips,
    input.editingQueueOrRevision]);

  const dismiss = useCallback(() => {
    validationEpochRef.current++;
    acceptingRef.current = false;
    if (candidate) dismissedOperationRef.current = candidate.operationRef;
    setCandidate(null);
  }, [candidate]);

  const insert = useCallback((): boolean => {
    if (!candidate || !visible || acceptingRef.current) return false;
    const selected = candidate;
    const startingFocus = document.activeElement;
    const epoch = ++validationEpochRef.current;
    acceptingRef.current = true;
    // A read-only independent Runtime generation/input check precedes
    // every user-driven insertion; a stale candidate cannot edit the draft.
    void verifyCurrentNativeSuggestion(selected, api.agentBackend)
      .then(current => {
        if (validationEpochRef.current !== epoch) return;
        acceptingRef.current = false;
        const now = latestInputRef.current;
        const sameEditor =
          document.activeElement === startingFocus &&
          now.teamName === selected.ownerHandle &&
          now.memberId === selected.memberId &&
          now.recipient.trim().toLowerCase() === selected.memberName.trim().toLowerCase() &&
          now.latestDirectMessageId === selected.messageId &&
          now.editable && now.draftText.length === 0 &&
          !now.hasAttachments && !now.hasChips && !now.editingQueueOrRevision &&
          invalidatedMessageIdRef.current !== selected.messageId &&
          dismissedOperationRef.current !== selected.operationRef;
        if (current && sameEditor) {
          // The existing composer additionally checks its live draft,
          // IME preedit and destination synchronously inside onInsert.
          now.onInsert(selected.text);
        }
        dismissedOperationRef.current = selected.operationRef;
        setCandidate(previous =>
          previous?.suggestionId === selected.suggestionId ? null : previous);
      })
      .catch(() => {
        if (validationEpochRef.current !== epoch) return;
        acceptingRef.current = false;
        dismissedOperationRef.current = selected.operationRef;
        setCandidate(previous =>
          previous?.suggestionId === selected.suggestionId ? null : previous);
      });
    return true; // Only consumes Tab; the draft mutation awaits Runtime.
  }, [candidate, visible]);

  const onTab = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>): boolean =>
    mayAcceptNativeNextPromptWithTab({
      visible, editorFocused: event.currentTarget === document.activeElement,
      isComposing: event.nativeEvent.isComposing, hasActiveEditorKeyboardMenu: false,
      shiftKey: event.shiftKey, ctrlKey: event.ctrlKey,
      altKey: event.altKey, metaKey: event.metaKey,
    }) && insert(), [visible, insert]);

  /** Invalidate a displayed or pending old offer before an ordinary user send. */
  const invalidate = useCallback(() => {
    validationEpochRef.current++;
    acceptingRef.current = false;
    if (input.latestDirectMessageId)
      invalidatedMessageIdRef.current = input.latestDirectMessageId;
    if (candidate) dismissedOperationRef.current = candidate.operationRef;
    setCandidate(null);
  }, [candidate, input.latestDirectMessageId]);

  return { candidate: visible ? candidate : null, visible, insert, dismiss, onTab, invalidate };
}
