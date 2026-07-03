import * as path from 'path';

import { mergeJsonSettingsArgs } from '../../runtime/cliSettingsArgs';
import { buildDesktopTeammateModeCliArgs } from '../runtimeTeammateMode';

import {
  emitProvisioningCheckpoint,
  initializeProvisioningTrace,
  type TeamProvisioningCheckpointRun,
} from './TeamProvisioningProgressBuffers';
import {
  getLaunchModelArg,
  type TeamRuntimeLaunchArgsPlan,
} from './TeamProvisioningRuntimeLaunchSelection';

import type { LaunchExpectedMembersResolution } from './TeamProvisioningConfigLaunchNormalization';
import type {
  ProviderModelLaunchIdentity,
  TeamCreateRequest,
  TeamLaunchRequest,
  TeamProviderId,
} from '@shared/types';

export type LaunchRosterSource = LaunchExpectedMembersResolution['source'];

export interface ExistingLaunchRunLike {
  child?: unknown;
  processKilled?: boolean;
  cancelRequested?: boolean;
}

export interface DeterministicLaunchStatePreparationRun extends TeamProvisioningCheckpointRun {
  runId: string;
  teamName: string;
  launchStateClearedForRun: boolean;
  mixedSecondaryLanes?: readonly unknown[];
}

export type ExistingLaunchRunReuseDecision =
  | { kind: 'continue' }
  | { kind: 'reuse'; runId: string }
  | { kind: 'blocked'; message: string };

export function parseLaunchConfigProjectPath(configRaw: string): string | null {
  try {
    const parsedConfig = JSON.parse(configRaw) as { projectPath?: unknown };
    return typeof parsedConfig.projectPath === 'string' &&
      parsedConfig.projectPath.trim().length > 0
      ? path.resolve(parsedConfig.projectPath.trim())
      : null;
  } catch {
    return null;
  }
}

export function resolveExistingLaunchRunReuse(input: {
  teamName: string;
  cwd: string;
  existingAliveRunId: string | null;
  existingRun: ExistingLaunchRunLike | null | undefined;
  existingRunCwd: string | null;
  configProjectPath: string | null;
}): ExistingLaunchRunReuseDecision {
  if (!input.existingAliveRunId) {
    return { kind: 'continue' };
  }

  const existingRun = input.existingRun;
  if (!existingRun?.child || existingRun.processKilled || existingRun.cancelRequested) {
    return { kind: 'continue' };
  }

  const requestedCwd = path.resolve(input.cwd);
  const existingRunCwd = input.existingRunCwd ?? input.configProjectPath;
  if (!existingRunCwd) {
    return {
      kind: 'blocked',
      message:
        `Team "${input.teamName}" is already running, but its cwd could not be determined. ` +
        'Stop it before launching again.',
    };
  }

  if (existingRunCwd !== requestedCwd) {
    return {
      kind: 'blocked',
      message:
        `Team "${input.teamName}" is already running in "${existingRunCwd}". ` +
        `Stop it before launching with cwd "${input.cwd}".`,
    };
  }

  return { kind: 'reuse', runId: input.existingAliveRunId };
}

export function getInitialLaunchValidationMessage(source: LaunchRosterSource): string {
  return source === 'members-meta'
    ? 'Validating team launch request (members from members.meta.json)'
    : source === 'inboxes'
      ? 'Validating team launch request (members from inboxes)'
      : 'Validating team launch request (fallback members from config.json)';
}

export function buildLaunchSyntheticRequest(input: {
  request: TeamLaunchRequest;
  members: TeamCreateRequest['members'];
  configRaw: string;
}): TeamCreateRequest {
  const syntheticRequest: TeamCreateRequest = {
    teamName: input.request.teamName,
    members: input.members,
    cwd: input.request.cwd,
    providerId: input.request.providerId,
    providerBackendId: input.request.providerBackendId,
    model: input.request.model,
    effort: input.request.effort,
    fastMode: input.request.fastMode,
    skipPermissions: input.request.skipPermissions,
  };

  try {
    const cfg = JSON.parse(input.configRaw) as Record<string, unknown>;
    if (typeof cfg.color === 'string' && cfg.color.trim().length > 0) {
      syntheticRequest.color = cfg.color.trim();
    }
    if (typeof cfg.name === 'string' && cfg.name.trim().length > 0) {
      syntheticRequest.displayName = cfg.name.trim();
    }
  } catch {
    // The caller already validated config availability. Display metadata is optional.
  }

  return syntheticRequest;
}

