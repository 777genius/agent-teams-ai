import { buildMemberColorMap } from '@renderer/utils/memberHelpers';

import type { TeamSummary } from '@shared/types';

type TeamMemberColorInput = Parameters<typeof buildMemberColorMap>[0][number];

interface SidebarTeamsDerived {
  identityKey: string;
  filterTeams: { teamName: string; displayName: string }[];
  statusSummaries: TeamSummary[];
  memberColorByTeam: Map<string, Map<string, string>>;
}

let cachedSidebarTeamsSignature: string | null = null;
let cachedSidebarTeamsSource: readonly TeamSummary[] | null = null;
let cachedSidebarTeamsDerived: SidebarTeamsDerived = {
  identityKey: '',
  filterTeams: [],
  statusSummaries: [],
  memberColorByTeam: new Map(),
};
const cachedSidebarTeamSignatureByTeam = new WeakMap<TeamSummary, string>();

function encodeSignaturePart(part: unknown): string {
  const text = part == null ? '' : String(part);
  return `${text.length}:${text}|`;
}

function pushSignaturePart(parts: string[], part: unknown): void {
  parts.push(encodeSignaturePart(part));
}

function getSidebarTeamSignature(team: TeamSummary): string {
  const cached = cachedSidebarTeamSignatureByTeam.get(team);
  if (cached !== undefined) return cached;

  let signature = '';
  signature += encodeSignaturePart(team.teamName);
  signature += encodeSignaturePart(team.displayName);
  signature += encodeSignaturePart(team.projectPath);
  signature += encodeSignaturePart(team.lastActivity);
  signature += encodeSignaturePart(team.partialLaunchFailure ? 1 : 0);
  signature += encodeSignaturePart(team.teamLaunchState);
  for (const member of team.members ?? []) {
    const colorMember = member as TeamMemberColorInput;
    signature += encodeSignaturePart(colorMember.name);
    signature += encodeSignaturePart(colorMember.color);
    signature += encodeSignaturePart(colorMember.agentType);
    signature += encodeSignaturePart(colorMember.removedAt);
  }

  cachedSidebarTeamSignatureByTeam.set(team, signature);
  return signature;
}

function buildSidebarTeamsSignature(teams: readonly TeamSummary[]): string {
  let signature = '';
  for (const team of teams) {
    signature += getSidebarTeamSignature(team);
  }
  return signature;
}

function buildTeamNamesIdentityKey(teams: readonly TeamSummary[]): string {
  const signatureParts: string[] = [];
  for (const team of teams) {
    pushSignaturePart(signatureParts, team.teamName);
  }
  return signatureParts.join('');
}

export function selectSidebarTeamsDerived(teams: readonly TeamSummary[]): SidebarTeamsDerived {
  if (teams === cachedSidebarTeamsSource) {
    return cachedSidebarTeamsDerived;
  }

  const signature = buildSidebarTeamsSignature(teams);
  if (signature === cachedSidebarTeamsSignature) {
    cachedSidebarTeamsSource = teams;
    return cachedSidebarTeamsDerived;
  }

  const memberColorByTeam = new Map<string, Map<string, string>>();
  for (const team of teams) {
    if (team.members && team.members.length > 0) {
      memberColorByTeam.set(team.teamName, buildMemberColorMap(team.members));
    }
  }

  cachedSidebarTeamsSource = teams;
  cachedSidebarTeamsSignature = signature;
  cachedSidebarTeamsDerived = {
    identityKey: buildTeamNamesIdentityKey(teams),
    filterTeams: teams.map((team) => ({
      teamName: team.teamName,
      displayName: team.displayName,
    })),
    statusSummaries: teams.map((team) => ({
      teamName: team.teamName,
      displayName: team.displayName,
      description: '',
      memberCount: team.memberCount,
      taskCount: team.taskCount,
      projectPath: team.projectPath,
      lastActivity: team.lastActivity,
      partialLaunchFailure: team.partialLaunchFailure,
      teamLaunchState: team.teamLaunchState,
    })),
    memberColorByTeam,
  };
  return cachedSidebarTeamsDerived;
}
