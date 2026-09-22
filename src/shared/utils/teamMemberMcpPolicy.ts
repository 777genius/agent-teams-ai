import type { TeamMemberMcpMode, TeamMemberMcpPolicy, TeamMemberMcpScope } from '@shared/types';

export const TEAM_MEMBER_MCP_SCOPES: readonly TeamMemberMcpScope[] = [
  'user',
  'project',
  'local',
] as const;

const TEAM_MEMBER_MCP_MODES = new Set<TeamMemberMcpMode>([
  'inheritLead',
  'inheritScopes',
  'strictAllowlist',
  'appOnly',
]);

const DEFAULT_MCP_SCOPES: Record<TeamMemberMcpScope, boolean> = {
  user: true,
  project: true,
  local: true,
};

function hasAnyResolvedMcpScope(scopes: Partial<Record<TeamMemberMcpScope, boolean>>): boolean {
  return TEAM_MEMBER_MCP_SCOPES.some((scope) => scopes[scope] ?? DEFAULT_MCP_SCOPES[scope]);
}

function normalizeMcpMode(value: unknown): TeamMemberMcpMode | null {
  return typeof value === 'string' && TEAM_MEMBER_MCP_MODES.has(value as TeamMemberMcpMode)
    ? (value as TeamMemberMcpMode)
    : null;
}

export function normalizeTeamMemberMcpScopes(
  value: unknown
): Partial<Record<TeamMemberMcpScope, boolean>> | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const input = value as Record<string, unknown>;
  const out: Partial<Record<TeamMemberMcpScope, boolean>> = {};
  for (const scope of TEAM_MEMBER_MCP_SCOPES) {
    if (typeof input[scope] === 'boolean') {
      out[scope] = input[scope];
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

export function normalizeTeamMemberMcpServerNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const seen = new Set<string>();
  const names: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      continue;
    }
    const name = item.trim();
    if (!name || name.length > 128) {
      continue;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    names.push(name);
    if (names.length >= 100) {
      break;
    }
  }

  return names.length > 0 ? names : undefined;
}

export function normalizeTeamMemberMcpPolicy(value: unknown): TeamMemberMcpPolicy | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const input = value as Record<string, unknown>;
  const mode = normalizeMcpMode(input.mode);
  if (!mode || mode === 'inheritLead') {
    return undefined;
  }

  const scopes = normalizeTeamMemberMcpScopes(input.scopes);
  const serverNames = normalizeTeamMemberMcpServerNames(input.serverNames);

  if (mode === 'appOnly') {
    return { mode };
  }

  if (scopes && !hasAnyResolvedMcpScope(scopes)) {
    return {
      mode: 'appOnly',
    };
  }

  if (mode === 'strictAllowlist') {
    return {
      mode,
      ...(scopes ? { scopes } : {}),
      ...(serverNames ? { serverNames } : {}),
    };
  }

  return {
    mode,
    ...(scopes ? { scopes } : {}),
  };
}

export function resolveTeamMemberMcpScopes(
  policy: TeamMemberMcpPolicy | undefined
): Record<TeamMemberMcpScope, boolean> {
  return {
    user: policy?.scopes?.user ?? DEFAULT_MCP_SCOPES.user,
    project: policy?.scopes?.project ?? DEFAULT_MCP_SCOPES.project,
    local: policy?.scopes?.local ?? DEFAULT_MCP_SCOPES.local,
  };
}

export function buildTeamMemberMcpSettingSources(policy: TeamMemberMcpPolicy | undefined): string {
  if (policy?.mode !== 'inheritScopes') {
    return 'user,project,local';
  }

  const scopes = resolveTeamMemberMcpScopes(policy);
  const selected = TEAM_MEMBER_MCP_SCOPES.filter((scope) => scopes[scope]);
  return selected.length > 0 ? selected.join(',') : 'user,project,local';
}

export function requiresStrictTeamMemberMcpConfig(
  policy: TeamMemberMcpPolicy | undefined
): boolean {
  return policy?.mode === 'strictAllowlist' || policy?.mode === 'appOnly';
}
