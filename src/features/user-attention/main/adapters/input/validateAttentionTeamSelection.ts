import { isHostTeamSelectionKey, parseHostTeamSelectionKey } from '@features/agent-backend/contracts/teamSelection';
import { validateTeamName } from '@main/services/team/TeamIdentifierValidation';

/** Host handles use their finite opaque-key grammar; legacy names keep their original grammar. */
export function validateAttentionTeamSelection(value: unknown): string {
  if (isHostTeamSelectionKey(value)) {
    parseHostTeamSelectionKey(value);
    return value;
  }
  const validated = validateTeamName(value);
  if (!validated.valid || !validated.value) throw new Error('Invalid attention team name');
  return validated.value;
}
