import { validateTeamName } from '@main/services/team/TeamIdentifierValidation';
import { TeamRequestValidationError } from '@main/services/team/TeamRequestValidation';

export * from '@main/services/team/TeamRequestValidation';
export { TeamRequestValidationError as HttpBadRequestError } from '@main/services/team/TeamRequestValidation';

export function parseTeamConfigurationReadQuery(query: { configuration?: unknown }): boolean {
  if (
    query.configuration !== undefined &&
    query.configuration !== '1' &&
    query.configuration !== '0'
  )
    throw new TeamRequestValidationError('configuration must be 1 or 0');
  return query.configuration === '1';
}

/** A team name taken literally: valid and exactly as given (no trimming or case change). */
export function exactTeamName(value: unknown): string | null {
  const validation = validateTeamName(value);
  return typeof value === 'string' && validation.valid && validation.value === value ? value : null;
}
