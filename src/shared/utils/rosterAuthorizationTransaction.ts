import type { ReplaceMembersRequest } from '@shared/types/team';

/** Canonical wire/domain DTO: absent optional properties are omitted, never encoded as undefined. */
export function normalizeRosterAuthorizationMembers(
  members: readonly ReplaceMembersRequest['members'][number][]
): ReplaceMembersRequest['members'] {
  return members.map((member) =>
    Object.fromEntries(Object.entries(member).filter(([, value]) => value !== undefined))
  ) as ReplaceMembersRequest['members'];
}

export function normalizeRosterAuthorizationRequest(
  request: ReplaceMembersRequest
): ReplaceMembersRequest {
  return { members: normalizeRosterAuthorizationMembers(request.members) };
}
