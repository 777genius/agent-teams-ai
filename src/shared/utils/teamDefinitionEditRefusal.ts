import type { TeamDefinitionEditRefusal } from '@shared/types/teamDefinitionEdit';

export function toTeamDefinitionEditRefusal(
  message: string,
  failure: unknown
): TeamDefinitionEditRefusal | null {
  if (
    !failure ||
    typeof failure !== 'object' ||
    !('code' in failure) ||
    failure.code !== 'TEAM_PROJECT_CONTEXT_UNRECONCILED'
  )
    return null;
  return {
    type: 'team-definition-edit-refusal',
    message,
    failure: { code: 'TEAM_PROJECT_CONTEXT_UNRECONCILED' },
  };
}

export function isTeamDefinitionEditRefusal(value: unknown): value is TeamDefinitionEditRefusal {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'type' in value &&
    value.type === 'team-definition-edit-refusal' &&
    'message' in value &&
    typeof value.message === 'string' &&
    'failure' in value &&
    toTeamDefinitionEditRefusal(value.message, value.failure)
  );
}
