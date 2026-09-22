import {
  getMemberColorByName,
  getParticipantIdentityColor,
  getTeammateParticipantIdentityColor,
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
  /** Legacy/custom override mode. Canonical app surfaces use avatar-aligned colors. */
  preferProvidedColors?: boolean;
}

/**
 * Build a deterministic roster color map. Canonical mode follows the same
 * lead/teammate slots as the participant avatar catalog, including wraparound.
 * Leads reserve avatar/color slot 01 and do not consume teammate slots 02-13.
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

  if (!preferProvidedColors) {
    for (const [index, member] of activeLeads.entries()) {
      map.set(
        member.name,
        index === 0 ? getParticipantIdentityColor(0) : getMemberColorByName(member.name)
      );
    }

    for (const [index, member] of activeTeammates.entries()) {
      map.set(member.name, getTeammateParticipantIdentityColor(index));
    }

    for (const member of removed) {
      map.set(
        member.name,
        isLeadMember(member) ? getParticipantIdentityColor(0) : getMemberColorByName(member.name)
      );
    }

    map.set('user', 'user');
    return map;
  }

  const usedColors = new Set<string>();
  let nextPaletteIdx = 0;

  for (const [index, member] of activeLeads.entries()) {
    const color =
      preferProvidedColors && member.color
        ? normalizeMemberColorName(member.color)
        : index === 0
          ? getParticipantIdentityColor(0)
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
        : isLeadMember(member)
          ? getParticipantIdentityColor(0)
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
