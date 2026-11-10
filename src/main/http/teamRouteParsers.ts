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
