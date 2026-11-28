import {
  isHostTeamSelectionKey,
  parseHostTeamSelectionKey,
} from '@features/agent-backend/contracts';
import { validateTeamName } from '@main/services/team/TeamIdentifierValidation';

/** Notification read state is keyed by the stored public destination, never a Team filesystem path. */
export function validateNotificationTeamSelection(value: unknown): {
  valid: boolean;
  value?: string;
  error?: string;
} {
  if (!isHostTeamSelectionKey(value)) return validateTeamName(value);
  try {
    parseHostTeamSelectionKey(value);
    return { valid: true, value };
  } catch {
    return { valid: false, error: 'Invalid Host notification destination' };
  }
}
