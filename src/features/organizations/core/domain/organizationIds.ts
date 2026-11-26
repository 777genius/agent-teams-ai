const SAFE_ID_RE = /[^a-zA-Z0-9._:-]+/g;

export function normalizeOrganizationId(value: string | undefined, fallback = 'default'): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return fallback;
  }
  const normalized = trimmed.replace(SAFE_ID_RE, '-').replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

export function getOrganizationNodeId(organizationId: string): string {
  return `org:${normalizeOrganizationId(organizationId)}`;
}

export function organizationTeamIdentity(teamName: string, fallback = 'unknown-team'): string {
  // Percent-encoded opaque Host handles must not collide through punctuation normalization.
  return teamName.startsWith('host-team:')
    ? `host-team:key:${Array.from(teamName, character => character.charCodeAt(0).toString(16).padStart(2, '0')).join('')}`
    : normalizeOrganizationId(teamName, fallback);
}

export function getTeamNodeId(teamName: string): string {
  return `team:${organizationTeamIdentity(teamName)}`;
}

export function getOrgUnitNodeId(unitId: string, fallback = 'unit'): string {
  const normalized = normalizeOrganizationId(unitId, fallback);
  return /^(org|team|unit):/.test(normalized) ? normalized : `unit:${normalized}`;
}

export function getRelationId(kind: string, sourceNodeId: string, targetNodeId: string): string {
  return `rel:${kind}:${sourceNodeId}->${targetNodeId}`;
}

export function getAgentId(teamName: string, memberName: string): string {
  return `agent:${organizationTeamIdentity(teamName, 'team')}:${normalizeOrganizationId(memberName, 'member')}`;
}
