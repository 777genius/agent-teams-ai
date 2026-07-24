import { useEffect, useLayoutEffect } from 'react';

import type {
  RegisterChangeReviewAppCloseParticipant,
  RegisterChangeReviewLifecycleOwner,
} from '../ports/changeReviewLifecyclePorts';
import type { AppCloseParticipant } from '@features/app-close-coordination/renderer';

interface UseChangeReviewLifecycleRegistrationInput {
  open: boolean;
  authorized: boolean;
  hostId: string;
  sessionId: string;
  tabId?: string;
  focus?: () => void;
  requestClose: () => Promise<boolean>;
  closeRejectedDialog: () => void;
  setAuthorized: (authorized: boolean) => void;
  appCloseParticipantId: string;
  flushForAppClose: AppCloseParticipant;
  registerOwner: RegisterChangeReviewLifecycleOwner;
  registerAppCloseParticipant: RegisterChangeReviewAppCloseParticipant;
}

export function useChangeReviewLifecycleRegistration({
  open,
  authorized,
  hostId,
  sessionId,
  tabId,
  focus,
  requestClose,
  closeRejectedDialog,
  setAuthorized,
  appCloseParticipantId,
  flushForAppClose,
  registerOwner,
  registerAppCloseParticipant,
}: UseChangeReviewLifecycleRegistrationInput): void {
  useLayoutEffect(() => {
    if (!open) {
      setAuthorized(false);
      return;
    }
    const registration = registerOwner({
      hostId,
      sessionId,
      tabId,
      requestClose,
      focus,
    });
    setAuthorized(registration.accepted);
    if (!registration.accepted) closeRejectedDialog();
    return () => {
      registration.unregister();
      setAuthorized(false);
    };
  }, [
    closeRejectedDialog,
    focus,
    hostId,
    open,
    registerOwner,
    requestClose,
    sessionId,
    setAuthorized,
    tabId,
  ]);

  useEffect(() => {
    if (!open || !authorized) return;
    return registerAppCloseParticipant(appCloseParticipantId, flushForAppClose);
  }, [appCloseParticipantId, authorized, flushForAppClose, open, registerAppCloseParticipant]);
}
