import { fromProvisioningMembers, isOpenCodeSideLanePlan } from '@features/team-runtime-lanes';
import { isTeamEffortLevel } from '@shared/utils/effortLevels';
import { isLeadMember } from '@shared/utils/leadDetection';
import { normalizeTeamMemberMcpPolicy } from '@shared/utils/teamMemberMcpPolicy';
import { createCliAutoSuffixNameGuard } from '@shared/utils/teamMemberName';
import {
  inferTeamProviderIdFromModel,
  normalizeOptionalTeamProviderId,
} from '@shared/utils/teamProvider';

import {
  getMixedLaunchFallbackRecoveryError,
  type TeamLaunchCompatibilityReport,
} from './TeamProvisioningLaunchCompatibility';

import type { TeamCreateRequest, TeamMember, TeamProviderId } from '@shared/types';

export interface TeamProvisioningEffectiveLaunchState {
  providerId?: TeamProviderId;
  model?: string;
  effort?: TeamCreateRequest['effort'];
  members?: TeamCreateRequest['members'];
}

export interface TeamProvisioningConfigMaterializationClock {
  now?: () => number;
}

interface PostLaunchConfigMaterializationParams extends TeamProvisioningConfigMaterializationClock {
  teamName: string;
  config: Record<string, unknown>;
  projectPath: string;
  newSessionId: string | null;
  sessionHistory: string[];
  language: string;
  color?: string;
  launchState?: TeamProvisioningEffectiveLaunchState;
  maxSessionHistory?: number;
  maxProjectPathHistory?: number;
}

export interface UpdateTeamConfigPostLaunchInput {
  teamName: string;
  projectPath: string;
  detectedSessionId: string | null;
  color?: string;
  launchState?: TeamProvisioningEffectiveLaunchState;
}

export interface UpdateTeamConfigPostLaunchPorts {
  readConfig(): Promise<string | null>;
  writeConfig(raw: string): Promise<void>;
  invalidateTeam(teamName: string): void;
  scanForNewestSession(projectPath: string, knownSessions: string[]): Promise<string | null>;
  getLanguage(): string;
  info(message: string): void;
  warn(message: string): void;
}

interface ConfigMemberInput {
  name?: string;
  role?: string;
  workflow?: string;
  isolation?: string;
  agentType?: string;
  providerId?: string;
  provider?: string;
  model?: string;
  effort?: string;
  mcpPolicy?: unknown;
  cwd?: string;
  removedAt?: unknown;
}

const DEFAULT_MAX_SESSION_HISTORY = 5000;
const DEFAULT_MAX_PROJECT_PATH_HISTORY = 500;

export function applyEffectiveLaunchStateToConfig(
  teamName: string,
  config: Record<string, unknown>,
  launchState?: TeamProvisioningEffectiveLaunchState,
  clock: TeamProvisioningConfigMaterializationClock = {}
): void {
  if (!launchState || !Array.isArray(config.members)) {
    return;
  }

  const effectiveLeadProviderId =
    normalizeOptionalTeamProviderId(launchState.providerId) ?? 'anthropic';
  const effectiveLeadModel = launchState.model?.trim() || undefined;
  const effectiveLeadEffort = isTeamEffortLevel(launchState.effort)
    ? launchState.effort
    : undefined;

  const membersByName = new Map(
    (launchState.members ?? []).map((member) => [member.name.toLowerCase(), member] as const)
  );

  const nextMembers = (config.members as Record<string, unknown>[]).map((member) => {
    if (!member || typeof member !== 'object') {
      return member;
    }

    const rawName = typeof member.name === 'string' ? member.name.trim() : '';
    const nextMember = { ...member };

    const assignRuntimeState = (state: {
      providerId?: TeamProviderId;
      model?: string;
      effort?: TeamCreateRequest['effort'];
    }): void => {
      const providerId = normalizeOptionalTeamProviderId(state.providerId);
      if (providerId) {
        nextMember.provider = providerId;
        nextMember.providerId = providerId;
      } else {
        delete nextMember.provider;
        delete nextMember.providerId;
      }

      const model = state.model?.trim() || undefined;
      if (model) {
        nextMember.model = model;
      } else {
        delete nextMember.model;
      }

      const effort = isTeamEffortLevel(state.effort) ? state.effort : undefined;
      if (effort) {
        nextMember.effort = effort;
      } else {
        delete nextMember.effort;
      }
    };

    if (isLeadMember(nextMember) || rawName.toLowerCase() === 'team-lead') {
      assignRuntimeState({
        providerId: effectiveLeadProviderId,
        model: effectiveLeadModel,
        effort: effectiveLeadEffort,
      });
      return nextMember;
    }

    const effectiveMember = membersByName.get(rawName.toLowerCase());
    if (!effectiveMember) {
      return nextMember;
    }

    assignRuntimeState({
      providerId: effectiveMember.providerId,
      model: effectiveMember.model,
      effort: effectiveMember.effort,
    });
    return nextMember;
  });

  const existingNames = new Set(
    nextMembers
      .map((member) => (typeof member.name === 'string' ? member.name.trim().toLowerCase() : ''))
      .filter(Boolean)
  );

  for (const member of launchState.members ?? []) {
    const name = member.name?.trim();
    if (!name || existingNames.has(name.toLowerCase())) {
      continue;
    }

    const providerId = normalizeOptionalTeamProviderId(member.providerId);
    if (providerId !== 'opencode') {
      continue;
    }

    nextMembers.push(buildOpenCodeConfigMemberFromLaunchMember(teamName, member, clock));
    existingNames.add(name.toLowerCase());
  }

  config.members = nextMembers;
}

