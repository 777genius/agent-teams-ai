import { fromProvisioningMembers, isMixedOpenCodeSideLanePlan } from '@features/team-runtime-lanes';
import { atomicWriteAsync } from '@main/services/team/atomicWrite';
import { withFileLock } from '@main/services/team/fileLock';
import { TeamConfigReader } from '@main/services/team/TeamConfigReader';
import { TeamMembersMetaStore } from '@main/services/team/TeamMembersMetaStore';
import { TeamMetaStore } from '@main/services/team/TeamMetaStore';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { isTeamEffortLevel } from '@shared/utils/effortLevels';
import { isLeadMember } from '@shared/utils/leadDetection';
import { migrateProviderBackendId } from '@shared/utils/providerBackend';
import { normalizeTeamMemberMcpPolicy } from '@shared/utils/teamMemberMcpPolicy';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';
import * as fs from 'fs';
import * as path from 'path';

import { MemberSettingsPersistenceFailedError } from '../../../core/application/ports/UpdateMemberSettingsPorts';
import { createMemberSettingsFingerprint } from '../../../core/domain/memberSettingsPolicy';

import type {
  EditableMemberSettings,
  MemberSettingsEffort,
  MemberSettingsFastMode,
  MemberSettingsProviderBackendId,
  MemberSettingsProviderId,
} from '../../../contracts/memberSettings';
import type {
  ApplyMemberSettingsResult,
  MemberSettingsRepositoryPort,
} from '../../../core/application/ports/UpdateMemberSettingsPorts';
import type { MemberSettingsTargetSnapshot } from '../../../core/domain/memberSettingsPolicy';
import type { TeamMembersMetaFile } from '@main/services/team/TeamMembersMetaStore';
import type { TeamMember } from '@shared/types';

type JsonMember = Record<string, unknown> & { name?: unknown; removedAt?: unknown };
type JsonTeamConfig = Record<string, unknown> & { members?: JsonMember[] };

export interface LegacyMemberSettingsRepositoryDependencies {
  membersMetaStore: Pick<TeamMembersMetaStore, 'getMeta' | 'writeMembers'>;
  readConfigJson(teamName: string): Promise<string | null>;
  writeConfigJsonAtomic(teamName: string, contents: string): Promise<void>;
  withConfigLock<T>(teamName: string, operation: () => Promise<T>): Promise<T>;
  readLeadProviderId(teamName: string): Promise<MemberSettingsProviderId | null>;
  readSyntheticLeadMember?(teamName: string): Promise<TeamMember | null>;
  teamExists(teamName: string): Promise<boolean>;
  isTeamAlive(teamName: string): boolean | Promise<boolean>;
  invalidateCaches(teamName: string): void;
}

interface LoadedTarget {
  config: JsonTeamConfig | null;
  configMember: JsonMember | null;
  configMemberIndex: number;
  meta: TeamMembersMetaFile | null;
  metaMember: TeamMember | null;
  metaMemberIndex: number;
  snapshot: MemberSettingsTargetSnapshot;
}

interface LegacyTargetRollbackToken {
  kind: 'legacy-member-settings-v1';
  memberName: string;
  metadataMember: TeamMember | null;
  configMember: JsonMember | null;
}

const SETTINGS_FIELDS = [
  'role',
  'workflow',
  'isolation',
  'providerId',
  'providerBackendId',
  'model',
  'effort',
  'fastMode',
  'mcpPolicy',
] as const;

function matchesName(candidate: unknown, requested: unknown): boolean {
  return (
    typeof candidate === 'string' &&
    typeof requested === 'string' &&
    candidate.trim().toLowerCase() === requested.trim().toLowerCase()
  );
}

function isRemovedMember(member: { removedAt?: unknown } | null): boolean {
  return member?.removedAt !== undefined && member.removedAt !== null;
}

