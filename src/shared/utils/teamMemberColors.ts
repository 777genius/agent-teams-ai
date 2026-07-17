import {
  getMemberColorByName,
  MEMBER_COLOR_PALETTE,
  normalizeMemberColorName,
  TEAM_LEAD_MEMBER_COLOR_ID,
} from '@shared/constants/memberColors';
import { isLeadMember } from '@shared/utils/leadDetection';

export interface TeamMemberColorInput {
  name: string;
  color?: string;
  removedAt?: number | string | null;
  agentType?: string;
}

interface BuildTeamMemberColorMapOptions {
  preferProvidedColors?: boolean;
}

/**
 * Build a deterministic roster color map that optimizes contrast inside a team.
 * Leads reserve their own color but do not consume the teammate palette order.
 */
export function buildTeamMemberColorMap(
  members: readonly TeamMemberColorInput[],
  options: BuildTeamMemberColorMapOptions = {}
): Map<string, string> {
  const preferProvidedColors = options.preferProvidedColors ?? true;
  const map = new Map<string, string>();
  const active = members.filter((member) => !member.removedAt);
  const removed = members.filter((member) => member.removedAt);
  const activeLeads = active.filter((member) => isLeadMember(member));
  const activeTeammates = active.filter((member) => !isLeadMember(member));
  const usedColors = new Set<string>();
  let nextPaletteIdx = 0;

  for (const member of activeLeads) {
    const color =
      preferProvidedColors && member.color
        ? normalizeMemberColorName(member.color)
        : getMemberColorByName(member.name);
    map.set(member.name, color);
    usedColors.add(color);
  }

  for (const member of activeTeammates) {
    let color =
      preferProvidedColors && member.color ? normalizeMemberColorName(member.color) : undefined;
    if (!color || usedColors.has(color)) {
      while (
        nextPaletteIdx < MEMBER_COLOR_PALETTE.length &&
        usedColors.has(MEMBER_COLOR_PALETTE[nextPaletteIdx])
      ) {
        nextPaletteIdx += 1;
      }
      color =
        nextPaletteIdx < MEMBER_COLOR_PALETTE.length
          ? MEMBER_COLOR_PALETTE[nextPaletteIdx]
          : MEMBER_COLOR_PALETTE[activeTeammates.indexOf(member) % MEMBER_COLOR_PALETTE.length];
      nextPaletteIdx += 1;
    }
    map.set(member.name, color);
    usedColors.add(color);
  }

  for (const member of removed) {
    const color =
      preferProvidedColors && member.color
        ? normalizeMemberColorName(member.color)
        : getMemberColorByName(member.name);
    map.set(member.name, color);
  }

  map.set('user', 'user');

  return map;
}

/**
 * Resolve the visual color for a standalone member preview by reusing the same
 * roster color pipeline that powers the team screen.
 */
export function resolveTeamMemberColorName(
  member: TeamMemberColorInput,
  options: BuildTeamMemberColorMapOptions = {}
): string {
  const color = buildTeamMemberColorMap([member], options).get(member.name);
  if (color) {
    return color;
  }

  if (options.preferProvidedColors !== false && member.color) {
    return normalizeMemberColorName(member.color);
  }

  return getMemberColorByName(member.name);
}

export function resolveTeamLeadColorName(): string {
  return resolveTeamMemberColorName(
    {
      name: TEAM_LEAD_MEMBER_COLOR_ID,
      agentType: 'team-lead',
    },
    { preferProvidedColors: false }
  );
}
