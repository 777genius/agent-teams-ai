import {
  isCanonicalSettingsLead,
  memberSettingsTargetToMember,
} from '@features/team-provisioning/renderer';
import { api } from '@renderer/api';

import type { ResolvedTeamMember } from '@shared/types';

/** The saved roster of the definition, with the edited member exactly as main compares it. */
export async function loadDefinitionMembers(
  logicalTeamName: string,
  memberName: string,
  preferredLeadName?: string
): Promise<ResolvedTeamMember[] | 'team_missing' | 'member_missing'> {
  const [saved, target] = await Promise.all([
    api.teams.getSavedRequest(logicalTeamName),
    api.teams.getMemberSettingsTarget({ teamName: logicalTeamName, memberName }),
  ]);
  if (!saved) return 'team_missing';
  // The open project may still show a member that the definition no longer has.
  if (!target) return 'member_missing';
  const edited = memberSettingsTargetToMember(target);
  if (
    !isCanonicalSettingsLead(edited) &&
    !saved.members.some((member) => member.name.toLowerCase() === edited.name.toLowerCase())
  ) {
    return 'member_missing';
  }
  // Fingerprints include saved member identities. Read every target rather than rebuilding
  // sibling rows from the launch request, which deliberately omits those identities.
  const rows = await Promise.all(
    saved.members.map(async (member) => {
      if (member.name.toLowerCase() === edited.name.toLowerCase()) return edited;
      const current = await api.teams.getMemberSettingsTarget({
        teamName: logicalTeamName,
        memberName: member.name,
      });
      return current ? memberSettingsTargetToMember(current) : null;
    })
  );
  if (rows.some((row) => row === null)) return 'member_missing';
  const others = rows.filter(
    (row): row is ResolvedTeamMember =>
      row !== null && row.name.toLowerCase() !== edited.name.toLowerCase()
  );
  if (isCanonicalSettingsLead(edited)) return [edited, ...others];
  // The logical definition may retain a lead named "lead", "team-lead", or a custom name.
  // Resolve its real identity instead of inventing one for the relaunch baseline.
  for (const name of new Set(
    [preferredLeadName, 'team-lead', 'lead'].filter((value): value is string => Boolean(value))
  )) {
    const lead = await api.teams.getMemberSettingsTarget({
      teamName: logicalTeamName,
      memberName: name,
    });
    if (!lead) continue;
    const resolved = memberSettingsTargetToMember(lead);
    if (isCanonicalSettingsLead(resolved)) return [resolved, ...others, edited];
  }
  return 'member_missing';
}
