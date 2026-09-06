import {
  isPureOpenCodeMemberLanePlan,
  type TeamRuntimeLanePlan,
} from '@features/team-runtime-lanes';
import { isLeadMember } from '@shared/utils/leadDetection';
import * as path from 'path';

import { buildMembersMetaWritePayload } from './TeamProvisioningConfigLaunchNormalization';
import { type PreparedOpenCodeRuntimeAdapterLaunch } from './TeamProvisioningOpenCodeRuntimeAdapterPreparation';
import { buildDeterministicLaunchHydrationPrompt } from './TeamProvisioningPromptBuilders';
import { type TeamsBaseLocation } from './TeamProvisioningRuntimeLaunchSelection';

import type { TeamMetaFile } from '../TeamMetaStore';
import type {
  TeamCreateRequest,
  TeamCreateResponse,
  TeamLaunchRequest,
  TeamLaunchResponse,
  TeamProviderId,
  TeamProvisioningProgress,
  TeamTask,
} from '@shared/types';

type PureOpenCodeMemberLanePlan = Extract<
  TeamRuntimeLanePlan,
  { mode: 'pure_opencode_member_lanes' }
>;

/**
 * Puts the lead on the primary lane of an aggregate launch.
 *
 * The lane planner works on the TEAMMATE roster: `isLeadMember` is filtered out
 * of it during normalization, so no plan it produces ever names a lead. The
 * lead is synthesized back in exactly one place - `buildOpenCodeRuntimeAdapterLaunchMembers`,
 * whose result is `runtimeLaunchMembers` - and that result used to reach only
 * the non-aggregate path.
 *
 * So on this path no launch command was ever sent for the lead. `config.json`
 * recorded it regardless, which is why every later message to the lead was
 * answered with "No stored OpenCode session record": the app was addressing a
 * member nobody had launched. When every teammate qualified for a side lane the
 * effect was total - `primaryMembers` came out empty and
 * `launchOpenCodeAggregatePrimaryLane` returned at its first line without
 * sending anything at all.
 *
 * The plan is adjusted here rather than in the planner because the planner's
 * contract - "these are the teammates, and this is where they run" - holds for
 * all five of its modes, and only this one path needs the lead materialized
 * into a roster. The lead is taken from `runtimeLaunchMembers` so both paths
 * keep a single source of truth for what a lead is.
 */
function withLeadOnPrimaryLane(
  lanePlan: PureOpenCodeMemberLanePlan,
  runtimeLaunchMembers: TeamCreateRequest['members']
): PureOpenCodeMemberLanePlan {
  if (lanePlan.primaryMembers.some((member) => isLeadMember(member))) {
    return lanePlan;
  }
  const lead = runtimeLaunchMembers.find((member) => isLeadMember(member));
  if (!lead) {
    return lanePlan;
  }
  return {
    ...lanePlan,
    primaryMembers: [lead, ...lanePlan.primaryMembers],
    allMembers: [lead, ...lanePlan.allMembers],
  } as PureOpenCodeMemberLanePlan;
}

/** The same lead, in the roster the flow hands along beside the plan. */
function withLeadInRoster(
  members: TeamCreateRequest['members'],
  runtimeLaunchMembers: TeamCreateRequest['members']
): TeamCreateRequest['members'] {
  if (members.some((member) => isLeadMember(member))) {
    return members;
  }
  const lead = runtimeLaunchMembers.find((member) => isLeadMember(member));
  return lead ? [lead, ...members] : members;
}

export interface OpenCodeRuntimeAdapterTeamFlowPorts {
  getTeamsBasePathsToProbe(): { location: TeamsBaseLocation; basePath: string }[];
  getTeamsBasePath(): string;
  getTasksBasePath(): string;
  pathExists(filePath: string): Promise<boolean>;
  ensureCwdExists(cwd: string): Promise<void>;
  mkdir(directoryPath: string): Promise<void>;
  nowMs(): number;
  writeTeamMeta(teamName: string, data: Omit<TeamMetaFile, 'version'>): Promise<void>;
  writeMembersMeta(
    teamName: string,
    members: ReturnType<typeof buildMembersMetaWritePayload>,
    options?: { providerBackendId?: string }
  ): Promise<void>;
  writeOpenCodeTeamConfig(
    request: TeamCreateRequest,
    members: TeamCreateRequest['members']
  ): Promise<void>;
  prepareOpenCodeRuntimeAdapterLaunch<
    TRequest extends TeamCreateRequest | TeamLaunchRequest,
  >(params: {
    request: TRequest;
    members: TeamCreateRequest['members'];
  }): Promise<PreparedOpenCodeRuntimeAdapterLaunch<TRequest>>;
  readTeamConfigRaw(teamName: string): Promise<string | null>;
  resolveLaunchExpectedMembers(
    teamName: string,
    configRaw: string,
    leadProviderId?: TeamProviderId
  ): Promise<{
    members: TeamCreateRequest['members'];
    source: 'members-meta' | 'inboxes' | 'config-fallback';
    warning?: string;
  }>;
  updateConfigProjectPath(teamName: string, cwd: string): Promise<void>;
  readExistingTasks(teamName: string): Promise<TeamTask[]>;
  warn(message: string): void;
  buildDeterministicLaunchHydrationPrompt: typeof buildDeterministicLaunchHydrationPrompt;
  runOpenCodeWorktreeRootAggregateLaunch(input: {
    request: TeamCreateRequest | TeamLaunchRequest;
    members: TeamCreateRequest['members'];
    lanePlan: Extract<TeamRuntimeLanePlan, { mode: 'pure_opencode_member_lanes' }>;
    prompt: string;
    sourceWarning?: string;
    onProgress: (progress: TeamProvisioningProgress) => void;
  }): Promise<TeamLaunchResponse>;
  runOpenCodeTeamRuntimeAdapterLaunch(input: {
    request: TeamCreateRequest | TeamLaunchRequest;
    members: TeamCreateRequest['members'];
    prompt: string;
    sourceWarning?: string;
    onProgress: (progress: TeamProvisioningProgress) => void;
  }): Promise<TeamLaunchResponse>;
}