function isPersistedLeadMember(member: JsonMember | TeamMember): boolean {
  if (isRemovedMember(member) || !member) return false;
  if (isLeadMember(member)) return true;
  const name = optionalText(member.name)?.toLowerCase();
  const role = optionalText(member.role)?.toLowerCase();
  return name === 'lead' || role === 'lead' || role === 'team lead' || role === 'team-lead';
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function providerId(value: unknown): MemberSettingsProviderId | null {
  return normalizeOptionalTeamProviderId(value) ?? null;
}

function backendId(value: unknown): MemberSettingsProviderBackendId | null {
  return value === 'auto' ||
    value === 'adapter' ||
    value === 'api' ||
    value === 'cli-sdk' ||
    value === 'codex-native' ||
    value === 'opencode-cli'
    ? value
    : null;
}

function effort(value: unknown): MemberSettingsEffort | null {
  return value === 'none' ||
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max' ||
    value === 'ultra'
    ? value
    : null;
}

function fastMode(value: unknown): MemberSettingsFastMode | null {
  return value === 'inherit' || value === 'on' || value === 'off' ? value : null;
}

function preferred(meta: TeamMember | null, config: JsonMember | null, field: string): unknown {
  const configValue = config?.[field];
  return configValue !== undefined ? configValue : meta?.[field as keyof TeamMember];
}

function readSettings(meta: TeamMember | null, config: JsonMember | null): EditableMemberSettings {
  const rawPolicy = preferred(meta, config, 'mcpPolicy');
  return {
    role: optionalText(preferred(meta, config, 'role')),
    workflow: optionalText(preferred(meta, config, 'workflow')),
    isolation: preferred(meta, config, 'isolation') === 'worktree' ? 'worktree' : null,
    providerId: providerId(config?.providerId ?? config?.provider ?? meta?.providerId),
    providerBackendId: backendId(preferred(meta, config, 'providerBackendId')),
    model: optionalText(preferred(meta, config, 'model')),
    effort: effort(preferred(meta, config, 'effort')),
    fastMode: fastMode(preferred(meta, config, 'fastMode')),
    mcpPolicy:
      rawPolicy && typeof rawPolicy === 'object'
        ? (normalizeTeamMemberMcpPolicy(rawPolicy) ?? null)
        : null,
  };
}

function setOptional(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === null) {
    delete target[key];
  } else {
    target[key] = structuredClone(value);
  }
}

function applySettings(
  member: object,
  settings: EditableMemberSettings,
  includeLegacyProvider: boolean
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...member };
  for (const field of SETTINGS_FIELDS) {
    setOptional(next, field, settings[field]);
  }
  if (includeLegacyProvider) {
    setOptional(next, 'provider', settings.providerId);
  }
  return next;
}

function rollbackToken(current: LoadedTarget): LegacyTargetRollbackToken {
  return {
    kind: 'legacy-member-settings-v1',
    memberName: current.snapshot.name,
    metadataMember: current.metaMember ? structuredClone(current.metaMember) : null,
    configMember: current.configMember ? structuredClone(current.configMember) : null,
  };
}

function isRollbackToken(value: unknown): value is LegacyTargetRollbackToken {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    (value as { kind?: unknown }).kind === 'legacy-member-settings-v1'
  );
}

function parseConfig(raw: string | null): JsonTeamConfig | null {
  if (!raw) return null;
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object') return null;
  const config = parsed as JsonTeamConfig;
  if (config.members !== undefined && !Array.isArray(config.members)) {
    throw new Error('Team config members must be an array');
  }
  return { ...config, members: config.members ?? [] };
}

/** Target-scoped adapter over legacy members.meta.json and config.json persistence. */
export class LegacyMemberSettingsRepositoryAdapter implements MemberSettingsRepositoryPort {
  constructor(private readonly dependencies: LegacyMemberSettingsRepositoryDependencies) {}

  async findTarget(
    teamName: string,
    memberName: string
  ): Promise<MemberSettingsTargetSnapshot | null> {
    return (await this.loadTarget(teamName, memberName))?.snapshot ?? null;
  }

  async classifyMissingTarget(teamName: string): Promise<'member_not_found' | 'team_not_found'> {
    return (await this.dependencies.teamExists(teamName)) ? 'member_not_found' : 'team_not_found';
  }

  async applyTarget(input: {
    teamName: string;
    memberName: string;
    expectedFingerprint: string;
    settings: EditableMemberSettings;
  }): Promise<ApplyMemberSettingsResult> {
    return this.dependencies.withConfigLock(input.teamName, async () => {
      const current = await this.loadTarget(input.teamName, input.memberName);
      if (
        !current ||
        createMemberSettingsFingerprint(current.snapshot) !== input.expectedFingerprint
      ) {
        return { outcome: 'target_conflict', current: current?.snapshot ?? null };
      }

      const previous = rollbackToken(current);
      await this.persistSettings(current, input.teamName, input.settings);
      try {
        const persisted = await this.loadTarget(input.teamName, current.snapshot.name);
        if (!persisted) {
          throw new Error(`Updated member disappeared from persistence: ${current.snapshot.name}`);
        }
        return { outcome: 'applied', snapshot: persisted.snapshot, rollbackToken: previous };
      } catch (error) {
        try {
          await this.restoreLoadedTarget(input.teamName, current);
        } catch (rollbackError) {
          throw new MemberSettingsPersistenceFailedError(
            `Target persistence and rollback failed for ${input.teamName}/${current.snapshot.name}`,
            true,
            new AggregateError([error, rollbackError])
          );
        }
        throw new MemberSettingsPersistenceFailedError(
          `Target persistence failed for ${input.teamName}/${current.snapshot.name}`,
          false,
          error
        );
      }
    });
  }

