import { useCallback, useEffect, useMemo, useRef } from 'react';

import { normalizeConversationParticipant } from '@features/team-direct-chats/renderer';
import { useComposerDraft } from '@renderer/hooks/useComposerDraft';
import { resolveComposerDraftTarget } from '@renderer/utils/composerDraftIdentity';

import type { ComposerDraftDestination } from './composerDraftDestination';
import type { MessageRevisionRequest } from './MessageComposer';
import type {
  MessageRevisionDraftTarget,
  MessageRevisionTargetController,
} from './messageRevisionTarget';

interface UseMessageComposerDraftOptions {
  readonly activeContextId: string;
  readonly teamName: string;
  readonly lockedRecipient?: string;
  readonly selectedTeam: string | null;
  readonly crossTeamRecipient: string | null;
  readonly groupChatSelected: boolean;
  readonly recipient: string;
  readonly revisionRequest?: MessageRevisionRequest | null;
  readonly onSelectRevisionRecipient: (recipient: string) => void;
  readonly onDraftMutation?: () => void;
  readonly onRecoveryDestinationChange?: (
    destination: ComposerDraftDestination | null
  ) => void;
  readonly onRevisionPreparationChange?: (
    controller: MessageRevisionTargetController | null
  ) => void;
  readonly focusComposer: () => void;
}