export function buildOpenCodeConfigMemberFromLaunchMember(
  teamName: string,
  member: TeamCreateRequest['members'][number],
  clock: TeamProvisioningConfigMaterializationClock = {}
): Record<string, unknown> {
  const name = member.name.trim();
  const configMember: Record<string, unknown> = {
    name,
    agentId: `${name}@${teamName}`,
    agentType: 'general-purpose',
    role: member.role?.trim() || undefined,
    workflow: member.workflow?.trim() || undefined,
    isolation: member.isolation === 'worktree' ? 'worktree' : undefined,
    providerId: 'opencode',
    model: member.model?.trim() || undefined,
    effort: isTeamEffortLevel(member.effort) ? member.effort : undefined,
    mcpPolicy: normalizeTeamMemberMcpPolicy(member.mcpPolicy),
    cwd: member.cwd?.trim() || undefined,
    joinedAt: (clock.now ?? Date.now)(),
  };

  return Object.fromEntries(
    Object.entries(configMember).filter(([, value]) => value !== undefined)
  );
}

export function collectPostLaunchSessionHistory(config: Record<string, unknown>): string[] {
  const sessionHistory = Array.isArray(config.sessionHistory)
    ? [...(config.sessionHistory as string[])]
    : [];

  const oldLeadSessionId = config.leadSessionId;
  if (
    typeof oldLeadSessionId === 'string' &&
    oldLeadSessionId.trim().length > 0 &&
    !sessionHistory.includes(oldLeadSessionId)
  ) {
    sessionHistory.push(oldLeadSessionId);
  }

  return sessionHistory;
}

export function applyConfigPostLaunchMaterialization({
  teamName,
  config,
  projectPath,
  newSessionId,
  sessionHistory,
  language,
  color,
  launchState,
  maxSessionHistory = DEFAULT_MAX_SESSION_HISTORY,
  maxProjectPathHistory = DEFAULT_MAX_PROJECT_PATH_HISTORY,
  now,
}: PostLaunchConfigMaterializationParams): void {
  if (newSessionId) {
    config.leadSessionId = newSessionId;
    if (!sessionHistory.includes(newSessionId)) {
      sessionHistory.push(newSessionId);
    }
  }

  if (sessionHistory.length > maxSessionHistory) {
    config.sessionHistory = sessionHistory.slice(-maxSessionHistory);
  } else {
    config.sessionHistory = sessionHistory;
  }

  config.language = language;

  if (color && color.trim().length > 0) {
    config.color = color.trim();
  }

  if (projectPath.trim()) {
    config.projectPath = projectPath;
    const pathHistory = Array.isArray(config.projectPathHistory)
      ? (config.projectPathHistory as string[]).filter(
          (p) => typeof p === 'string' && p !== projectPath
        )
      : [];
    pathHistory.push(projectPath);
    config.projectPathHistory =
      pathHistory.length > maxProjectPathHistory
        ? pathHistory.slice(-maxProjectPathHistory)
        : pathHistory;
  }

  applyEffectiveLaunchStateToConfig(teamName, config, launchState, { now });
}

