export interface StableTeamOwnerLike {
  name: string;
  agentId?: string | null;
}

export function getStableTeamOwnerId(member: StableTeamOwnerLike): string {
  const agentId = member.agentId?.trim();
  if (agentId) {
    return agentId;
  }
  return member.name.trim();
}
