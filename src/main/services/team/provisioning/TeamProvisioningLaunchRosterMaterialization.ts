import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import { buildOpenCodeConfigMemberFromLaunchMember } from './TeamProvisioningConfigMaterialization';

import type { TeamCreateRequest, TeamMember } from '@shared/types';

export interface TeamProvisioningLaunchRosterInput {
  teamName: string;
  members: TeamCreateRequest['members'];
  isCurrentRun(): boolean;
}

export interface TeamProvisioningLaunchRosterPorts {
  readConfig(): Promise<string | null>;
  readMetaMembers(): Promise<readonly TeamMember[]>;
  writeConfig(raw: string, beforeCommit: () => Promise<void>): Promise<void>;
  invalidateTeam(teamName: string): void;
  now(): number;
}

/** Publish side-lane identities before runtime startup, independently of the lead's first turn. */
export async function materializeTeamProvisioningLaunchRoster(
  input: TeamProvisioningLaunchRosterInput,
  ports: TeamProvisioningLaunchRosterPorts
): Promise<boolean> {
  if (!input.isCurrentRun()) return false;
  const members = input.members.filter(
    (member) => normalizeOptionalTeamProviderId(member.providerId) === 'opencode'
  );
  if (members.length === 0) return true;

  const raw = await ports.readConfig();
  if (!input.isCurrentRun()) return false;
  if (!raw) throw new Error('Cannot prepare secondary launch: config.json unreadable');
  const config = JSON.parse(raw) as Record<string, unknown>;
  if (!Array.isArray(config.members)) {
    throw new Error('Cannot prepare secondary launch: config members missing');
  }
  const configMembers = config.members as TeamMember[];
  const names = new Set(members.map((member) => member.name.trim().toLowerCase()));
  const hasRemovedMember = (roster: readonly TeamMember[]): boolean =>
    roster.some(
      (member) =>
        member &&
        typeof member.name === 'string' &&
        names.has(member.name.trim().toLowerCase()) &&
        member.removedAt != null
    );
  const metaMembers = await ports.readMetaMembers();
  if (!input.isCurrentRun() || hasRemovedMember(configMembers) || hasRemovedMember(metaMembers)) {
    return false;
  }

  const existingNames = new Set(
    configMembers.map((member) => member?.name?.trim().toLowerCase()).filter(Boolean)
  );
  const previousMemberCount = configMembers.length;
  for (const member of members) {
    const name = member.name.trim().toLowerCase();
    if (existingNames.has(name)) continue;
    config.members.push(
      buildOpenCodeConfigMemberFromLaunchMember(input.teamName, member, { now: ports.now })
    );
    existingNames.add(name);
  }
  const nextRaw = JSON.stringify(config, null, 2);
  if (configMembers.length === previousMemberCount) {
    return input.isCurrentRun();
  }

  await ports.writeConfig(nextRaw, async () => {
    const currentRaw = await ports.readConfig();
    const currentMeta = await ports.readMetaMembers();
    if (!input.isCurrentRun() || currentRaw !== raw || hasRemovedMember(currentMeta)) {
      throw new Error('Secondary launch roster changed before config commit');
    }
  });
  ports.invalidateTeam(input.teamName);
  return input.isCurrentRun();
}