  async restoreTarget(input: {
    teamName: string;
    memberName: string;
    expectedFingerprint: string;
    snapshot: MemberSettingsTargetSnapshot;
    rollbackToken: unknown;
  }): Promise<boolean> {
    return this.dependencies.withConfigLock(input.teamName, async () => {
      const current = await this.loadTarget(input.teamName, input.memberName);
      if (
        !current ||
        createMemberSettingsFingerprint(current.snapshot) !== input.expectedFingerprint
      ) {
        return false;
      }
      if (!isRollbackToken(input.rollbackToken)) return false;
      await this.restoreRawTarget(input.teamName, current, input.rollbackToken);
      return true;
    });
  }

  private async loadTarget(teamName: string, memberName: string): Promise<LoadedTarget | null> {
    const [meta, rawConfig] = await Promise.all([
      this.dependencies.membersMetaStore.getMeta(teamName),
      this.dependencies.readConfigJson(teamName),
    ]);
    const config = parseConfig(rawConfig);
    const configMemberIndex =
      config?.members?.findIndex((member) => matchesName(member.name, memberName)) ?? -1;
    const configMember =
      configMemberIndex >= 0 ? (config?.members?.[configMemberIndex] ?? null) : null;
    const metaMemberIndex =
      meta?.members.findIndex((member) => matchesName(member.name, memberName)) ?? -1;
    const metaMember = metaMemberIndex >= 0 ? (meta?.members[metaMemberIndex] ?? null) : null;
    if (isRemovedMember(metaMember) || isRemovedMember(configMember)) return null;
    let syntheticLeadMember: TeamMember | null = null;
    if (!metaMember && !configMember) {
      const hasPersistedLead = [...(config?.members ?? []), ...(meta?.members ?? [])].some(
        isPersistedLeadMember
      );
      if (
        !hasPersistedLead &&
        matchesName(memberName, 'team-lead') &&
        this.dependencies.readSyntheticLeadMember
      ) {
        syntheticLeadMember = await this.dependencies.readSyntheticLeadMember(teamName);
      }
      if (!syntheticLeadMember) return null;
    }
    const snapshot = await this.buildSnapshot(
      teamName,
      metaMember ?? syntheticLeadMember,
      configMember,
      config,
      meta
    );
    return {
      config,
      configMember,
      configMemberIndex,
      meta,
      metaMember,
      metaMemberIndex,
      snapshot,
    };
  }

  private async buildSnapshot(
    teamName: string,
    metaMember: TeamMember | null,
    configMember: JsonMember | null,
    config: JsonTeamConfig | null,
    meta: TeamMembersMetaFile | null
  ): Promise<MemberSettingsTargetSnapshot> {
    const leadProviderId = await this.dependencies.readLeadProviderId(teamName);
    const effectiveByName = new Map<
      string,
      { name: string; providerId?: MemberSettingsProviderId }
    >();
    const removedNames = new Set<string>();
    for (const member of [...(config?.members ?? []), ...(meta?.members ?? [])]) {
      if (isRemovedMember(member) && typeof member.name === 'string') {
        removedNames.add(member.name.trim().toLowerCase());
      }
    }
    for (const member of config?.members ?? []) {
      if (typeof member.name !== 'string' || !member.name.trim()) continue;
      const key = member.name.trim().toLowerCase();
      if (removedNames.has(key)) continue;
      effectiveByName.set(key, {
        name: member.name.trim(),
        providerId: providerId(member.providerId ?? member.provider) ?? undefined,
      });
    }
    for (const member of meta?.members ?? []) {
      const key = member.name.trim().toLowerCase();
      if (removedNames.has(key)) continue;
      effectiveByName.set(key, {
        name: member.name,
        providerId:
          effectiveByName.get(key)?.providerId ?? providerId(member.providerId) ?? undefined,
      });
    }
    const effectiveMembers = Array.from(effectiveByName.values());
    const plan = fromProvisioningMembers(leadProviderId ?? undefined, effectiveMembers);
    const targetProviderId = providerId(
      configMember?.providerId ?? configMember?.provider ?? metaMember?.providerId
    );
    const runtimeLane =
      leadProviderId !== 'opencode' && targetProviderId === 'opencode'
        ? 'opencode_secondary'
        : 'primary';

    return {
      name:
        typeof configMember?.name === 'string'
          ? configMember.name.trim()
          : (metaMember?.name ?? ''),
      agentType: optionalText(configMember?.agentType ?? metaMember?.agentType),
      agentId: optionalText(configMember?.agentId ?? metaMember?.agentId),
      joinedAt:
        typeof (configMember?.joinedAt ?? metaMember?.joinedAt) === 'number' ||
        typeof (configMember?.joinedAt ?? metaMember?.joinedAt) === 'string'
          ? ((configMember?.joinedAt ?? metaMember?.joinedAt) as number | string)
          : null,
      settings: readSettings(metaMember, configMember),
      teamIsAlive: await this.dependencies.isTeamAlive(teamName),
      leadProviderId,
      teamIsMixed: plan.ok && isMixedOpenCodeSideLanePlan(plan.plan),
      runtimeLane,
    };
  }

