import { getMemberColorByName } from '@shared/constants/memberColors';
import { type TeamCreateRequest, type TeamMember } from '@shared/types';
import { isTeamEffortLevel } from '@shared/utils/effortLevels';
import { isLeadAgentType, isLeadMember } from '@shared/utils/leadDetection';
import { migrateProviderBackendId } from '@shared/utils/providerBackend';
import { buildTeamMemberColorMap } from '@shared/utils/teamMemberColors';
import { normalizeTeamMemberMcpPolicy } from '@shared/utils/teamMemberMcpPolicy';
import { createCliAutoSuffixNameGuard } from '@shared/utils/teamMemberName';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import { getEffectiveInboxMessageId } from '../inboxMessageIdentity';

import {
  getMixedLaunchFallbackRecoveryError,
  type TeamLaunchCompatibilityReport,
} from './TeamProvisioningLaunchCompatibility';

type ConfigMemberRecord = Record<string, unknown>;

export interface CliAutoSuffixedConfigMemberCleanupPlan {
  config: Record<string, unknown>;
  nextMembers: ConfigMemberRecord[];
  removedNames: string[];
}

export interface CliAutoSuffixedMetaMemberCleanupPlan {
  nextMembers: TeamMember[];
  removedNames: string[];
  activeNamesForInboxCleanup: Set<string>;
}

export interface TeamConfigLaunchNormalizationPlan {
  config: Record<string, unknown>;
  members: ConfigMemberRecord[];
  leadMembers: ConfigMemberRecord[];
}

export interface InboxDuplicateMergePlan {
  baseName: string;
  canonicalFile: string;
  duplicateFiles: string[];
}

export interface LaunchExpectedMembersResolution {
  members: TeamCreateRequest['members'];
  source: 'members-meta' | 'inboxes' | 'config-fallback';
  warning?: string;
}

export const PRELAUNCH_CONFIG_BACKUP_SUFFIX = '.prelaunch.bak';

export function getPrelaunchConfigBackupPath(configPath: string): string {
  return `${configPath}${PRELAUNCH_CONFIG_BACKUP_SUFFIX}`;
}

export function planCliAutoSuffixedConfigMemberCleanup(
  configRaw: string
): CliAutoSuffixedConfigMemberCleanupPlan | null {
  const parsed = JSON.parse(configRaw) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const config = parsed as Record<string, unknown>;
  const membersRaw = Array.isArray(config.members) ? (config.members as ConfigMemberRecord[]) : [];
  if (membersRaw.length === 0) {
    return null;
  }

  const teammateNames = membersRaw
    .map((member) => (typeof member.name === 'string' ? member.name.trim() : ''))
    .filter(
      (name) =>
        name.length > 0 && name.toLowerCase() !== 'team-lead' && name.toLowerCase() !== 'user'
    );

  const keepName = createCliAutoSuffixNameGuard(teammateNames);
  const removedNames: string[] = [];
  const nextMembers: ConfigMemberRecord[] = [];
  for (const member of membersRaw) {
    const name = typeof member.name === 'string' ? member.name.trim() : '';
    if (!name) continue;
    if (isLeadMember(member) || name === 'user') {
      nextMembers.push(member);
      continue;
    }
    if (!keepName(name)) {
      removedNames.push(name);
      continue;
    }
    nextMembers.push(member);
  }

  if (removedNames.length === 0) {
    return null;
  }

  return {
    config,
    nextMembers,
    removedNames,
  };
}

export function planCliAutoSuffixedMetaMemberCleanup(
  metaMembers: readonly TeamMember[]
): CliAutoSuffixedMetaMemberCleanupPlan {
  const activeNames = metaMembers
    .filter((member) => !member.removedAt)
    .map((member) => member.name.trim())
    .filter(
      (name) =>
        name.length > 0 && name.toLowerCase() !== 'team-lead' && name.toLowerCase() !== 'user'
    );

  const keepName = createCliAutoSuffixNameGuard(activeNames);
  const removedNames: string[] = [];
  const nextMembers = metaMembers.filter((member) => {
    const name = member.name?.trim() ?? '';
    if (!name) return false;
    const lower = name.toLowerCase();
    if (lower === 'user' || isLeadMember(member)) return true;
    if (!member.removedAt && !keepName(name)) {
      removedNames.push(name);
      return false;
    }
    return true;
  });

  return {
    nextMembers,
    removedNames,
    activeNamesForInboxCleanup: collectActiveTeammateNamesFromMetaMembers(nextMembers),
  };
}

