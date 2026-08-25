import { fromProvisioningMembers, isMixedOpenCodeSideLanePlan } from '@features/team-runtime-lanes';
import { choosePreferredLaunchSnapshot } from '@main/services/team/TeamBootstrapStateReader';
import { hasMixedPersistedLaunchMetadata } from '@main/services/team/TeamLaunchStateEvaluator';
import { isMaterializableInboxMemberName } from '@main/services/team/TeamMemberResolver';
import { getMemberColorByName } from '@shared/constants/memberColors';
import { isTeamEffortLevel } from '@shared/utils/effortLevels';
import { isLeadMember } from '@shared/utils/leadDetection';
import { migrateProviderBackendId } from '@shared/utils/providerBackend';
import { buildTeamMemberColorMap } from '@shared/utils/teamMemberColors';
import { normalizeTeamMemberMcpPolicy } from '@shared/utils/teamMemberMcpPolicy';
import {
  createCliAutoSuffixNameGuard,
  createCliProvisionerNameGuard,
  parseNumericSuffixName,
  validateTeamMemberNameFormat,
} from '@shared/utils/teamMemberName';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import { planTeamMemberRestore } from '../../../core/domain/teamMemberRestorePlan';

import type {
  AddMemberRequest,
  PersistedTeamLaunchSnapshot,
  ReplaceMembersRequest,
  TeamConfig,
  TeamMember,
  TeamProviderId,
} from '@shared/types';

const MIXED_TEAM_LIVE_MUTATION_BLOCK_MESSAGE =
  'Live roster mutation on a running mixed team is not supported in V1. Stop the team, edit the roster, then relaunch.';

type ProvisioningMember = ReturnType<typeof toProvisioningMemberShape>[number];

interface MembersMetadataPort {
  getMembers(teamName: string): Promise<TeamMember[]>;
  updateMembers(
    teamName: string,
    update: (currentMembers: readonly TeamMember[]) => TeamMember[] | Promise<TeamMember[]>
  ): Promise<void>;
}

interface TeamConfigPort {
  getConfig(teamName: string): Promise<TeamConfig | null>;
  persistConfig(teamName: string, config: TeamConfig): Promise<void>;
}

interface TeamInboxPort {
  listInboxNames(teamName: string): Promise<string[]>;
}

interface TeamMetadataPort {
  getMeta(teamName: string): Promise<{
    providerId?: TeamProviderId;
    launchIdentity?: { providerId?: TeamProviderId };
  } | null>;
}

interface TeamLaunchSnapshotPort {
  readBootstrap(teamName: string): Promise<PersistedTeamLaunchSnapshot | null>;
  readPersisted(teamName: string): Promise<PersistedTeamLaunchSnapshot | null>;
}

interface TeamProcessPort {
  listProcesses(teamName: string): Promise<{ stoppedAt?: string }[]>;
}

export interface TeamRosterPersistenceRepositoryDependencies {
  members: MembersMetadataPort;
  config: TeamConfigPort;
  inbox: TeamInboxPort;
  teamMetadata: TeamMetadataPort;
  launchSnapshots: TeamLaunchSnapshotPort;
  processes: TeamProcessPort;
  now(): number;
}

function applyDistinctRosterColors<T extends { name: string; color?: string; removedAt?: number }>(
  members: readonly T[]
): T[] {
  const colorMap = buildTeamMemberColorMap(members, { preferProvidedColors: false });
  return members.map((member) => ({
    ...member,
    color: colorMap.get(member.name) ?? member.color ?? getMemberColorByName(member.name),
  }));
}

