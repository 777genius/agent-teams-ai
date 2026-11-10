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

const ROSTER_CONFLICT_MESSAGE = 'Secondary launch roster changed before config commit';
class RetryableRosterConflict extends Error {
  constructor(readonly originalConfig: Record<string, unknown>) {
    super(ROSTER_CONFLICT_MESSAGE);
  }
}

// Startup may add members or update liveness while the atomic write is being prepared.
// A retry must not cross a replaced team/lead, removed member, or changed runtime identity.
function canRebaseRoster(
  original: Record<string, unknown>,
  current: Record<string, unknown>
): boolean {
  if (!Array.isArray(original.members) || !Array.isArray(current.members)) return false;
  if (
    ['name', 'leadSessionId', 'leadAgentId', 'projectPath'].some(
      (key) => original[key] !== current[key]
    )
  ) {
    return false;
  }
  const identityKeys = [
    'agentId',
    'providerId',
    'provider',
    'providerBackendId',
    'model',
    'removedAt',
  ];
  const currentMembers = current.members as TeamMember[];
  return (original.members as TeamMember[]).every((member) => {
    const matches = currentMembers.filter(
      (candidate) => candidate?.name?.trim().toLowerCase() === member?.name?.trim().toLowerCase()
    );
    return (
      matches.length === 1 &&
      identityKeys.every(
        (key) =>
          (member as unknown as Record<string, unknown>)[key] ===
          (matches[0] as unknown as Record<string, unknown>)[key]
      )
    );
  });
}

/** Publish side-lane identities before runtime startup, independently of the lead's first turn. */
export async function materializeTeamProvisioningLaunchRoster(
  input: TeamProvisioningLaunchRosterInput,
  ports: TeamProvisioningLaunchRosterPorts
): Promise<boolean> {
  let originalConfig: Record<string, unknown> | undefined;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await publishLaunchRoster(input, ports, originalConfig);
    } catch (error) {
      if (!(error instanceof RetryableRosterConflict) || attempt >= 2) throw error;
      originalConfig ??= error.originalConfig;
    }
  }
}

async function publishLaunchRoster(
  input: TeamProvisioningLaunchRosterInput,
  ports: TeamProvisioningLaunchRosterPorts,
  retryBase?: Record<string, unknown>
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
  if (retryBase && !canRebaseRoster(retryBase, config)) {
    throw new Error(ROSTER_CONFLICT_MESSAGE);
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
  const originalConfig = { ...config, members: [...configMembers] };
  const previousMemberCount = configMembers.length;
  for (const member of members) {
    const name = member.name.trim().toLowerCase();
    if (existingNames.has(name)) {
      if (retryBase) {
        const matches = configMembers.filter(
          (candidate) => candidate?.name?.trim().toLowerCase() === name
        );
        const existing = matches[0];
        const legacyProvider = (existing as { provider?: unknown } | undefined)?.provider;
        if (
          matches.length !== 1 ||
          normalizeOptionalTeamProviderId(existing.providerId) !== 'opencode' ||
          (legacyProvider != null &&
            normalizeOptionalTeamProviderId(legacyProvider) !== 'opencode') ||
          (existing.providerBackendId != null && existing.providerBackendId !== 'opencode-cli') ||
          existing.model?.trim() !== member.model?.trim() ||
          existing.agentId !== `${member.name.trim()}@${input.teamName}`
        ) {
          throw new Error(ROSTER_CONFLICT_MESSAGE);
        }
      }
      continue;
    }
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
    if (!input.isCurrentRun() || hasRemovedMember(currentMeta)) {
      throw new Error(ROSTER_CONFLICT_MESSAGE);
    }
    if (currentRaw !== raw) {
      const currentConfig = currentRaw ? (JSON.parse(currentRaw) as Record<string, unknown>) : null;
      if (
        currentConfig &&
        Array.isArray(currentConfig.members) &&
        !hasRemovedMember(currentConfig.members as TeamMember[]) &&
        canRebaseRoster(originalConfig, currentConfig)
      ) {
        throw new RetryableRosterConflict(originalConfig);
      }
      throw new Error(ROSTER_CONFLICT_MESSAGE);
    }
  });
  ports.invalidateTeam(input.teamName);
  return input.isCurrentRun();
}
