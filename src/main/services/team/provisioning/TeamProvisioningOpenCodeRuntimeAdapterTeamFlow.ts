import {
  isPureOpenCodeMemberLanePlan,
  type TeamRuntimeLanePlan,
} from '@features/team-runtime-lanes';
import * as path from 'path';

import { buildMembersMetaWritePayload } from './TeamProvisioningConfigLaunchNormalization';
import { type BeginCreateArtifactTransaction } from './TeamProvisioningCreateArtifactTransaction';
import { type PreparedOpenCodeRuntimeAdapterLaunch } from './TeamProvisioningOpenCodeRuntimeAdapterPreparation';
import { buildDeterministicLaunchHydrationPrompt } from './TeamProvisioningPromptBuilders';
import {
  asRosterLaunchKnownNoStartError,
  RosterLaunchKnownNoStartError,
} from './TeamProvisioningRosterLaunchOutcome';
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

export interface OpenCodeRuntimeAdapterTeamFlowPorts {
  getTeamsBasePathsToProbe(): { location: TeamsBaseLocation; basePath: string }[];
  getTeamsBasePath(): string;
  getTasksBasePath(): string;
  pathExists(filePath: string): Promise<boolean>;
  ensureCwdExists(cwd: string): Promise<void>;
  mkdir(directoryPath: string): Promise<void>;
  beginCreateArtifactTransaction: BeginCreateArtifactTransaction;
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
  const teamDir = path.join(ports.getTeamsBasePath(), launchRequest.teamName);
  const tasksDir = path.join(ports.getTasksBasePath(), launchRequest.teamName);
  const artifactTransaction = await ports.beginCreateArtifactTransaction({
    attemptId: request.rosterTransactionId ?? `opencode-create-${ports.nowMs()}`,
    teamName: launchRequest.teamName,
    teamDir,
    tasksDir,
  });
  let enteredLaunchBoundary = false;
  try {
    await artifactTransaction.ensureDirectory(teamDir);
    await artifactTransaction.ensureDirectory(tasksDir);
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
      leadRuntimeSelectionProvenance: launchRequest.leadRuntimeSelectionProvenance,
      skipPermissions: launchRequest.skipPermissions,
      worktree: launchRequest.worktree,
      extraCliArgs: launchRequest.extraCliArgs,
      limitContext: launchRequest.limitContext,
      createdAt: ports.nowMs(),
    });
    await artifactTransaction.recordFileWrite('team-meta');
    if (!request.rosterTransactionId) {
      await ports.writeMembersMeta(
        launchRequest.teamName,
        buildMembersMetaWritePayload(effectiveMembers),
        { providerBackendId: launchRequest.providerBackendId }
      );
      await artifactTransaction.recordFileWrite('members-meta');
    }
    await ports.writeOpenCodeTeamConfig(launchRequest, effectiveMembers);
    await artifactTransaction.recordFileWrite('config');

    const prompt = launchRequest.prompt?.trim() ?? '';
    enteredLaunchBoundary = true;
    const response = isPureOpenCodeMemberLanePlan(lanePlan)
      ? await ports.runOpenCodeWorktreeRootAggregateLaunch({
          request: launchRequest,
          members: effectiveMembers,
          lanePlan,
          prompt,
          sourceWarning: undefined,
          onProgress,
        })
      : await ports.runOpenCodeTeamRuntimeAdapterLaunch({
          request: launchRequest,
          members: runtimeLaunchMembers,
          prompt,
          sourceWarning: undefined,
          onProgress,
        });
    if (response.launchStatus === 'not_started') {
      await artifactTransaction.rollbackIfOwned();
    }
    return response;
  } catch (error) {
    if (!enteredLaunchBoundary || error instanceof RosterLaunchKnownNoStartError) {
      await artifactTransaction.rollbackIfOwned().catch(() => undefined);
    }
    throw enteredLaunchBoundary
      ? error
      : asRosterLaunchKnownNoStartError(
          error,
          'OpenCode create materialization failed before invocation'
        );
  }
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
      members: effectiveMembers,
      lanePlan,
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