function toProvisioningMemberShape(
  members: readonly Pick<
    TeamMember,
    | 'name'
    | 'role'
    | 'workflow'
    | 'isolation'
    | 'providerId'
    | 'providerBackendId'
    | 'model'
    | 'effort'
    | 'fastMode'
    | 'removedAt'
  >[]
): {
  name: string;
  role?: string;
  workflow?: string;
  isolation?: 'worktree';
  providerId?: TeamProviderId;
  providerBackendId?: TeamMember['providerBackendId'];
  model?: string;
  effort?: TeamMember['effort'];
  fastMode?: TeamMember['fastMode'];
}[] {
  return members
    .filter((member) => !member.removedAt)
    .filter((member) => {
      const normalizedName = member.name.trim();
      return (
        normalizedName.length > 0 && !isLeadMember({ name: normalizedName, agentType: undefined })
      );
    })
    .map((member) => ({
      name: member.name.trim(),
      role: member.role,
      workflow: member.workflow,
      isolation: member.isolation === 'worktree' ? ('worktree' as const) : undefined,
      providerId: normalizeOptionalTeamProviderId(member.providerId),
      providerBackendId: member.providerBackendId,
      model: member.model,
      effort: isTeamEffortLevel(member.effort) ? member.effort : undefined,
      fastMode:
        member.fastMode === 'inherit' || member.fastMode === 'on' || member.fastMode === 'off'
          ? member.fastMode
          : undefined,
    }));
}

function resolveEffectiveMemberProviderId(
  leadProviderId: TeamProviderId | undefined,
  member: ProvisioningMember | undefined
): TeamProviderId {
  return normalizeOptionalTeamProviderId(member?.providerId) ?? leadProviderId ?? 'anthropic';
}

function isSupportedRunningMixedRosterMutation(params: {
  leadProviderId: TeamProviderId | undefined;
  previousMembers: ProvisioningMember[];
  nextMembers: ProvisioningMember[];
}): boolean {
  if (params.leadProviderId === 'opencode') {
    return false;
  }

  const previousByName = new Map(
    params.previousMembers.map((member) => [member.name.trim().toLowerCase(), member])
  );
  const nextByName = new Map(
    params.nextMembers.map((member) => [member.name.trim().toLowerCase(), member])
  );
  const candidateNames = new Set([...previousByName.keys(), ...nextByName.keys()]);

  for (const candidateName of candidateNames) {
    const previous = previousByName.get(candidateName);
    const next = nextByName.get(candidateName);
    const previousProviderId = resolveEffectiveMemberProviderId(params.leadProviderId, previous);
    const nextProviderId = resolveEffectiveMemberProviderId(params.leadProviderId, next);

    if (!previous && next) {
      if (nextProviderId !== 'opencode') {
        return false;
      }
      continue;
    }

    if (previous && !next) {
      if (previousProviderId !== 'opencode') {
        return false;
      }
      continue;
    }

    if (!previous || !next) {
      continue;
    }

    if (previousProviderId !== nextProviderId) {
      return false;
    }

    if (previousProviderId !== 'opencode') {
      const stablePrimaryShape = JSON.stringify({
        name: previous.name,
        role: previous.role,
        workflow: previous.workflow,
        isolation: previous.isolation,
        providerId: previous.providerId,
        providerBackendId: previous.providerBackendId,
        model: previous.model,
        effort: previous.effort,
        fastMode: previous.fastMode,
      });
      const nextPrimaryShape = JSON.stringify({
        name: next.name,
        role: next.role,
        workflow: next.workflow,
        isolation: next.isolation,
        providerId: next.providerId,
        providerBackendId: next.providerBackendId,
        model: next.model,
        effort: next.effort,
        fastMode: next.fastMode,
      });
      if (stablePrimaryShape !== nextPrimaryShape) {
        return false;
      }
    }
  }

  return true;
}

export class TeamRosterPersistenceRepository {
  constructor(private readonly dependencies: TeamRosterPersistenceRepositoryDependencies) {}