  private async persistSettings(
    current: LoadedTarget,
    teamName: string,
    settings: EditableMemberSettings
  ): Promise<void> {
    const previousMetaMember = current.metaMember ? { ...current.metaMember } : null;
    const metaMembers = [...(current.meta?.members ?? [])];
    const nextMetaMember = applySettings(
      current.metaMember ?? { name: current.snapshot.name },
      settings,
      false
    ) as unknown as TeamMember;
    if (current.metaMemberIndex >= 0) metaMembers[current.metaMemberIndex] = nextMetaMember;
    else metaMembers.push(nextMetaMember);

    await this.dependencies.membersMetaStore.writeMembers(teamName, metaMembers, {
      providerBackendId: current.meta?.providerBackendId,
    });

    if (!current.config) {
      this.dependencies.invalidateCaches(teamName);
      return;
    }
    const nextConfig = { ...current.config, members: [...(current.config.members ?? [])] };
    const nextConfigMember = applySettings(
      current.configMember ?? { name: current.snapshot.name },
      settings,
      true
    );
    if (current.configMemberIndex >= 0) {
      nextConfig.members[current.configMemberIndex] = nextConfigMember;
    } else {
      nextConfig.members.push(nextConfigMember);
    }
    try {
      await this.dependencies.writeConfigJsonAtomic(
        teamName,
        `${JSON.stringify(nextConfig, null, 2)}\n`
      );
    } catch (error) {
      try {
        await this.rollbackMetadataTarget(teamName, current.snapshot.name, previousMetaMember);
        this.dependencies.invalidateCaches(teamName);
      } catch (rollbackError) {
        try {
          this.dependencies.invalidateCaches(teamName);
        } catch {
          // The recovery result below already prevents automatic retry.
        }
        throw new MemberSettingsPersistenceFailedError(
          `Config update and target metadata rollback failed for ${teamName}/${current.snapshot.name}`,
          true,
          new AggregateError([error, rollbackError])
        );
      }
      throw new MemberSettingsPersistenceFailedError(
        `Config update failed for ${teamName}/${current.snapshot.name}`,
        false,
        error
      );
    }
    this.dependencies.invalidateCaches(teamName);
  }

  private async restoreLoadedTarget(teamName: string, previous: LoadedTarget): Promise<void> {
    const latest = await this.loadTarget(teamName, previous.snapshot.name);
    if (!latest) {
      throw new Error(`Cannot restore missing target ${teamName}/${previous.snapshot.name}`);
    }
    await this.restoreRawTarget(teamName, latest, rollbackToken(previous));
  }

