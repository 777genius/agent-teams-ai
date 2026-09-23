import { isConversationLeadAlias } from '@shared/utils/leadDetection';

function normalizeParticipant(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

export function isDirectParticipantSender(
  from: string | undefined,
  directParticipant: string | undefined
): boolean {
  const normalizedParticipant = normalizeParticipant(directParticipant);
  return normalizedParticipant.length > 0 && normalizeParticipant(from) === normalizedParticipant;
}

/**
 * In a 1:1 thread, hide the from→to member route when it is the user or the
 * thread participant. Keep other recipients (lead → teammate) visible.
 * Team-feed (`directParticipant` unset) never hides the member route.
 */
export function shouldHideDirectMemberRoute(
  to: string | undefined,
  from: string | undefined,
  directParticipant: string | undefined
): boolean {
  if (directParticipant == null || directParticipant === '') {
    return false;
  }
  const normalizedTo = normalizeParticipant(to);
  if (!normalizedTo || normalizedTo === normalizeParticipant(from)) {
    return true;
  }
  if (normalizedTo === 'user') {
    return true;
  }
  const normalizedParticipant = normalizeParticipant(directParticipant);
  if (normalizedTo === normalizedParticipant) {
    return true;
  }
  return isConversationLeadAlias(normalizedTo);
}
