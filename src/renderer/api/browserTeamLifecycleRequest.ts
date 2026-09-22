import {
  type CanonicalListTeamLifecycleResult,
  type ListTeamLifecycleRequest,
  parseCanonicalListTeamLifecycleResult,
  parseListTeamLifecycleRequest,
  TEAM_LIFECYCLE_LIST_ROUTE,
  TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
  type TeamLifecycleReadFailure,
} from '@features/team-lifecycle/contracts';

export type BrowserJsonPost = <T>(path: string, body?: unknown) => Promise<T>;

function validationFailure(
  error: TeamLifecycleReadFailure['error']
): CanonicalListTeamLifecycleResult {
  return {
    schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
    kind: 'failure',
    error,
    retryable: error.code === 'unavailable',
  };
}

/** Validates both sides of the canonical lifecycle HTTP boundary and contains transport failures. */
export async function listTeamLifecycleOverHttp(
  post: BrowserJsonPost,
  requestValue: ListTeamLifecycleRequest
): Promise<CanonicalListTeamLifecycleResult> {
  const request = parseListTeamLifecycleRequest(requestValue);
  if (!request.ok) return validationFailure(request.error as TeamLifecycleReadFailure['error']);

  try {
    const response = await post<unknown>(TEAM_LIFECYCLE_LIST_ROUTE, request.value);
    const parsed = parseCanonicalListTeamLifecycleResult(response);
    return parsed.ok
      ? parsed.value
      : validationFailure(parsed.error as TeamLifecycleReadFailure['error']);
  } catch {
    return validationFailure({ code: 'unavailable', reason: 'transport_unavailable' });
  }
}