export async function updateTeamConfigPostLaunch(
  input: UpdateTeamConfigPostLaunchInput,
  ports: UpdateTeamConfigPostLaunchPorts
): Promise<void> {
  const { teamName, projectPath, detectedSessionId, color, launchState } = input;
  try {
    const raw = await ports.readConfig();
    if (!raw) {
      throw new Error('config.json unreadable');
    }
    const config = JSON.parse(raw) as Record<string, unknown>;
    const sessionHistory = collectPostLaunchSessionHistory(config);

    let newSessionId = detectedSessionId;
    if (!newSessionId && projectPath.trim()) {
      const scannedId = await ports.scanForNewestSession(projectPath, [...sessionHistory]);
      if (scannedId) {
        newSessionId = scannedId;
        ports.info(`[${teamName}] Detected new session via project dir scan: ${scannedId}`);
      }
    }

    if (newSessionId) {
      ports.info(`[${teamName}] Updated leadSessionId: ${newSessionId}`);
    }

    applyConfigPostLaunchMaterialization({
      teamName,
      config,
      projectPath,
      newSessionId,
      sessionHistory,
      language: ports.getLanguage(),
      color,
      launchState,
    });

    await ports.writeConfig(JSON.stringify(config, null, 2));
    ports.invalidateTeam(teamName);
  } catch (error) {
    ports.warn(
      `[${teamName}] Failed to update config post-launch: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

export function buildLaunchMembersFromMeta(
  metaMembers: TeamMember[]
): TeamCreateRequest['members'] {
  const byName = new Map<string, TeamCreateRequest['members'][number]>();
  for (const member of metaMembers) {
    const rawName = member.name?.trim() ?? '';
    const lower = rawName.toLowerCase();
    if (isLeadMember(member) || lower === 'user') {
      continue;
    }
    const name = rawName;
    if (!name) continue;
    if (member.removedAt) continue;
    const role = typeof member.role === 'string' ? member.role.trim() || undefined : undefined;
    const workflow =
      typeof member.workflow === 'string' ? member.workflow.trim() || undefined : undefined;
    const isolation = member.isolation === 'worktree' ? 'worktree' : undefined;
    const providerId = normalizeOptionalTeamProviderId(member.providerId);
    const model = typeof member.model === 'string' ? member.model.trim() || undefined : undefined;
    const effort = isTeamEffortLevel(member.effort) ? member.effort : undefined;
    const cwd = typeof member.cwd === 'string' ? member.cwd.trim() || undefined : undefined;
    const mcpPolicy = normalizeTeamMemberMcpPolicy(member.mcpPolicy);
    const prev = byName.get(name);
    if (!prev) {
      byName.set(name, {
        name,
        role,
        workflow,
        isolation,
        cwd,
        providerId,
        model,
        effort,
        mcpPolicy,
      });
    } else {
      byName.set(name, {
        ...prev,
        role: prev.role || role,
        workflow: prev.workflow || workflow,
        isolation: prev.isolation || isolation,
        cwd: prev.cwd || cwd,
        providerId: prev.providerId || providerId,
        model: prev.model || model,
        effort: prev.effort || effort,
        mcpPolicy: prev.mcpPolicy || mcpPolicy,
      });
    }
  }
  const allNames = Array.from(byName.keys());
  const keepName = createCliAutoSuffixNameGuard(allNames);
  for (const name of allNames) {
    if (!keepName(name)) {
      byName.delete(name);
    }
  }
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function extractTeammateSpecsFromConfig(configRaw: string): TeamCreateRequest['members'] {
  try {
    const parsed = JSON.parse(configRaw) as { members?: ConfigMemberInput[] };
    if (!Array.isArray(parsed.members)) {
      return [];
    }
    const byName = new Map<string, TeamCreateRequest['members'][number]>();
    for (const member of parsed.members) {
      const rawName = typeof member?.name === 'string' ? member.name.trim() : '';
      const lower = rawName.toLowerCase();
      if (!member || isLeadMember(member) || lower === 'user') continue;
      const name = rawName;
      if (!name) continue;
      if (member.removedAt != null) continue;
      byName.set(name, {
        name,
        role: typeof member.role === 'string' ? member.role.trim() || undefined : undefined,
        workflow:
          typeof member.workflow === 'string' ? member.workflow.trim() || undefined : undefined,
        isolation: member.isolation === 'worktree' ? ('worktree' as const) : undefined,
        cwd: typeof member.cwd === 'string' ? member.cwd.trim() || undefined : undefined,
        providerId: normalizeOptionalTeamProviderId(member.providerId ?? member.provider),
        model: typeof member.model === 'string' ? member.model.trim() || undefined : undefined,
        effort: isTeamEffortLevel(member.effort) ? member.effort : undefined,
        mcpPolicy: normalizeTeamMemberMcpPolicy(member.mcpPolicy),
      });
    }
    const allNames = Array.from(byName.keys());
    const keepName = createCliAutoSuffixNameGuard(allNames);
    for (const name of allNames) {
      if (!keepName(name)) {
        byName.delete(name);
      }
    }
    return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export function buildConfigLaunchCompatibilityReport(
  teamName: string,
  configMembers: TeamCreateRequest['members'],
  leadProviderId?: TeamProviderId,
  options: { ignoredInboxNames?: boolean } = {}
): TeamLaunchCompatibilityReport {
  if (hasIncompleteOpenCodeLaunchCompatibilityMember(configMembers)) {
    return {
      level: 'unsafe',
      rosterSource: 'config',
      members: [],
      warnings: [],
      blockers: [`[${teamName}] ${getMixedLaunchFallbackRecoveryError()} Fallback source: config.`],
    };
  }
  const lanePlanResult = fromProvisioningMembers(leadProviderId, configMembers);
  if (!lanePlanResult.ok) {
    throw new Error(lanePlanResult.message);
  }
  const lanePlan = lanePlanResult.plan;
  if (isOpenCodeSideLanePlan(lanePlan)) {
    const sideLanesHaveExplicitProviderModels = lanePlan.sideLanes.every(
      (lane) =>
        normalizeOptionalTeamProviderId(lane.member.providerId) === 'opencode' &&
        typeof lane.member.model === 'string' &&
        lane.member.model.trim().length > 0
    );
    if (!sideLanesHaveExplicitProviderModels) {
      return {
        level: 'unsafe',
        rosterSource: 'config',
        members: [],
        warnings: [],
        blockers: [
          `[${teamName}] ${getMixedLaunchFallbackRecoveryError()} Fallback source: config.`,
        ],
      };
    }
  }
  return {
    level: 'repairable',
    rosterSource: 'config',
    members: configMembers,
    warnings: [
      options.ignoredInboxNames
        ? 'members.meta.json is missing; launch used complete config.json member metadata instead of inbox fallback to preserve mixed provider/model layout.'
        : 'members.meta.json and inboxes are empty; launch fell back to config.json members. ' +
          'Run a fresh team bootstrap to persist stable member metadata.',
    ],
    blockers: [],
    repairAction: 'materialize-members-meta',
  };
}

export function isUnsafeMixedLaunchFallback(params: {
  leadProviderId?: TeamProviderId;
  members: TeamCreateRequest['members'];
}): boolean {
  const lanePlanResult = fromProvisioningMembers(params.leadProviderId, params.members);
  if (!lanePlanResult.ok) {
    throw new Error(lanePlanResult.message);
  }
  return isOpenCodeSideLanePlan(lanePlanResult.plan);
}

export function hasIncompleteOpenCodeLaunchCompatibilityMember(
  members: TeamCreateRequest['members']
): boolean {
  return members.some((member) => {
    const providerId = normalizeOptionalTeamProviderId(member.providerId);
    const model = typeof member.model === 'string' ? member.model.trim() : '';
    const inferredProviderId = inferTeamProviderIdFromModel(model);
    return (
      (providerId === 'opencode' && model.length === 0) ||
      (!providerId && inferredProviderId === 'opencode')
    );
  });
}

export function assertMixedLaunchFallbackSafe(params: {
  teamName: string;
  leadProviderId?: TeamProviderId;
  source: 'inboxes' | 'config-fallback';
  members: TeamCreateRequest['members'];
}): void {
  if (
    isUnsafeMixedLaunchFallback({
      leadProviderId: params.leadProviderId,
      members: params.members,
    })
  ) {
    throw new Error(
      `[${params.teamName}] ${getMixedLaunchFallbackRecoveryError()} Fallback source: ${params.source}.`
    );
  }
}