  async addMember(teamName: string, request: AddMemberRequest): Promise<void> {
    const name = request.name.trim();
    if (!name) {
      throw new Error('Member name cannot be empty');
    }
    const formatError = validateTeamMemberNameFormat(name);
    if (formatError) {
      throw new Error(`Member name "${name}" is invalid: ${formatError}`);
    }
    if (name.toLowerCase() === 'user') {
      throw new Error('Member name "user" is reserved');
    }
    const suffixInfo = parseNumericSuffixName(name);
    if (suffixInfo && suffixInfo.suffix >= 2) {
      throw new Error(
        `Member name "${name}" is not allowed (reserved for runtime-managed numeric suffixes). Use "${suffixInfo.base}" instead.`
      );
    }

    const memberProviderId = normalizeOptionalTeamProviderId(request.providerId);
    const memberProviderBackendId = memberProviderId
      ? migrateProviderBackendId(memberProviderId, request.providerBackendId)
      : request.providerBackendId;
    const newMember: TeamMember = {
      name,
      role: request.role?.trim() || undefined,
      workflow: request.workflow?.trim() || undefined,
      isolation: request.isolation === 'worktree' ? ('worktree' as const) : undefined,
      providerId: memberProviderId,
      ...(memberProviderBackendId ? { providerBackendId: memberProviderBackendId } : {}),
      model: request.model?.trim() || undefined,
      effort: isTeamEffortLevel(request.effort) ? request.effort : undefined,
      ...(request.fastMode === 'inherit' || request.fastMode === 'on' || request.fastMode === 'off'
        ? { fastMode: request.fastMode }
        : {}),
      mcpPolicy: normalizeTeamMemberMcpPolicy(request.mcpPolicy),
      agentType: 'general-purpose',
      joinedAt: this.dependencies.now(),
    };

    await this.dependencies.members.updateMembers(teamName, async (currentMembers) => {
      const current = currentMembers.find(
        (member) => member.name.trim().toLowerCase() === name.toLowerCase()
      );
      if (current?.removedAt) {
        throw new Error(`Name "${name}" was previously used by a removed member`);
      }
      if (current) {
        throw new Error(`Member "${name}" already exists`);
      }
      const nextMembers = applyDistinctRosterColors([...currentMembers, newMember]);
      await this.assertRosterMutationAllowed(
        teamName,
        toProvisioningMemberShape(nextMembers),
        currentMembers
      );
      return nextMembers;
    });
  }

  async updateMemberRole(
    teamName: string,
    memberName: string,
    newRole: string | undefined
  ): Promise<{ oldRole: string | undefined; changed: boolean }> {
    await this.ensureMemberInMeta(teamName, memberName);
    const normalizedMemberName = memberName.trim().toLowerCase();
    const normalized = typeof newRole === 'string' && newRole.trim() ? newRole.trim() : undefined;
    let oldRole: string | undefined;
    let changed = false;

    await this.dependencies.members.updateMembers(teamName, (members) => {
      const member = members.find(
        (candidate) => candidate.name.trim().toLowerCase() === normalizedMemberName
      );
      if (!member) throw new Error(`Member "${memberName}" not found`);
      if (member.removedAt) throw new Error(`Member "${memberName}" is removed`);
      if (isLeadMember(member)) throw new Error('Cannot change team lead role');

      oldRole = member.role;
      changed = oldRole !== normalized;
      return changed
        ? members.map((candidate) =>
            candidate === member ? { ...candidate, role: normalized } : candidate
          )
        : [...members];
    });
    return { oldRole, changed };
  }

