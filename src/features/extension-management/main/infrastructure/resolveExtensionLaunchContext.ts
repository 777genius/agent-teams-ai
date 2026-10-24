import type { TeamCreateRequest, TeamLaunchRequest } from '@shared/types/team';

/** Match runtime admission: explicit launch values override saved lead defaults. */
export function resolveExtensionLaunchContext(
  request: TeamCreateRequest | TeamLaunchRequest | Pick<TeamLaunchRequest, 'teamName'>,
  saved: TeamCreateRequest | null
) {
  const members = 'members' in request ? request.members : saved?.members;
  const provider = ('providerId' in request ? request.providerId : undefined) ?? saved?.providerId;
  const cwd = 'cwd' in request ? request.cwd : saved?.cwd;
  return {
    // A missing legacy roster remains conservative even if its lead is explicit.
    providers: members ? [provider, ...members.map((member) => member.providerId ?? provider)] : [],
    projectPaths: [...new Set([cwd, ...(members ?? []).map((member) => member.cwd)])].filter(
      (value): value is string => Boolean(value)
    ),
  };
}
