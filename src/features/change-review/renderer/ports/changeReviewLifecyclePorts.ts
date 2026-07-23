export interface ChangeReviewLifecycleOwnerRegistration {
  hostId: string;
  sessionId: string;
  tabId?: string;
  requestClose: () => Promise<boolean>;
  focus?: () => void;
}

export interface ChangeReviewLifecycleOwnerRegistrationResult {
  accepted: boolean;
  unregister: () => void;
}

export type RegisterChangeReviewLifecycleOwner = (
  owner: ChangeReviewLifecycleOwnerRegistration
) => ChangeReviewLifecycleOwnerRegistrationResult;

export type RegisterChangeReviewAppCloseParticipant = (
  participantId: string,
  flush: AppCloseParticipant
) => () => void;
import type { AppCloseParticipant } from '@features/app-close-coordination/renderer';