export function collectActiveTeammateNamesFromMetaMembers(
  metaMembers: readonly TeamMember[]
): Set<string> {
  return new Set(
    metaMembers
      .filter((member) => !member.removedAt)
      .map((member) => member.name.trim())
      .filter(
        (name) =>
          name.length > 0 && name.toLowerCase() !== 'team-lead' && name.toLowerCase() !== 'user'
      )
  );
}

export function planTeamConfigLaunchNormalization(
  configRaw: string
): TeamConfigLaunchNormalizationPlan | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configRaw) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const config = parsed as Record<string, unknown>;
  const members = Array.isArray(config.members) ? (config.members as ConfigMemberRecord[]) : [];
  if (members.length === 0) {
    return null;
  }

  const leadMembers = members.filter((member) => isLaunchLeadMember(member, config));
  if (leadMembers.length === members.length) {
    return null;
  }

  return {
    config,
    members,
    leadMembers,
  };
}

export function assertConfigRawLeadOnlyForLaunch(configRaw: string | null | undefined): void {
  if (!configRaw) {
    throw new Error('config.json unreadable');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(configRaw) as unknown;
  } catch {
    throw new Error('config.json could not be parsed');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('config.json has invalid shape');
  }

  const config = parsed as Record<string, unknown>;
  const members = Array.isArray(config.members)
    ? (config.members as Record<string, unknown>[])
    : [];
  if (members.length === 0) return;

  for (const member of members) {
    const name = typeof member.name === 'string' ? member.name.trim() : '';
    if (!name) continue;
    const lower = name.toLowerCase();

    if (isLeadMember(member) || lower === 'user') continue;

    const leadAgentId = config.leadAgentId;
    if (
      typeof leadAgentId === 'string' &&
      typeof member.agentId === 'string' &&
      member.agentId === leadAgentId
    ) {
      continue;
    }

    throw new Error(
      `Refusing to launch: config.json still contains teammates (e.g. "${name}"), which can trigger CLI auto-suffixes like "${name}-2".`
    );
  }
}

export function isLaunchLeadMember(
  member: ConfigMemberRecord,
  config: Record<string, unknown>
): boolean {
  const agentType = member.agentType;
  if (typeof agentType === 'string' && isLeadAgentType(agentType)) {
    return true;
  }

  const name = typeof member.name === 'string' ? member.name.trim().toLowerCase() : '';
  if (name === 'team-lead') {
    return true;
  }

  const leadAgentId = config.leadAgentId;
  return (
    typeof leadAgentId === 'string' &&
    typeof member.agentId === 'string' &&
    member.agentId === leadAgentId
  );
}

export function collectConfigLaunchBaseNamesFromMetaMembers(
  metaMembers: readonly TeamMember[]
): Set<string> {
  const baseNames = new Set<string>();
  for (const member of metaMembers) {
    const name = member.name.trim();
    const lower = name.toLowerCase();
    if (name.length > 0 && !member.removedAt && lower !== 'team-lead' && lower !== 'user') {
      baseNames.add(name);
    }
  }
  return baseNames;
}

export function collectConfigLaunchBaseNamesFromConfigMembers(
  members: readonly ConfigMemberRecord[]
): Set<string> {
  const allConfigNames = new Set<string>();
  for (const member of members) {
    const name = typeof member.name === 'string' ? member.name.trim() : '';
    const agentType = typeof member.agentType === 'string' ? member.agentType : '';
    if (
      name &&
      agentType &&
      !isLeadAgentType(agentType) &&
      name !== 'team-lead' &&
      name !== 'user'
    ) {
      allConfigNames.add(name);
    }
  }

  const allConfigNamesLower = new Set(Array.from(allConfigNames).map((name) => name.toLowerCase()));
  const baseNames = new Set<string>();
  for (const name of allConfigNames) {
    const match = /^(.+)-(\d+)$/.exec(name);
    if (!match?.[1] || !match[2]) {
      baseNames.add(name);
      continue;
    }
    const suffix = Number(match[2]);
    if (!Number.isFinite(suffix) || suffix < 2) {
      baseNames.add(name);
      continue;
    }
    if (!allConfigNamesLower.has(match[1].toLowerCase())) {
      baseNames.add(name);
    }
  }
  return baseNames;
}

export function createInboxJsonFileSet(entries: readonly string[]): Set<string> {
  return new Set(entries.filter((entry) => entry.endsWith('.json') && !entry.startsWith('.')));
}

