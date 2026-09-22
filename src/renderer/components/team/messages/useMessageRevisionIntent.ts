import { useCallback, useEffect, useRef, useState } from 'react';

import { normalizeConversationParticipant } from '@features/team-direct-chats/renderer';
import { useStore } from '@renderer/store';
import {
  captureContextScopedRequestEpoch,
  isContextScopedRequestEpochCurrent,
} from '@renderer/store/utils/contextScopedRequestEpoch';

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

export function useMessageRevisionIntent(options: UseMessageRevisionIntentOptions): {
  revisionRequest: MessageRevisionRequest | null;
  revisionPreparation: { kind: 'preparing' | 'occupied'; recipient: string } | null;
  handleReviseMessage: (message: InboxMessage) => Promise<void>;
  cancelRevision: () => void;
  invalidatePendingRevisionIntent: () => void;
  completeRevision: (requestId: string) => void;
} {
  const [revisionRequest, setRevisionRequest] = useState<MessageRevisionRequest | null>(null);
  const [revisionPreparation, setRevisionPreparation] = useState<{
    kind: 'preparing' | 'occupied';
    recipient: string;
  } | null>(null);
  const serialRef = useRef(0);
  const preparationAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const currentRef = useRef<CurrentRevisionSurface>(options);
  currentRef.current = options;

  const invalidatePendingRevisionIntent = useCallback(() => {
    serialRef.current += 1;
    preparationAbortRef.current?.abort();
    preparationAbortRef.current = null;
    setRevisionPreparation(null);
  }, []);
  const cancelRevision = useCallback(() => {
    serialRef.current += 1;
    preparationAbortRef.current?.abort();
    preparationAbortRef.current = null;
    setRevisionPreparation(null);
    setRevisionRequest(null);
  }, []);
  const completeRevision = useCallback((requestId: string) => {
    setRevisionRequest((current) => (current?.requestId === requestId ? null : current));
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
      const surface = currentRef.current;
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
      const originalText = getRevisableMessageText(message);
      setRevisionPreparation({ kind: 'preparing', recipient });
      const preparationAbort = new AbortController();
      preparationAbortRef.current?.abort();
      preparationAbortRef.current = preparationAbort;
      const finishPreparation = (): void => {
        if (preparationAbortRef.current === preparationAbort) preparationAbortRef.current = null;
      };
      const intentIsCurrent = (draftTarget?: MessageRevisionDraftTarget): boolean => {
        const currentStore = useStore.getState();
        const current = currentRef.current;
        return (
          mountedRef.current &&
          serialRef.current === token.serial &&
          options.navigationGenerationRef.current === token.navigationGeneration &&
          !currentStore.isContextSwitching &&
          currentStore.activeContextId === token.contextId &&
          isContextScopedRequestEpochCurrent(token.contextEpoch) &&
          current.teamName === token.teamName &&
          current.conversationKey === token.conversationKey &&
          current.revisionMessageId === token.originalMessageId &&
          current.memberNames.has(token.recipient) &&
          directRecipientMatches(current, token.recipient) &&
          (draftTarget == null || options.isRevisionTargetCurrent(draftTarget))
        );
      };
      let draftTarget: MessageRevisionDraftTarget | null = null;
      try {
        draftTarget = await options.prepareRevisionTarget(recipient, preparationAbort.signal);
      } catch {
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
      try {
        const result = await options.sendRevisionNotice(token.teamName, {
          member: recipient,
          text: buildRevisionNoticeText(originalMessageId, originalText),
          summary: `${REVISION_NOTICE_PREFIX} ${originalMessageId}`,
        });
        if (
          typeof result !== 'object' ||
          result === null ||
          (!(result as { deliveredToInbox?: boolean }).deliveredToInbox &&
            !(result as { deliveredViaStdin?: boolean }).deliveredViaStdin)
        ) {
          finishPreparation();
          return;
        }
      } catch {
        finishPreparation();
        return;
      }

      if (!intentIsCurrent(draftTarget)) {
        finishPreparation();
        return;
      }

      setRevisionRequest({
        requestId: `${originalMessageId}:${Date.now()}:${token.serial}`,
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