export async function createOpenCodeTeamThroughRuntimeAdapterFlow(
  request: TeamCreateRequest,
  onProgress: (progress: TeamProvisioningProgress) => void,
  ports: OpenCodeRuntimeAdapterTeamFlowPorts
): Promise<TeamCreateResponse> {
  for (const probe of ports.getTeamsBasePathsToProbe()) {
    const configPath = path.join(probe.basePath, request.teamName, 'config.json');
    if (await ports.pathExists(configPath)) {
      const suffix = probe.location === 'configured' ? '' : ` (found under ${probe.basePath})`;
      throw new Error(`Team already exists${suffix}`);
    }
  }

  await ports.ensureCwdExists(request.cwd);
  const { launchRequest, effectiveMembers, lanePlan, runtimeLaunchMembers } =
    await ports.prepareOpenCodeRuntimeAdapterLaunch({
      request,
      members: request.members,
    });
  await ports.mkdir(path.join(ports.getTeamsBasePath(), launchRequest.teamName));
  await ports.mkdir(path.join(ports.getTasksBasePath(), launchRequest.teamName));
  await ports.writeTeamMeta(launchRequest.teamName, {
    displayName: launchRequest.displayName,
    description: launchRequest.description,
    color: launchRequest.color,
    cwd: launchRequest.cwd,
    prompt: launchRequest.prompt,
    providerId: launchRequest.providerId,
    providerBackendId: launchRequest.providerBackendId,
    model: launchRequest.model,
    effort: launchRequest.effort,
    syncModelsWithLead: launchRequest.syncModelsWithLead,
    skipPermissions: launchRequest.skipPermissions,
    worktree: launchRequest.worktree,
    extraCliArgs: launchRequest.extraCliArgs,
    limitContext: launchRequest.limitContext,
    createdAt: ports.nowMs(),
  });
  await ports.writeMembersMeta(
    launchRequest.teamName,
    buildMembersMetaWritePayload(effectiveMembers),
    { providerBackendId: launchRequest.providerBackendId }
  );
  await ports.writeOpenCodeTeamConfig(launchRequest, effectiveMembers);

  const prompt = launchRequest.prompt?.trim() ?? '';
  if (isPureOpenCodeMemberLanePlan(lanePlan)) {
    return ports.runOpenCodeWorktreeRootAggregateLaunch({
      request: launchRequest,
      members: withLeadInRoster(effectiveMembers, runtimeLaunchMembers),
      lanePlan: withLeadOnPrimaryLane(lanePlan, runtimeLaunchMembers),
      prompt,
      sourceWarning: undefined,
      onProgress,
    });
  }

  return ports.runOpenCodeTeamRuntimeAdapterLaunch({
    request: launchRequest,
    members: runtimeLaunchMembers,
    prompt,
    sourceWarning: undefined,
    onProgress,
  });
}

export async function launchOpenCodeTeamThroughRuntimeAdapterFlow(
  request: TeamLaunchRequest,
  onProgress: (progress: TeamProvisioningProgress) => void,
  ports: OpenCodeRuntimeAdapterTeamFlowPorts
): Promise<TeamLaunchResponse> {
  const configRaw = await ports.readTeamConfigRaw(request.teamName);
  if (!configRaw) {
    throw new Error(`Team "${request.teamName}" not found — config.json does not exist`);
  }
  await ports.ensureCwdExists(request.cwd);
  const { members, warning } = await ports.resolveLaunchExpectedMembers(
    request.teamName,
    configRaw,
    request.providerId
  );
  const { launchRequest, effectiveMembers, lanePlan, runtimeLaunchMembers } =
    await ports.prepareOpenCodeRuntimeAdapterLaunch({
      request,
      members,
    });
  await ports.updateConfigProjectPath(launchRequest.teamName, launchRequest.cwd);

  let existingTasks: TeamTask[] = [];
  try {
    existingTasks = await ports.readExistingTasks(request.teamName);
  } catch (error) {
    ports.warn(
      `[${request.teamName}] Failed to read tasks for OpenCode launch prompt: ${String(error)}`
    );
  }
  const prompt = ports.buildDeterministicLaunchHydrationPrompt(
    launchRequest,
    effectiveMembers,
    existingTasks,
    false
  );
  if (isPureOpenCodeMemberLanePlan(lanePlan)) {
    return ports.runOpenCodeWorktreeRootAggregateLaunch({
      request: launchRequest,
      members: withLeadInRoster(effectiveMembers, runtimeLaunchMembers),
      lanePlan: withLeadOnPrimaryLane(lanePlan, runtimeLaunchMembers),
      prompt,
      sourceWarning: warning,
      onProgress,
    });
  }

  return ports.runOpenCodeTeamRuntimeAdapterLaunch({
    request: launchRequest,
    members: runtimeLaunchMembers,
    prompt,
    sourceWarning: warning,
    onProgress,
  });
}