export function planInboxDuplicateMerge(
  baseName: string,
  existing: ReadonlySet<string>
): InboxDuplicateMergePlan | null {
  const canonicalFile = `${baseName}.json`;
  if (!existing.has(canonicalFile)) {
    return null;
  }

  const duplicateFiles = Array.from(existing)
    .filter((file) => file.startsWith(`${baseName}-`) && file.endsWith('.json'))
    .filter((file) => /^\d+$/.test(file.slice(baseName.length + 1, -'.json'.length)));

  if (duplicateFiles.length === 0) {
    return null;
  }

  return {
    baseName,
    canonicalFile,
    duplicateFiles,
  };
}

export function parseInboxMessageListRaw(raw: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    parsed = [];
  }
  return Array.isArray(parsed) ? (parsed as unknown[]) : [];
}

export function mergeInboxMessageLists(
  canonicalList: readonly unknown[],
  duplicateLists: readonly (readonly unknown[])[]
): unknown[] {
  const merged = [...canonicalList];
  for (const duplicateList of duplicateLists) {
    merged.push(...duplicateList);
  }

  const dedupById = new Map<string, unknown>();
  const noId: unknown[] = [];
  for (const item of merged) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const messageId = getEffectiveInboxMessageId(item);
    if (messageId) {
      dedupById.set(messageId, item);
    } else {
      noId.push(item);
    }
  }

  const mergedDeduped = [...Array.from(dedupById.values()), ...noId];
  mergedDeduped.sort((a, b) => {
    const at =
      a && typeof a === 'object' ? Date.parse((a as { timestamp?: string }).timestamp ?? '') : NaN;
    const bt =
      b && typeof b === 'object' ? Date.parse((b as { timestamp?: string }).timestamp ?? '') : NaN;
    const atNaN = Number.isNaN(at);
    const btNaN = Number.isNaN(bt);
    if (atNaN && btNaN) return 0;
    if (atNaN) return 1;
    if (btNaN) return -1;
    return bt - at;
  });

  return mergedDeduped;
}

export function selectMembersMetaTeammates(
  members: readonly TeamCreateRequest['members'][number][]
): TeamCreateRequest['members'] {
  return members.filter((member) => {
    const trimmed = member.name.trim();
    const lower = trimmed.toLowerCase();
    return trimmed.length > 0 && lower !== 'team-lead' && lower !== 'user';
  });
}

export function buildMembersMetaWritePayload(members: TeamCreateRequest['members']): TeamMember[] {
  return applyDistinctProvisioningMemberColors(
    members.map((member) => {
      const joinedAt = (member as { joinedAt?: unknown }).joinedAt;
      return {
        name: member.name.trim(),
        role: member.role?.trim() || undefined,
        workflow: member.workflow?.trim() || undefined,
        isolation: member.isolation === 'worktree' ? ('worktree' as const) : undefined,
        cwd: member.cwd?.trim() || undefined,
        providerId: normalizeOptionalTeamProviderId(member.providerId),
        providerBackendId: migrateProviderBackendId(member.providerId, member.providerBackendId),
        model: member.model?.trim() || undefined,
        effort: isTeamEffortLevel(member.effort) ? member.effort : undefined,
        fastMode:
          member.fastMode === 'inherit' || member.fastMode === 'on' || member.fastMode === 'off'
            ? member.fastMode
            : undefined,
        mcpPolicy: normalizeTeamMemberMcpPolicy(member.mcpPolicy),
        agentType: 'general-purpose' as const,
        color: getMemberColorByName(member.name.trim()),
        joinedAt: typeof joinedAt === 'number' ? joinedAt : Date.now(),
      };
    })
  );
}

export function resolveLaunchExpectedMembersFromCompatibilityReport(
  report: TeamLaunchCompatibilityReport
): LaunchExpectedMembersResolution {
  if (report.level === 'unsafe') {
    throw new Error(report.blockers[0] ?? getMixedLaunchFallbackRecoveryError());
  }
  return {
    members: report.members,
    source:
      report.rosterSource === 'members-meta'
        ? 'members-meta'
        : report.rosterSource === 'inboxes'
          ? 'inboxes'
          : 'config-fallback',
    ...(report.warnings.length > 0 ? { warning: report.warnings.join(' ') } : {}),
  };
}

function applyDistinctProvisioningMemberColors<
  T extends { name: string; color?: string; removedAt?: number },
>(members: readonly T[]): T[] {
  const colorMap = buildTeamMemberColorMap(members, { preferProvidedColors: false });
  return members.map((member) => ({
    ...member,
    color: colorMap.get(member.name) ?? member.color ?? getMemberColorByName(member.name),
  }));
}
