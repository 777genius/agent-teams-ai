import { validateTeamName } from '@main/ipc/guards';

import {
  normalizeCreateTeamRequest,
  normalizeLaunchTeamRequest,
  normalizeProvisioningPrepareInput,
} from './normalizeTeamProvisioningInput';

import type {
  TeamProvisioningFeature,
  TeamProvisioningIpcEvent,
  TeamProvisioningIpcHost,
} from '../../../composition/TeamProvisioningIpcBoundary';
import type {
  IpcResult,
  TeamCreateResponse,
  TeamLaunchFailureDiagnosticsBundle,
  TeamLaunchResponse,
  TeamProvisioningPrepareResult,
  TeamProvisioningProgress,
} from '@shared/types';
import type { CliArgsValidationResult } from '@shared/utils/cliArgsParser';

export interface TeamProvisioningIpcHandlers {
  create(event: TeamProvisioningIpcEvent, request: unknown): Promise<IpcResult<TeamCreateResponse>>;
  launch(
    event: TeamProvisioningIpcEvent,
    request: unknown
  ): Promise<IpcResult<TeamCreateResponse | TeamLaunchResponse>>;
  validateCliArgs(
    event: TeamProvisioningIpcEvent,
    rawArgs: unknown
  ): Promise<IpcResult<CliArgsValidationResult>>;
  prepare(
    event: TeamProvisioningIpcEvent,
    cwd: unknown,
    providerId: unknown,
    providerIds: unknown,
    selectedModels: unknown,
    limitContext: unknown,
    modelVerificationMode: unknown,
    selectedModelChecks: unknown
  ): Promise<IpcResult<TeamProvisioningPrepareResult>>;
  status(
    event: TeamProvisioningIpcEvent,
    runId: unknown
  ): Promise<IpcResult<TeamProvisioningProgress>>;
  launchDiagnostics(
    event: TeamProvisioningIpcEvent,
    teamName: unknown,
    runId: unknown
  ): Promise<IpcResult<TeamLaunchFailureDiagnosticsBundle>>;
  cancel(event: TeamProvisioningIpcEvent, runId: unknown): Promise<IpcResult<void>>;
}

async function execute<T>(
  feature: TeamProvisioningFeature,
  operation: string,
  action: () => Promise<T>
): Promise<IpcResult<T>> {
  try {
    return { success: true, data: await action() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    feature.logger.error(`[teams:${operation}] ${message}`);
    return { success: false, error: message };
  }
}

function normalizeRunId(runId: unknown): string | null {
  return typeof runId === 'string' && runId.trim().length > 0 ? runId.trim() : null;
}

export function createTeamProvisioningIpcHandlers(
  feature: TeamProvisioningFeature,
  host: TeamProvisioningIpcHost
): TeamProvisioningIpcHandlers {
  if (!host || typeof host.observeProgress !== 'function') {
    throw new TypeError('Team provisioning progress host is required');
  }
  return {
    create: async (
      event: TeamProvisioningIpcEvent,
      request: unknown
    ): Promise<IpcResult<TeamCreateResponse>> => {
      const validation = await normalizeCreateTeamRequest(request, feature.workspace);
      if (!validation.valid) return { success: false, error: validation.error };
      return execute(feature, 'create', () =>
        feature.provisionTeam.create(validation.value, host.observeProgress(event))
      );
    },

    launch: async (
      event: TeamProvisioningIpcEvent,
      request: unknown
    ): Promise<IpcResult<TeamCreateResponse | TeamLaunchResponse>> => {
      if (!request || typeof request !== 'object') {
        return { success: false, error: 'Invalid team launch request' };
      }
      const observeProgress = host.observeProgress(event);
      const validation = await normalizeLaunchTeamRequest(request, feature.workspace);
      if (!validation.valid) return { success: false, error: validation.error };
      const mode = await feature.resolveLaunchMode.execute(validation.value.teamName);
      return execute(feature, mode === 'draft' ? 'create' : 'launch', () =>
        feature.provisionTeam.launch(validation.value, observeProgress, mode)
      );
    },

    validateCliArgs: async (
      _event: TeamProvisioningIpcEvent,
      rawArgs: unknown
    ): Promise<IpcResult<CliArgsValidationResult>> => {
      if (typeof rawArgs !== 'string') {
        return { success: false, error: 'rawArgs must be a string' };
      }
      if (rawArgs.length > 2048) {
        return { success: false, error: 'rawArgs too long (max 2048)' };
      }
      return execute(feature, 'validateCliArgs', () => feature.preflight.validateCliArgs(rawArgs));
    },

    prepare: async (
      _event: TeamProvisioningIpcEvent,
      cwd: unknown,
      providerId: unknown,
      providerIds: unknown,
      selectedModels: unknown,
      limitContext: unknown,
      modelVerificationMode: unknown,
      selectedModelChecks: unknown
    ): Promise<IpcResult<TeamProvisioningPrepareResult>> => {
      const validation = normalizeProvisioningPrepareInput(
        cwd,
        providerId,
        providerIds,
        selectedModels,
        limitContext,
        modelVerificationMode,
        selectedModelChecks,
        (candidate) => feature.workspace.isAbsolute(candidate)
      );
      if (!validation.valid) return { success: false, error: validation.error };
      return execute(feature, 'prepareProvisioning', () =>
        feature.preflight.prepare(validation.value)
      );
    },

    status: async (
      _event: TeamProvisioningIpcEvent,
      runId: unknown
    ): Promise<IpcResult<TeamProvisioningProgress>> => {
      const normalizedRunId = normalizeRunId(runId);
      if (!normalizedRunId) return { success: false, error: 'runId is required' };
      return execute(feature, 'provisioningStatus', () =>
        feature.getStatus.execute(normalizedRunId)
      );
    },

    launchDiagnostics: async (
      _event: TeamProvisioningIpcEvent,
      teamName: unknown,
      runId: unknown
    ): Promise<IpcResult<TeamLaunchFailureDiagnosticsBundle>> => {
      const teamNameValidation = validateTeamName(teamName);
      if (!teamNameValidation.valid) {
        return { success: false, error: teamNameValidation.error ?? 'Invalid teamName' };
      }
      const normalizedRunId =
        typeof runId === 'string' && runId.trim().length > 0 ? runId.trim() : undefined;
      return execute(feature, 'launchFailureDiagnostics', () =>
        feature.readLaunchDiagnostics.execute(teamNameValidation.value!, normalizedRunId)
      );
    },

    cancel: async (_event: TeamProvisioningIpcEvent, runId: unknown): Promise<IpcResult<void>> => {
      const normalizedRunId = normalizeRunId(runId);
      if (!normalizedRunId) return { success: false, error: 'runId is required' };
      return execute(feature, 'cancelProvisioning', () => feature.cancel.execute(normalizedRunId));
    },
  };
}