export function useMessageComposerDraft({
  activeContextId,
  teamName,
  lockedRecipient,
  selectedTeam,
  crossTeamRecipient,
  groupChatSelected,
  recipient,
  revisionRequest,
  onSelectRevisionRecipient,
  onDraftMutation,
  onRecoveryDestinationChange,
  onRevisionPreparationChange,
  focusComposer,
}: UseMessageComposerDraftOptions): ReturnType<typeof useComposerDraft> {
  const target = useMemo(
    () =>
      resolveComposerDraftTarget({
        lockedRecipient,
        selectedTeam,
        crossTeamRecipient,
        groupChatSelected,
        localRecipient: recipient,
      }),
    [crossTeamRecipient, groupChatSelected, lockedRecipient, recipient, selectedTeam]
  );
  const address = useMemo(
    () => ({ contextId: activeContextId, teamName, target }),
    [activeContextId, target, teamName]
  );
  const draft = useComposerDraft(address);
  const appliedRevisionRequestIdRef = useRef<string | null>(null);
  const previousDraftEditCounterRef = useRef(draft.localEditCounter);
  const pendingPreparationRef = useRef<{
    recipient: string;
    signal: AbortSignal;
    resolve: (target: MessageRevisionDraftTarget | null) => void;
  } | null>(null);

  const currentTarget = useCallback(
    (): MessageRevisionDraftTarget => ({
      addressKey: draft.addressKey,
      loadGeneration: draft.loadGeneration,
    }),
    [draft.addressKey, draft.loadGeneration]
  );
  const targetIsCurrent = useCallback(
    (target: MessageRevisionDraftTarget): boolean =>
      draft.isLoaded &&
      draft.addressKey === target.addressKey &&
      draft.loadGeneration === target.loadGeneration,
    [draft.addressKey, draft.isLoaded, draft.loadGeneration]
  );

  const prepareRevisionTarget = useCallback(
    (nextRecipient: string, signal: AbortSignal): Promise<MessageRevisionDraftTarget | null> => {
      const normalized = normalizeConversationParticipant(nextRecipient);
      if (
        lockedRecipient &&
        normalizeConversationParticipant(lockedRecipient) !== normalized
      ) {
        return Promise.resolve(null);
      }
      pendingPreparationRef.current?.resolve(null);
      if (
        draft.address.target.kind === 'direct' &&
        draft.address.target.participant === normalized &&
        draft.isLoaded
      ) {
        return Promise.resolve(
          draft.text.length === 0 && draft.chips.length === 0 && draft.attachments.length === 0
            ? currentTarget()
            : null
        );
      }
      onSelectRevisionRecipient(nextRecipient);
      return new Promise((resolve) => {
        const pending = { recipient: normalized, signal, resolve };
        pendingPreparationRef.current = pending;
        signal.addEventListener(
          'abort',
          () => {
            if (pendingPreparationRef.current === pending) pendingPreparationRef.current = null;
            resolve(null);
          },
          { once: true }
        );
      });
    },
    [
      draft.address.target,
      draft.attachments.length,
      draft.chips.length,
      draft.isLoaded,
      draft.text.length,
      currentTarget,
      lockedRecipient,
      onSelectRevisionRecipient,
    ]
  );

  useEffect(() => {
    onRevisionPreparationChange?.({ prepare: prepareRevisionTarget, isCurrent: targetIsCurrent });
    return () => onRevisionPreparationChange?.(null);
  }, [onRevisionPreparationChange, prepareRevisionTarget, targetIsCurrent]);

  useEffect(() => {
    const pending = pendingPreparationRef.current;
    if (
      !pending ||
      pending.signal.aborted ||
      !draft.isLoaded ||
      draft.address.target.kind !== 'direct' ||
      draft.address.target.participant !== pending.recipient
    ) {
      return;
    }
    pendingPreparationRef.current = null;
    pending.resolve(
      draft.text.length === 0 && draft.chips.length === 0 && draft.attachments.length === 0
        ? currentTarget()
        : null
    );
  }, [
    draft.address.target,
    draft.attachments.length,
    draft.chips.length,
    draft.isLoaded,
    draft.text.length,
    currentTarget,
  ]);

  useEffect(
    () => () => {
      pendingPreparationRef.current?.resolve(null);
      pendingPreparationRef.current = null;
    },
    []
  );

  useEffect(() => {
    if (previousDraftEditCounterRef.current === draft.localEditCounter) return;
    previousDraftEditCounterRef.current = draft.localEditCounter;
    onDraftMutation?.();
  }, [draft.localEditCounter, onDraftMutation]);

  const recoveryDestination = useMemo<ComposerDraftDestination>(
    () => ({
      address: draft.address,
      isLoaded: draft.isLoaded,
      loadGeneration: draft.loadGeneration,
      workingRevision: draft.workingRevision,
      isEmpty:
        draft.text.length === 0 && draft.chips.length === 0 && draft.attachments.length === 0,
      restoreRecovery: draft.restoreRecovery,
      moveWorkingAsNew: draft.moveWorkingAsNew,
    }),
    [
      draft.address,
      draft.isLoaded,
      draft.loadGeneration,
      draft.workingRevision,
      draft.restoreRecovery,
      draft.moveWorkingAsNew,
      draft.text,
      draft.chips.length,
      draft.attachments.length,
    ]
  );
  useEffect(() => {
    onRecoveryDestinationChange?.(recoveryDestination);
    return () => onRecoveryDestinationChange?.(null);
  }, [onRecoveryDestinationChange, recoveryDestination]);

  useEffect(() => {
    if (!revisionRequest) {
      appliedRevisionRequestIdRef.current = null;
      return;
    }
    if (appliedRevisionRequestIdRef.current === revisionRequest.requestId) return;
    if (
      lockedRecipient &&
      normalizeConversationParticipant(lockedRecipient) !==
        normalizeConversationParticipant(revisionRequest.recipient)
    ) {
      return;
    }
    const normalizedRecipient = normalizeConversationParticipant(revisionRequest.recipient);
    if (
      draft.address.target.kind !== 'direct' ||
      draft.address.target.participant !== normalizedRecipient
    ) {
      onSelectRevisionRecipient(revisionRequest.recipient);
      return;
    }
    if (!draft.isLoaded) return;
    const applied = draft.setRevision(
      {
        kind: 'revision',
        originalMessageId: revisionRequest.originalMessageId,
        recipient: revisionRequest.recipient,
        requestId: revisionRequest.requestId,
      },
      {
        text: revisionRequest.originalText,
        chips: [],
        attachments: [],
        actionMode: revisionRequest.actionMode ?? draft.actionMode,
      }
    );
    if (!applied) return;
    appliedRevisionRequestIdRef.current = revisionRequest.requestId;
    focusComposer();
  }, [draft, focusComposer, lockedRecipient, onSelectRevisionRecipient, revisionRequest]);

  return draft;
}