  async replaceMembers(teamName: string, request: ReplaceMembersRequest): Promise<void> {
    const joinedAt = this.dependencies.now();
    const buildNextMembers = (currentMembers: readonly TeamMember[]): TeamMember[] => {
      const existingLead = currentMembers.find(isLeadMember) ?? null;
      const existingByName = new Map(
        currentMembers.map((member) => [member.name.toLowerCase(), member])
      );
      const nextByName = new Set<string>();
      const nextActive = applyDistinctRosterColors(
        request.members.map((member) => {
          const name = member.name.trim();
          if (!name) throw new Error('Member name cannot be empty');
          const formatError = validateTeamMemberNameFormat(name);
          if (formatError) {
            throw new Error(`Member name "${name}" is invalid: ${formatError}`);
          }
          if (name.toLowerCase() === 'user') {
            throw new Error('Member name "user" is reserved');
          }
          if (name.toLowerCase() === 'team-lead') {
            throw new Error('Member name "team-lead" is reserved');
          }
          if (nextByName.has(name.toLowerCase())) {
            throw new Error(`Member "${name}" already exists`);
          }
          const suffixInfo = parseNumericSuffixName(name);
          if (suffixInfo && suffixInfo.suffix >= 2) {
            throw new Error(
              `Member name "${name}" is not allowed (reserved for runtime-managed numeric suffixes). Use "${suffixInfo.base}" instead.`
            );
          }
          nextByName.add(name.toLowerCase());
          const previous = existingByName.get(name.toLowerCase());
          const isSameActiveMember = Boolean(previous && previous.removedAt == null);
          const providerId = normalizeOptionalTeamProviderId(member.providerId);
          const providerBackendId = providerId
            ? migrateProviderBackendId(providerId, member.providerBackendId)
            : member.providerBackendId;
          return {
            name,
            role: member.role?.trim() || undefined,
            workflow: member.workflow?.trim() || undefined,
            isolation: member.isolation === 'worktree' ? ('worktree' as const) : undefined,
            providerId,
            providerBackendId,
            model: member.model?.trim() || undefined,
            effort: isTeamEffortLevel(member.effort) ? member.effort : undefined,
            fastMode:
              member.fastMode === 'inherit' || member.fastMode === 'on' || member.fastMode === 'off'
                ? member.fastMode
                : undefined,
            mcpPolicy: normalizeTeamMemberMcpPolicy(member.mcpPolicy),
            agentType: previous?.agentType ?? 'general-purpose',
            agentId: isSameActiveMember ? previous?.agentId : undefined,
            color: previous?.color,
            joinedAt: previous?.joinedAt ?? joinedAt,
            removedAt: undefined,
          };
        })
      );

      const nextRemoved: TeamMember[] = [];
      for (const previous of currentMembers) {
        if (isLeadMember(previous)) continue;
        const previousName = previous.name.trim();
        if (!previousName) continue;
        const key = previousName.toLowerCase();
        if (nextByName.has(key)) continue;
        nextRemoved.push({
          ...previous,
          removedAt: previous.removedAt ?? joinedAt,
        });
      }

      const output: TeamMember[] = [...nextActive, ...nextRemoved];
      if (existingLead) {
        const leadKey = existingLead.name.trim().toLowerCase();
        if (!output.some((member) => member.name.trim().toLowerCase() === leadKey)) {
          output.unshift({ ...existingLead, removedAt: undefined });
        }
      }
      return output;
    };

    await this.dependencies.members.updateMembers(teamName, async (currentMembers) => {
      const nextMembers = buildNextMembers(currentMembers);
      await this.assertRosterMutationAllowed(
        teamName,
        toProvisioningMemberShape(nextMembers),
        currentMembers
      );
      return nextMembers;
    });
  }

  async removeMember(teamName: string, memberName: string): Promise<void> {
    await this.ensureMemberInMeta(teamName, memberName);
    const normalizedName = memberName.trim().toLowerCase();
    const removedAt = this.dependencies.now();
    await this.dependencies.members.updateMembers(teamName, async (currentMembers) => {
      const current = currentMembers.find(
        (candidate) => candidate.name.trim().toLowerCase() === normalizedName
      );
      if (!current) {
        throw new Error(`Member "${memberName}" not found`);
      }
      if (current.removedAt) {
        return [...currentMembers];
      }
      if (isLeadMember(current)) {
        throw new Error('Cannot remove team lead');
      }
      const nextMembers = currentMembers.map((candidate) =>
        candidate === current ? { ...candidate, removedAt } : candidate
      );
      await this.assertRosterMutationAllowed(
        teamName,
        toProvisioningMemberShape(nextMembers),
        currentMembers
      );
      return nextMembers;
    });
  }