export async function prepareDeterministicLaunchRunState<
  TLane,
  TRun extends DeterministicLaunchStatePreparationRun & {
    mixedSecondaryLanes?: readonly TLane[];
  },
>(input: {
  teamName: string;
  run: TRun;
  prepareWorkspaceTrustForDeterministicRun(): Promise<void>;
  resetTeamScopedTransientStateForNewRun(teamName: string): void;
  registerRun(runId: string, run: TRun): void;
  setProvisioningRunByTeam(teamName: string, runId: string): void;
  clearPersistedLaunchState(teamName: string, options: { expectedRunId: string }): Promise<void>;
  publishMixedSecondaryLaneStatusChange(run: TRun, lane: TLane): Promise<void>;
}): Promise<void> {
  input.resetTeamScopedTransientStateForNewRun(input.teamName);
  input.registerRun(input.run.runId, input.run);
  input.setProvisioningRunByTeam(input.teamName, input.run.runId);
  initializeProvisioningTrace(input.run);
  input.run.onProgress(input.run.progress);
  await input.prepareWorkspaceTrustForDeterministicRun();
  emitProvisioningCheckpoint(input.run, 'Clearing persisted launch state');
  await input.clearPersistedLaunchState(input.teamName, { expectedRunId: input.run.runId });
  input.run.launchStateClearedForRun = true;
  emitProvisioningCheckpoint(input.run, 'Publishing mixed secondary lane status');
  for (const lane of input.run.mixedSecondaryLanes ?? []) {
    await input.publishMixedSecondaryLaneStatusChange(input.run, lane);
  }
}

export function buildDeterministicLaunchProcessArgs(input: {
  mcpConfigPath: string;
  bootstrapSpecPath: string;
  bootstrapUserPromptPath: string | null;
  skipPermissions?: boolean;
  worktree?: string;
  providerId: TeamProviderId;
  model?: string;
  launchIdentity: ProviderModelLaunchIdentity | null;
  runtimeArgsPlan: TeamRuntimeLaunchArgsPlan;
  teammateModeDecision: { injectedTeammateMode: 'tmux' | null };
  disallowedTools: string;
}): string[] {
  const launchArgs = [
    '--print',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--setting-sources',
    'user,project,local',
    '--mcp-config',
    input.mcpConfigPath,
    '--team-bootstrap-spec',
    input.bootstrapSpecPath,
    ...(input.bootstrapUserPromptPath
      ? ['--team-bootstrap-user-prompt-file', input.bootstrapUserPromptPath]
      : []),
    '--disallowedTools',
    input.disallowedTools,
    ...(input.skipPermissions !== false
      ? ['--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions']
      : ['--permission-prompt-tool', 'stdio', '--permission-mode', 'default']),
  ];
  const launchModelArg = getLaunchModelArg(input.providerId, input.model, input.launchIdentity);
  if (launchModelArg) {
    launchArgs.push('--model', launchModelArg);
  }
  if (input.launchIdentity?.resolvedEffort) {
    launchArgs.push('--effort', input.launchIdentity.resolvedEffort);
  }
  launchArgs.push(...input.runtimeArgsPlan.providerArgs);
  launchArgs.push(...input.runtimeArgsPlan.fastModeArgs);
  launchArgs.push(...input.runtimeArgsPlan.runtimeTurnSettledHookArgs);
  if (input.worktree) {
    launchArgs.push('--worktree', input.worktree);
  }
  launchArgs.push(...buildDesktopTeammateModeCliArgs(input.teammateModeDecision));
  launchArgs.push(...input.runtimeArgsPlan.extraArgs);
  launchArgs.push(...input.runtimeArgsPlan.settingsArgs);
  launchArgs.push(...input.runtimeArgsPlan.inheritedProviderArgs);
  return mergeJsonSettingsArgs(launchArgs);
}
