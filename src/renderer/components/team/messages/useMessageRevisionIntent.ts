import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { normalizeConversationParticipant } from '@features/team-direct-chats/renderer';
import { composerDraftRepository } from '@renderer/services/composerDraftRepository';
import { useStore } from '@renderer/store';
import {
  captureContextScopedRequestEpoch,
  isContextScopedRequestEpochCurrent,
} from '@renderer/store/utils/contextScopedRequestEpoch';
import { composerDraftAddressKey, sameComposerDraftAddress } from '@renderer/utils/composerDraftIdentity';

import {
  buildRevisionNoticeText,
  getRevisableMessageText,
  isRevisableUserSentMessage,
  REVISION_NOTICE_PREFIX,
  trimString,
} from './messagesPanelLogic';

import type { ActionMode } from './ActionModeSelector';
import type { MessageRevisionRequest } from './MessageComposer';
import type { MessageRevisionDraftTarget } from './messageRevisionTarget';
import type { ComposerDraftAddress } from '@renderer/types/composerDraft';
import type { InboxMessage } from '@shared/types';

interface CurrentRevisionSurface {
  teamName: string;
  conversationKey: string;
  directRecipient?: string;
  revisionMessageId: string | null;
  memberNames: ReadonlySet<string>;
}

interface RevisionIntentToken {
  serial: number;
  navigationGeneration: number;
  contextId: string;
  contextEpoch: number;
  teamName: string;
  conversationKey: string;
  originalMessageId: string;
  recipient: string;
}

interface UseMessageRevisionIntentOptions extends CurrentRevisionSurface {
  sendRevisionNotice: (
    teamName: string,
    request: {
      member: string;
      text: string;
      summary: string;
      actionMode?: ActionMode;
    }
  ) => Promise<unknown>;
  navigationGenerationRef: { current: number };
  focusComposer: () => void;
  prepareRevisionTarget: (
    recipient: string,
    signal: AbortSignal
  ) => Promise<MessageRevisionDraftTarget | null>;
  isRevisionTargetCurrent: (target: MessageRevisionDraftTarget) => boolean;
}

function directRecipientMatches(surface: CurrentRevisionSurface, recipient: string): boolean {
  return (
    surface.directRecipient == null ||
    normalizeConversationParticipant(surface.directRecipient) ===
      normalizeConversationParticipant(recipient)
  );
}

function noticeWasDelivered(
  result: unknown
): result is { deliveredToInbox?: boolean; deliveredViaStdin?: boolean; messageId?: string } {
  return (
    typeof result === 'object' &&
    result !== null &&
    ((result as { deliveredToInbox?: boolean }).deliveredToInbox === true ||
      (result as { deliveredViaStdin?: boolean }).deliveredViaStdin === true)
  );
}

