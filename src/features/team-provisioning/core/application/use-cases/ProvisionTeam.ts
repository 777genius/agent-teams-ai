import {
  parseOptionalLaunchProviderBackendId,
  parseOptionalTeamEffort,
  parseOptionalTeamFastMode,
} from '@features/team-configuration';
import { migrateProviderBackendId } from '@shared/utils/providerBackend';

import type { TeamLaunchMode, ValidatedTeamLaunchInput } from '../models/TeamProvisioningModels';
import type {
  TeamProvisioningEffectsPort,
  TeamProvisioningRepositoryPort,
  TeamProvisioningStartPort,
  TeamProvisioningWorkspacePort,
} from '../ports/TeamProvisioningPorts';
import type {
  TeamCreateRequest,
  TeamCreateResponse,
  TeamLaunchRequest,
  TeamLaunchResponse,
  TeamProvisioningProgress,
} from '@shared/types';

type ProgressObserver = (progress: TeamProvisioningProgress) => void;

interface ProvisionTeamDependencies {
  start: TeamProvisioningStartPort;
  repository: TeamProvisioningRepositoryPort;
  workspace: TeamProvisioningWorkspacePort;
  effects: TeamProvisioningEffectsPort;
}

export class ProvisionTeam {
  constructor(private readonly dependencies: ProvisionTeamDependencies) {}

  async create(
    request: TeamCreateRequest,
    observer: ProgressObserver
  ): Promise<TeamCreateResponse> {
    const { effects } = this.dependencies;
    effects.addBreadcrumb('create', request.teamName);
    effects.noteLaunchIntent(request.teamName, 'create');
    effects.markTeamEngaged(request.teamName);
    try {
      const response = await this.dependencies.start.createTeam(
        request,
        this.observeProgress(observer)
      );
      effects.invalidateRosterSnapshots(request.teamName);
      return response;
    } catch (error) {
      effects.noteFailureBeforeProgress(request.teamName, 'create');
      throw error;
    }
  }

  async launch(
    input: ValidatedTeamLaunchInput,
    observer: ProgressObserver,
    mode: TeamLaunchMode
  ): Promise<TeamCreateResponse | TeamLaunchResponse> {
    if (mode === 'draft') {
      return this.launchDraft(input, observer);
    }
    return this.relaunchExistingTeam(input, observer);
  }

  private async launchDraft(
    input: ValidatedTeamLaunchInput,
    observer: ProgressObserver
  ): Promise<TeamCreateResponse> {
    const savedRequest = await this.dependencies.repository.getSavedRequest(input.teamName);
    if (!savedRequest) {
      throw new Error(`Missing saved request for draft team: ${input.teamName}`);
    }

    const { payload } = input;
    const savedProviderId = savedRequest.providerId ?? 'anthropic';
    const providerId =
      input.explicitProviderId ?? savedRequest.providerId ?? input.defaultProviderId;
    const providerChanged =
      input.explicitProviderId != null && input.explicitProviderId !== savedProviderId;
    const effortValidation = parseOptionalTeamEffort(
      Object.hasOwn(payload, 'effort')
        ? payload.effort
        : providerChanged
          ? undefined
          : savedRequest.effort,
      providerId
    );
    if (!effortValidation.valid) throw new Error(effortValidation.error);
    const fastModeValidation = parseOptionalTeamFastMode(
      Object.hasOwn(payload, 'fastMode')
        ? payload.fastMode
        : providerChanged
          ? undefined
          : savedRequest.fastMode
    );
    if (!fastModeValidation.valid) throw new Error(fastModeValidation.error);

    const model = Object.hasOwn(payload, 'model')
      ? typeof payload.model === 'string'
        ? payload.model.trim() || undefined
        : undefined
      : providerChanged
        ? undefined
        : savedRequest.model;
    const limitContext =
      typeof payload.limitContext === 'boolean'
        ? payload.limitContext
        : providerChanged
          ? undefined
          : savedRequest.limitContext;
    const createRequest: TeamCreateRequest = {
      teamName: input.teamName,
      displayName: savedRequest.displayName,
      description: savedRequest.description,
      color: savedRequest.color,
      cwd: input.cwd,
      prompt:
        typeof payload.prompt === 'string'
          ? payload.prompt.trim() || undefined
          : savedRequest.prompt,
      providerId,
      providerBackendId: migrateProviderBackendId(
        providerId,
        input.explicitProviderBackendId ?? savedRequest.providerBackendId
      ),
      model,
      effort: effortValidation.value,
      fastMode: fastModeValidation.value,
      limitContext,
      skipPermissions:
        typeof payload.skipPermissions === 'boolean'
          ? payload.skipPermissions
          : savedRequest.skipPermissions,
      worktree:
        typeof payload.worktree === 'string'
          ? payload.worktree.trim() || undefined
          : savedRequest.worktree,
      extraCliArgs:
        typeof payload.extraCliArgs === 'string'
          ? payload.extraCliArgs.trim() || undefined
          : savedRequest.extraCliArgs,
      members: savedRequest.members,
    };

    const { effects } = this.dependencies;
    effects.noteLaunchIntent(input.teamName, 'draft-launch');
    effects.markTeamEngaged(input.teamName);
    try {
      const response = await this.dependencies.start.createTeam(
        createRequest,
        this.observeProgress(observer)
      );
      effects.invalidateRosterSnapshots(input.teamName);
      return response;
    } catch (error) {
      effects.noteFailureBeforeProgress(input.teamName, 'draft-launch');
      throw error;
    }
  }

