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
 * In a direct thread, the user-facing route is implicit. Teammate-to-teammate
 * messages still need their recipient shown, including the open participant.
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
  return normalizedTo === 'user' || normalizeParticipant(from) === 'user';
}

export function parseIdlePeerSummaryRoute(summary: string): {
  recipient: string | null;
  body: string;
} {
  const trimmed = summary.trim();
  const match = /^\[to\s+([^\]]+)\]\s*(.*)$/i.exec(trimmed);
  if (!match) return { recipient: null, body: trimmed };

  const recipient = match[1]?.trim() || null;
  const body = match[2]?.trim() || trimmed;
  return { recipient, body };
}