export function useMessageRevisionIntent(options: UseMessageRevisionIntentOptions): {
  revisionRequest: MessageRevisionRequest | null;
  revisionPreparation: { kind: 'preparing' | 'occupied'; recipient: string } | null;
  handleReviseMessage: (message: InboxMessage) => Promise<void>;
  cancelRevision: () => void;
  invalidatePendingRevisionIntent: () => void;
  completeRevision: (requestId: string, address?: ComposerDraftAddress) => void;
} {
  const [revisionRequest, setRevisionRequest] = useState<MessageRevisionRequest | null>(null);
  const [revisionPreparation, setRevisionPreparation] = useState<{
    kind: 'preparing' | 'occupied';
    recipient: string;
  } | null>(null);
  const serialRef = useRef(0);
  const lastStartedIntentSerialRef = useRef(0);
  const cancelledIntentSerialRef = useRef<number | null>(null);
  const repairAddressByIdRef = useRef(new Map<string, ComposerDraftAddress>());
  const preparationAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const optionsRef = useRef(options);
  useLayoutEffect(() => {
    optionsRef.current = options;
  }, [options]);

  const invalidatePendingRevisionIntent = useCallback(() => {
    serialRef.current += 1;
    preparationAbortRef.current?.abort();
    preparationAbortRef.current = null;
    setRevisionPreparation(null);
  }, []);
  const cancelRevision = useCallback(() => {
    if (preparationAbortRef.current) {
      cancelledIntentSerialRef.current = lastStartedIntentSerialRef.current;
    }
    serialRef.current += 1;
    preparationAbortRef.current?.abort();
    preparationAbortRef.current = null;
    setRevisionPreparation(null);
    setRevisionRequest(null);
  }, []);
  const completeRevision = useCallback((requestId: string, submittedAddress?: ComposerDraftAddress) => {
    setRevisionRequest((current) => (current?.requestId === requestId ? null : current));
    const address = repairAddressByIdRef.current.get(requestId);
    if (address) {
      repairAddressByIdRef.current.delete(requestId);
      void composerDraftRepository
        .discardRecovery(address.contextId, address.teamName, requestId)
        .catch((error: unknown) => console.error('Failed to clear completed revision recovery', error));
      return;
    }
    if (!requestId.startsWith('revision-repair:') || !submittedAddress) return;
    const { contextId, teamName } = submittedAddress;
    void composerDraftRepository
      .loadRecovery(contextId, teamName, requestId)
      .then((record) => {
        if (
          !record?.address ||
          !sameComposerDraftAddress(record.address, submittedAddress) ||
          record.snapshot.editorContext.kind !== 'revision' ||
          record.snapshot.editorContext.requestId !== requestId
        ) {
          return;
        }
        return composerDraftRepository.discardRecovery(contextId, teamName, requestId);
      })
      .catch((error: unknown) => console.error('Failed to clear restored revision recovery', error));
  }, []);

  const previousSurfaceRef = useRef({
    teamName: options.teamName,
    conversationKey: options.conversationKey,
  });
  useEffect(() => {
    const previous = previousSurfaceRef.current;
    previousSurfaceRef.current = {
      teamName: options.teamName,
      conversationKey: options.conversationKey,
    };
    if (
      previous.teamName !== options.teamName ||
      previous.conversationKey !== options.conversationKey
    ) {
      cancelRevision();
    }
  }, [cancelRevision, options.conversationKey, options.teamName]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      serialRef.current += 1;
      preparationAbortRef.current?.abort();
    };
  }, []);

  const handleReviseMessage = useCallback(
    async (message: InboxMessage): Promise<void> => {
      const surface = optionsRef.current;
      if (!isRevisableUserSentMessage(message, surface.memberNames)) return;
      const originalMessageId = trimString(message.messageId);
      if (originalMessageId !== surface.revisionMessageId) return;
      const recipient = trimString(message.to);
      if (!surface.memberNames.has(recipient) || !directRecipientMatches(surface, recipient)) return;

      const storeAtDispatch = useStore.getState();
      if (storeAtDispatch.isContextSwitching) return;
      const token: RevisionIntentToken = {
        serial: ++serialRef.current,
        navigationGeneration: options.navigationGenerationRef.current,
        contextId: storeAtDispatch.activeContextId,
        contextEpoch: captureContextScopedRequestEpoch(),
        teamName: surface.teamName,
        conversationKey: surface.conversationKey,
        originalMessageId,
        recipient,
      };
      lastStartedIntentSerialRef.current = token.serial;
      const originalText = getRevisableMessageText(message);
      setRevisionPreparation({ kind: 'preparing', recipient });
      const preparationAbort = new AbortController();
      preparationAbortRef.current?.abort();
      preparationAbortRef.current = preparationAbort;
      let activeRepair: { id: string; address: ComposerDraftAddress } | null = null;
      const finishPreparation = (): void => {
        if (activeRepair) {
          composerDraftRepository.setAttemptActive(activeRepair.id, false, activeRepair.address);
          activeRepair = null;
        }
        if (preparationAbortRef.current === preparationAbort) preparationAbortRef.current = null;
      };
      const intentIsCurrent = (
        draftTarget?: MessageRevisionDraftTarget,
        allowCancelledSerial = false
      ): boolean => {
        const currentStore = useStore.getState();
        const current = optionsRef.current;
        return (
          mountedRef.current &&
          (allowCancelledSerial || serialRef.current === token.serial) &&
          optionsRef.current.navigationGenerationRef.current === token.navigationGeneration &&
          !currentStore.isContextSwitching &&
          currentStore.activeContextId === token.contextId &&
          isContextScopedRequestEpochCurrent(token.contextEpoch) &&
          current.teamName === token.teamName &&
          current.conversationKey === token.conversationKey &&
          current.revisionMessageId === token.originalMessageId &&
          current.memberNames.has(token.recipient) &&
          directRecipientMatches(current, token.recipient) &&
          (draftTarget == null || optionsRef.current.isRevisionTargetCurrent(draftTarget))
        );
      };
      let draftTarget: MessageRevisionDraftTarget | null = null;
      try {
        draftTarget = await options.prepareRevisionTarget(recipient, preparationAbort.signal);
      } catch {
        if (intentIsCurrent()) setRevisionPreparation(null);
        finishPreparation();
        return;
      }
      if (!draftTarget || !intentIsCurrent(draftTarget)) {
        if (!preparationAbort.signal.aborted && intentIsCurrent(draftTarget ?? undefined)) {
          setRevisionPreparation({ kind: 'occupied', recipient });
        }
        finishPreparation();
        return;
      }
      const address: ComposerDraftAddress = {
        contextId: token.contextId,
        teamName: token.teamName,
        target: { kind: 'direct', participant: normalizeConversationParticipant(recipient) },
      };
      if (composerDraftAddressKey(address) !== draftTarget.addressKey) {
        setRevisionPreparation(null);
        finishPreparation();
        return;
      }
      const repairId = `revision-repair:${crypto.randomUUID()}`;
      const noticeRequest = {
        member: recipient,
        text: buildRevisionNoticeText(originalMessageId, originalText),
        summary: `${REVISION_NOTICE_PREFIX} ${originalMessageId}`,
      };
      try {
        const loaded = await composerDraftRepository.loadWorking(address);
        if (loaded.status !== 'durable' || loaded.writeBlocked || !intentIsCurrent(draftTarget)) {
          if (intentIsCurrent()) setRevisionPreparation(null);
          finishPreparation();
          return;
        }
        activeRepair = { id: repairId, address };
        composerDraftRepository.setAttemptActive(repairId, true, address);
        const prepared = await composerDraftRepository.beginAttempt(
          address,
          `${loaded.working.workingRevision}\0${repairId}`,
          {
            attemptId: repairId,
            snapshot: {
              content: {
                text: originalText,
                chips: [],
                attachments: [],
                actionMode: message.actionMode ?? 'do',
              },
              editorContext: {
                kind: 'revision',
                originalMessageId,
                recipient,
                requestId: repairId,
              },
            },
            preparedRequest: { kind: 'local', teamName: token.teamName, request: noticeRequest },
            recoveryReason: 'displaced-draft',
            createdAt: Date.now(),
          }
        );
        if (prepared.kind !== 'prepared') {
          if (intentIsCurrent()) setRevisionPreparation(null);
          finishPreparation();
          return;
        }
        if (prepared.status !== 'durable') {
          finishPreparation();
          await composerDraftRepository.discardRecovery(token.contextId, token.teamName, repairId);
          if (intentIsCurrent()) setRevisionPreparation(null);
          return;
        }
        if (prepared.workingCleared) {
          console.error('Revision repair unexpectedly cleared the working draft');
          if (intentIsCurrent()) setRevisionPreparation(null);
          finishPreparation();
          return;
        }
        repairAddressByIdRef.current.set(repairId, address);
      } catch {
        if (intentIsCurrent()) setRevisionPreparation(null);
        finishPreparation();
        return;
      }
      if (!intentIsCurrent(draftTarget)) {
        repairAddressByIdRef.current.delete(repairId);
        finishPreparation();
        void composerDraftRepository
          .discardRecovery(token.contextId, token.teamName, repairId)
          .catch((error: unknown) => console.error('Failed to clear unsent revision recovery', error));
        return;
      }
      let noticeResult: { messageId?: string };
      try {
        const result = await options.sendRevisionNotice(token.teamName, noticeRequest);
        if (!noticeWasDelivered(result)) {
          if (intentIsCurrent()) setRevisionPreparation(null);
          finishPreparation();
          return;
        }
        noticeResult = result;
      } catch {
        if (intentIsCurrent()) setRevisionPreparation(null);
        finishPreparation();
        return;
      }

      if (!intentIsCurrent(draftTarget)) {
        const restoreEditorIfSafe = (): boolean => {
          if (
            cancelledIntentSerialRef.current !== token.serial ||
            lastStartedIntentSerialRef.current !== token.serial ||
            !intentIsCurrent(draftTarget, true)
          ) {
            return false;
          }
          setRevisionRequest({
            requestId: repairId,
            originalMessageId,
            originalText,
            recipient,
            actionMode: message.actionMode,
          });
          optionsRef.current.focusComposer();
          return true;
        };
        const noticeMessageId = trimString(noticeResult.messageId);
        const noticeReference = noticeMessageId
          ? `Revision notice MessageId: ${noticeMessageId}`
          : `Revision notice for original MessageId: ${originalMessageId}`;
        const compensationStore = useStore.getState();
        if (
          compensationStore.isContextSwitching ||
          compensationStore.activeContextId !== token.contextId ||
          !isContextScopedRequestEpochCurrent(token.contextEpoch)
        ) {
          console.error('Revision cancellation requires repair in the original context');
          finishPreparation();
          return;
        }
        try {
          const cancellation = await options.sendRevisionNotice(token.teamName, {
            member: recipient,
            text: `${REVISION_NOTICE_PREFIX} ${originalMessageId} - cancelled\n\nCancel only ${noticeReference}. The original message remains valid. Any later revision notice for the original message remains in effect.`,
            summary: `${REVISION_NOTICE_PREFIX} ${originalMessageId} - cancelled`,
          });
          if (!noticeWasDelivered(cancellation)) {
            if (!restoreEditorIfSafe()) {
              console.error('Revision cancellation notice delivery was not confirmed');
            }
          } else {
            repairAddressByIdRef.current.delete(repairId);
            finishPreparation();
            try {
              await composerDraftRepository.discardRecovery(token.contextId, token.teamName, repairId);
            } catch (error) {
              console.error('Failed to clear cancelled revision recovery', error);
            }
          }
        } catch (error) {
          if (!restoreEditorIfSafe()) {
            console.error('Failed to send revision cancellation notice', error);
          }
        }
        finishPreparation();
        return;
      }

      setRevisionRequest({
        requestId: repairId,
        originalMessageId,
        originalText,
        recipient,
        actionMode: message.actionMode,
      });
      setRevisionPreparation(null);
      options.focusComposer();
      finishPreparation();
    },
    [options]
  );

  return {
    revisionRequest,
    revisionPreparation,
    handleReviseMessage,
    cancelRevision,
    invalidatePendingRevisionIntent,
    completeRevision,
  };
}
