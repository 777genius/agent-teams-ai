import { fingerprintSavedLaunchSettings } from '@features/team-provisioning/contracts';
import { createMemberSettingsFingerprint } from '@features/team-provisioning/main';
import { TeamMetaStore } from '@main/services/team/TeamMetaStore';
import { isCanonicalSettingsLeadMember } from '@shared/utils/leadDetection';

import type { DefinitionEditPorts } from './ipc/teams/teamProjectDefinitionEdit';
import type { UpdateMemberSettingsRequest } from '@features/team-provisioning/contracts';
import type { TeamMemberSettingsFeatureApi } from '@features/team-provisioning/main';

/** The caller holds the logical-team lock and has confirmed all project runtimes are stopped. */
export async function assertProjectMemberSettingsRelaunchBaseline(
  request: UpdateMemberSettingsRequest,
  ports: DefinitionEditPorts,
  targets: TeamMemberSettingsFeatureApi
): Promise<void> {
  const guard = request.relaunchGuard;
  if (!guard) return;
  const [meta, saved] = await Promise.all([
    new TeamMetaStore().getMeta(request.teamName, undefined, { requireCompleteFields: true }),
    ports.data().getSavedRequest(request.teamName),
  ]);
  if (
    !meta ||
    !saved ||
    fingerprintSavedLaunchSettings(meta) !== guard.expectedTeamSettingsFingerprint
  ) {
    throw new Error('Team launch settings changed. Reopen member settings.');
  }
  const resolved = await Promise.all(
    guard.baseline.map(async (row) => {
      const target = await targets.getMemberSettingsTarget({
        teamName: request.teamName,
        memberName: row.memberName,
      });
      if (!target || createMemberSettingsFingerprint(target) !== row.expectedFingerprint) {
        throw new Error('Team settings changed. Reopen member settings.');
      }
      return target;
    })
  );
  const leads = resolved.filter((target) =>
    isCanonicalSettingsLeadMember({
      name: target.name,
      agentType: target.agentType,
      role: target.settings.role,
    })
  );
  if (leads.length !== 1) throw new Error('Team lead changed. Reopen member settings.');
  const currentNames = [
    ...new Set(
      [leads[0].name, ...saved.members.map((member) => member.name)].map((name) =>
        name.trim().toLowerCase()
      )
    ),
  ].sort();
  const baselineNames = guard.baseline.map((row) => row.memberName.trim().toLowerCase()).sort();
  if (JSON.stringify(currentNames) !== JSON.stringify(baselineNames)) {
    throw new Error('Team roster changed. Reopen member settings.');
  }
}
