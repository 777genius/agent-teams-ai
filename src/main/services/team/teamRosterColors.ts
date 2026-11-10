import { getMemberColorByName } from '@shared/constants/memberColors';
import { buildTeamMemberColorMap } from '@shared/utils/teamMemberColors';

export function applyDistinctRosterColors<
  T extends { name: string; color?: string; removedAt?: number },
>(members: readonly T[]): T[] {
  const colorMap = buildTeamMemberColorMap(members, { preferProvidedColors: false });
  return members.map((member) => ({
    ...member,
    color: colorMap.get(member.name) ?? member.color ?? getMemberColorByName(member.name),
  }));
}