  async restoreMember(teamName: string, memberName: string): Promise<TeamMember> {
    const config = await this.dependencies.config.getConfig(teamName);
    let persistedMember: TeamMember | undefined;
    let configAfterMetadata: TeamConfig | undefined;
    await this.dependencies.members.updateMembers(teamName, async (currentMembers) => {
      const plan = planTeamMemberRestore({ memberName, members: currentMembers, config });
      const updatedMembers = applyDistinctRosterColors(plan.nextMembers);
      persistedMember =
        updatedMembers.find(
          (candidate) => candidate.name.trim().toLowerCase() === plan.normalizedMemberName
        ) ?? plan.restoredMember;
      await this.assertRosterMutationAllowed(
        teamName,
        toProvisioningMemberShape(updatedMembers),
        currentMembers
      );
      if (!plan.persistMetadataFirst && plan.nextConfig) {
        await this.dependencies.config.persistConfig(teamName, plan.nextConfig);
      } else if (plan.persistMetadataFirst) {
        configAfterMetadata = plan.nextConfig;
      }
      return updatedMembers;
    });
    if (configAfterMetadata) {
      await this.dependencies.config.persistConfig(teamName, configAfterMetadata);
    }
    if (!persistedMember) {
      throw new Error(`Member "${memberName}" not found after restore`);
    }
    return persistedMember;
  }

  private async ensureMemberInMeta(
    teamName: string,
    memberName: string
  ): Promise<{ members: TeamMember[]; member: TeamMember }> {
    const members = await this.dependencies.members.getMembers(teamName);
    const normalizedMemberName = memberName.trim().toLowerCase();
    const existingMember = members.find(
      (candidate) => candidate.name.trim().toLowerCase() === normalizedMemberName
    );
    if (existingMember) {
      return { members, member: existingMember };
    }

    const config = await this.dependencies.config.getConfig(teamName);
    const inboxNames = await this.dependencies.inbox.listInboxNames(teamName);
    const joinedAt = this.dependencies.now();
    let updatedMembers: TeamMember[] = [];
    let updatedMember: TeamMember | undefined;

    await this.dependencies.members.updateMembers(teamName, (currentMembers) => {
      const knownNames = new Set(currentMembers.map((member) => member.name.trim().toLowerCase()));
      const migratedMembers: TeamMember[] = [];

      for (const configMember of config?.members ?? []) {
        const name = typeof configMember?.name === 'string' ? configMember.name.trim() : '';
        const normalizedName = name.toLowerCase();
        if (
          !name ||
          normalizedName === 'user' ||
          isLeadMember(configMember) ||
          knownNames.has(normalizedName)
        ) {
          continue;
        }
        const providerId = normalizeOptionalTeamProviderId(configMember.providerId);
        migratedMembers.push({
          name,
          role: configMember.role,
          workflow: configMember.workflow,
          isolation: configMember.isolation === 'worktree' ? ('worktree' as const) : undefined,
          providerId,
          providerBackendId: migrateProviderBackendId(providerId, configMember.providerBackendId),
          model: configMember.model,
          effort: isTeamEffortLevel(configMember.effort) ? configMember.effort : undefined,
          fastMode: configMember.fastMode,
          mcpPolicy: normalizeTeamMemberMcpPolicy(configMember.mcpPolicy),
          agentType: configMember.agentType ?? 'general-purpose',
          color: configMember.color,
          joinedAt: configMember.joinedAt ?? joinedAt,
          agentId: configMember.agentId,
          cwd: configMember.cwd,
        });
        knownNames.add(normalizedName);
      }

      const rosterNames = [
        ...currentMembers.map((member) => member.name),
        ...migratedMembers.map((member) => member.name),
        ...inboxNames.map((name) => name.trim()).filter(Boolean),
      ];
      const keepAutoSuffix = createCliAutoSuffixNameGuard(rosterNames);
      const keepProvisioner = createCliProvisionerNameGuard(rosterNames);
      const explicitNames = new Set(knownNames);
      for (const inboxName of inboxNames) {
        const name = inboxName.trim();
        const normalizedName = name.toLowerCase();
        if (
          !name ||
          normalizedName === 'user' ||
          isLeadMember({ name, agentType: undefined }) ||
          knownNames.has(normalizedName) ||
          !isMaterializableInboxMemberName(name, explicitNames) ||
          !keepAutoSuffix(name) ||
          !keepProvisioner(name)
        ) {
          continue;
        }
        migratedMembers.push({ name, agentType: 'general-purpose', joinedAt });
        knownNames.add(normalizedName);
      }

      updatedMembers =
        migratedMembers.length > 0
          ? applyDistinctRosterColors([...currentMembers, ...migratedMembers])
          : [...currentMembers];
      updatedMember = updatedMembers.find(
        (candidate) => candidate.name.trim().toLowerCase() === normalizedMemberName
      );
      if (!updatedMember) {
        throw new Error(`Member "${memberName}" not found`);
      }
      return updatedMembers;
    });

    return { members: updatedMembers, member: updatedMember! };
  }