  private async restoreRawTarget(
    teamName: string,
    current: LoadedTarget,
    previous: LegacyTargetRollbackToken
  ): Promise<void> {
    const currentMetadataMember = current.metaMember ? structuredClone(current.metaMember) : null;
    const metadataMembers = [...(current.meta?.members ?? [])];
    if (previous.metadataMember) {
      if (current.metaMemberIndex >= 0)
        metadataMembers[current.metaMemberIndex] = previous.metadataMember;
      else metadataMembers.push(previous.metadataMember);
    } else if (current.metaMemberIndex >= 0) {
      metadataMembers.splice(current.metaMemberIndex, 1);
    }
    await this.dependencies.membersMetaStore.writeMembers(teamName, metadataMembers, {
      providerBackendId: current.meta?.providerBackendId,
    });

    if (!current.config) {
      if (previous.configMember) {
        await this.rollbackMetadataTarget(teamName, previous.memberName, currentMetadataMember);
        throw new Error(`Cannot restore missing config target ${teamName}/${previous.memberName}`);
      }
      this.dependencies.invalidateCaches(teamName);
      return;
    }
    const nextConfig = { ...current.config, members: [...(current.config.members ?? [])] };
    if (previous.configMember) {
      if (current.configMemberIndex >= 0)
        nextConfig.members[current.configMemberIndex] = previous.configMember;
      else nextConfig.members.push(previous.configMember);
    } else if (current.configMemberIndex >= 0) {
      nextConfig.members.splice(current.configMemberIndex, 1);
    }
    try {
      await this.dependencies.writeConfigJsonAtomic(
        teamName,
        `${JSON.stringify(nextConfig, null, 2)}\n`
      );
    } catch (error) {
      try {
        await this.rollbackMetadataTarget(teamName, previous.memberName, currentMetadataMember);
      } finally {
        this.dependencies.invalidateCaches(teamName);
      }
      throw error;
    }
    this.dependencies.invalidateCaches(teamName);
  }

  private async rollbackMetadataTarget(
    teamName: string,
    memberName: string,
    previous: TeamMember | null
  ): Promise<void> {
    const latest = await this.dependencies.membersMetaStore.getMeta(teamName);
    const members = [...(latest?.members ?? [])];
    const index = members.findIndex((member) => matchesName(member.name, memberName));
    if (previous) {
      if (index >= 0) members[index] = previous;
      else members.push(previous);
    } else if (index >= 0) {
      members.splice(index, 1);
    }
    await this.dependencies.membersMetaStore.writeMembers(teamName, members, {
      providerBackendId: latest?.providerBackendId,
    });
  }
}

export interface NodeLegacyMemberSettingsRepositoryOptions {
  isTeamAlive(teamName: string): boolean;
  invalidateWorkerCache(teamName: string): void;
}

export function createNodeLegacyMemberSettingsRepositoryDependencies(
  options: NodeLegacyMemberSettingsRepositoryOptions
): LegacyMemberSettingsRepositoryDependencies {
  const membersMetaStore = new TeamMembersMetaStore();
  const teamMetaStore = new TeamMetaStore();
  return {
    membersMetaStore,
    async readConfigJson(teamName) {
      const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
      try {
        return await fs.promises.readFile(configPath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    writeConfigJsonAtomic(teamName, contents) {
      return atomicWriteAsync(path.join(getTeamsBasePath(), teamName, 'config.json'), contents);
    },
    withConfigLock(teamName, operation) {
      return withFileLock(path.join(getTeamsBasePath(), teamName, 'config.json'), operation);
    },
    async readLeadProviderId(teamName) {
      const meta = await teamMetaStore.getMeta(teamName);
      return meta?.launchIdentity?.providerId ?? meta?.providerId ?? null;
    },
    async readSyntheticLeadMember(teamName) {
      const meta = await teamMetaStore.getMeta(teamName);
      if (!meta) {
        return { name: 'team-lead', agentType: 'team-lead', role: 'Team Lead' };
      }
      const identity = meta.launchIdentity;
      const effectiveProviderId = identity?.providerId ?? meta.providerId;
      return {
        name: 'team-lead',
        agentType: 'team-lead',
        role: 'Team Lead',
        providerId: effectiveProviderId,
        providerBackendId: migrateProviderBackendId(
          effectiveProviderId,
          identity?.providerBackendId ?? meta.providerBackendId
        ),
        model: identity?.resolvedLaunchModel ?? identity?.selectedModel ?? meta.model,
        effort:
          identity?.resolvedEffort ??
          identity?.selectedEffort ??
          (isTeamEffortLevel(meta.effort) ? meta.effort : undefined),
        fastMode: identity?.selectedFastMode ?? meta.fastMode,
      };
    },
    async teamExists(teamName) {
      try {
        return (await fs.promises.stat(path.join(getTeamsBasePath(), teamName))).isDirectory();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    },
    isTeamAlive: options.isTeamAlive,
    invalidateCaches(teamName) {
      TeamConfigReader.invalidateTeam(teamName);
      options.invalidateWorkerCache(teamName);
    },
  };
}