  private async relaunchExistingTeam(
    input: ValidatedTeamLaunchInput,
    observer: ProgressObserver
  ): Promise<TeamLaunchResponse> {
    const metadata = await this.dependencies.workspace
      .getMetadata(input.teamName)
      .catch(() => null);
    const persistedProviderId =
      metadata?.launchIdentity?.providerId ?? metadata?.providerId ?? 'anthropic';
    const providerId =
      input.explicitProviderId ??
      metadata?.launchIdentity?.providerId ??
      metadata?.providerId ??
      input.defaultProviderId;
    const providerChanged =
      input.explicitProviderId != null && input.explicitProviderId !== persistedProviderId;
    const rawBackend = Object.hasOwn(input.payload, 'providerBackendId')
      ? input.payload.providerBackendId
      : providerChanged
        ? undefined
        : metadata?.launchIdentity
          ? migrateProviderBackendId(
              metadata.launchIdentity.providerId,
              metadata.launchIdentity.providerBackendId ?? metadata.providerBackendId
            )
          : metadata?.providerBackendId;
    const backendValidation = parseOptionalLaunchProviderBackendId(rawBackend, providerId);
    if (!backendValidation.valid) throw new Error(backendValidation.error);

    const persistedEffort = providerChanged
      ? undefined
      : (metadata?.launchIdentity?.selectedEffort ?? metadata?.effort);
    const rawEffort = Object.hasOwn(input.payload, 'effort')
      ? input.payload.effort
      : persistedEffort;
    const effortValidation = parseOptionalTeamEffort(rawEffort, providerId);
    if (!effortValidation.valid) throw new Error(effortValidation.error);
    const persistedFastMode = providerChanged
      ? undefined
      : (metadata?.launchIdentity?.selectedFastMode ?? metadata?.fastMode);
    const rawFastMode = Object.hasOwn(input.payload, 'fastMode')
      ? input.payload.fastMode
      : persistedFastMode;
    const fastModeValidation = parseOptionalTeamFastMode(rawFastMode);
    if (!fastModeValidation.valid) throw new Error(fastModeValidation.error);
    const persistedModel = providerChanged
      ? undefined
      : (metadata?.launchIdentity?.selectedModel ?? metadata?.model);
    const model = Object.hasOwn(input.payload, 'model')
      ? typeof input.payload.model === 'string' && input.payload.model.trim().length > 0
        ? input.payload.model.trim()
        : undefined
      : persistedModel;
    const limitContext =
      typeof input.payload.limitContext === 'boolean'
        ? input.payload.limitContext
        : providerChanged
          ? undefined
          : metadata?.limitContext;

    const request: TeamLaunchRequest = {
      teamName: input.teamName,
      cwd: input.cwd,
      prompt:
        typeof input.payload.prompt === 'string'
          ? input.payload.prompt.trim() || undefined
          : undefined,
      providerId,
      providerBackendId: backendValidation.value,
      model,
      effort: effortValidation.value,
      fastMode: fastModeValidation.value,
      limitContext,
      clearContext: input.payload.clearContext === true ? true : undefined,
      skipPermissions:
        typeof input.payload.skipPermissions === 'boolean'
          ? input.payload.skipPermissions
          : undefined,
      worktree:
        typeof input.payload.worktree === 'string'
          ? input.payload.worktree.trim() || undefined
          : undefined,
      extraCliArgs:
        typeof input.payload.extraCliArgs === 'string'
          ? input.payload.extraCliArgs.trim() || undefined
          : undefined,
    };

    const { effects } = this.dependencies;
    effects.addBreadcrumb('launch', input.teamName);
    effects.noteLaunchIntent(input.teamName, 'launch');
    effects.markTeamEngaged(input.teamName);
    try {
      const response = await this.dependencies.start.launchTeam(
        request,
        this.observeProgress(observer)
      );
      effects.invalidateRosterSnapshots(input.teamName);
      return response;
    } catch (error) {
      effects.noteFailureBeforeProgress(input.teamName, 'launch');
      throw error;
    }
  }

  private observeProgress(observer: ProgressObserver): ProgressObserver {
    return (progress) => {
      this.dependencies.effects.noteProgress(progress);
      observer(progress);
    };
  }
}