  private async readTeamLaneMutationContext(
    teamName: string,
    rosterSnapshot?: readonly TeamMember[]
  ): Promise<{
    leadProviderId: TeamProviderId | undefined;
    activeMembers: ProvisioningMember[];
    currentMixed: boolean;
  }> {
    const [teamMeta, activeMembersRaw, bootstrapSnapshot, persistedLaunchSnapshot] =
      await Promise.all([
        this.dependencies.teamMetadata.getMeta(teamName).catch(() => null),
        rosterSnapshot
          ? Promise.resolve(rosterSnapshot)
          : this.dependencies.members.getMembers(teamName).catch(() => []),
        this.dependencies.launchSnapshots.readBootstrap(teamName).catch(() => null),
        this.dependencies.launchSnapshots.readPersisted(teamName).catch(() => null),
      ]);

    const preferredLaunchSnapshot = choosePreferredLaunchSnapshot(
      bootstrapSnapshot,
      persistedLaunchSnapshot
    );
    const leadProviderId =
      teamMeta?.launchIdentity?.providerId ?? normalizeOptionalTeamProviderId(teamMeta?.providerId);
    const activeMembers = toProvisioningMemberShape(activeMembersRaw);
    const currentPlan = fromProvisioningMembers(leadProviderId, activeMembers);
    const currentMixed =
      hasMixedPersistedLaunchMetadata(preferredLaunchSnapshot) ||
      (currentPlan.ok && isMixedOpenCodeSideLanePlan(currentPlan.plan));

    return {
      leadProviderId,
      activeMembers,
      currentMixed,
    };
  }

  private async assertRosterMutationAllowed(
    teamName: string,
    nextMembers: ProvisioningMember[],
    rosterSnapshot?: readonly TeamMember[]
  ): Promise<void> {
    const context = await this.readTeamLaneMutationContext(teamName, rosterSnapshot);
    const nextPlan = fromProvisioningMembers(context.leadProviderId, nextMembers);
    if (!nextPlan.ok) {
      throw new Error(nextPlan.message);
    }
    const nextMixed = isMixedOpenCodeSideLanePlan(nextPlan.plan);
    if (!(context.currentMixed || nextMixed)) {
      return;
    }
    const isRunning = (
      await this.dependencies.processes
        .listProcesses(teamName)
        .catch(() => [] as { stoppedAt?: string }[])
    ).some((process) => !process.stoppedAt);
    if (
      isRunning &&
      !isSupportedRunningMixedRosterMutation({
        leadProviderId: context.leadProviderId,
        previousMembers: context.activeMembers,
        nextMembers,
      })
    ) {
      throw new Error(MIXED_TEAM_LIVE_MUTATION_BLOCK_MESSAGE);
    }
  }
}
