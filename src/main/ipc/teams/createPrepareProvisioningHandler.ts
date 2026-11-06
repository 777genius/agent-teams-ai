import path from 'node:path';

import { isHostTeamSelectionKey } from '@features/agent-backend/contracts';
import { isTeamProviderId } from '@shared/utils/teamProvider';
import { parseTeamProvisioningContext } from '@shared/utils/teamProvisioningContext';

import {
  isDesktopAgentBackendSelected,
  prepareDesktopCapturedTeam,
  prepareDesktopCreatedTeam,
} from '../agentBackend';
import { parseOptionalTeamEffort } from '../teamIpcRequestParsers';

import type { TeamProvisioningPreflightApi } from '@main/services/team/contracts/TeamProvisioningApis';
import type { IpcResult } from '@shared/types/ipc';
import type {
  TeamLaunchRequest,
  TeamProviderId,
  TeamProvisioningModelCheckRequest,
  TeamProvisioningModelVerificationMode,
  TeamProvisioningPrepareContext,
  TeamProvisioningPrepareResult,
} from '@shared/types/team';
import type { IpcMainInvokeEvent } from 'electron';

type Handler = (
  event: IpcMainInvokeEvent,
  ...args: unknown[]
) => Promise<IpcResult<TeamProvisioningPrepareResult>>;
type LegacyPrepare = (
  ...args: Parameters<TeamProvisioningPreflightApi['prepareForProvisioning']>
) => Promise<IpcResult<TeamProvisioningPrepareResult>>;
type TeamHostPrepare = (
  event: IpcMainInvokeEvent,
  context: Extract<TeamProvisioningPrepareContext, { kind: 'team' }>,
  ...args: Parameters<TeamProvisioningPreflightApi['prepareForProvisioning']>
) => Promise<TeamProvisioningPrepareResult>;

/** An existing dialog's Host intent must never run fork discovery/model tests. */
export function createPrepareProvisioningHandler(
  legacy: LegacyPrepare,
  selected: () => boolean = isDesktopAgentBackendSelected,
  host: TeamHostPrepare = (event, context, cwd, options) =>
    prepareDesktopCapturedTeam(event, context.teamName, {
      ...options,
      ...(cwd === undefined ? {} : { cwd }),
      ...(context.selectedModelChecks === undefined
        ? {}
        : { selectedModelChecks: context.selectedModelChecks }),
      ...(context.preparationId === undefined ? {} : { preparationId: context.preparationId }),
    })
): Handler {
  return async (event, ...args) => {
    let context;
    try {
      if (args.length > 8) throw new Error('Invalid provisioning context');
      context = parseTeamProvisioningContext(args[7]);
    } catch {
      return { success: false, error: 'Invalid provisioning context' };
    }
    if (context?.kind === 'team' && isHostTeamSelectionKey(context.teamName)) {
      const captured = context;
      return prepareLegacy(
        async (cwd, options) => ({
          success: true,
          data: await host(event, captured, cwd, options),
        }),
        ...args.slice(0, 7)
      );
    }
    if (selected() && context?.kind === 'create' && context.draft && context.preparationId) {
      const captured = context;
      return prepareLegacy(
        async (cwd) => ({
          success: true,
          data: await prepareDesktopCreatedTeam(event, captured, cwd),
        }),
        ...args.slice(0, 7)
      );
    }
    if (selected() && (!context || context.kind === 'create')) {
      // Until the captured Team preflight is connected, report the real gap.
      // A global Claude test or legacy preflight cannot establish this owner's
      // account/configuration/capability readiness.
      return {
        success: true,
        data: {
          ready: false,
          message: 'Captured Host provisioning checks are not connected yet.',
          details: ['Refresh after Host preparation is available. No legacy checks were run.'],
        },
      };
    }
    return prepareLegacy(legacy, ...args.slice(0, 7));
  };
}

/** Existing IPC normalization; no service, native lookup or configuration is owned here. */
function prepareLegacy(
  legacy: LegacyPrepare,
  cwd?: unknown,
  providerId?: unknown,
  providerIds?: unknown,
  selectedModels?: unknown,
  limitContext?: unknown,
  modelVerificationMode?: unknown,
  selectedModelChecks?: unknown
): Promise<IpcResult<TeamProvisioningPrepareResult>> | IpcResult<TeamProvisioningPrepareResult> {
  let validatedCwd: string | undefined;
  let validatedProviderId: TeamLaunchRequest['providerId'];
  let validatedProviderIds: TeamProviderId[] | undefined;
  let validatedSelectedModels: string[] | undefined;
  let validatedLimitContext: boolean | undefined;
  let validatedModelVerificationMode: TeamProvisioningModelVerificationMode | undefined;
  let validatedSelectedModelChecks: TeamProvisioningModelCheckRequest[] | undefined;
  if (cwd !== undefined) {
    if (typeof cwd !== 'string' || cwd.trim().length === 0)
      return { success: false, error: 'cwd must be a non-empty string' };
    validatedCwd = cwd.trim();
    if (!path.isAbsolute(validatedCwd))
      return { success: false, error: 'cwd must be an absolute path' };
  }
  if (providerId !== undefined) {
    if (!isTeamProviderId(providerId))
      return { success: false, error: 'providerId must be anthropic, codex, gemini, or opencode' };
    validatedProviderId = providerId;
  }
  if (providerIds !== undefined) {
    if (!Array.isArray(providerIds))
      return { success: false, error: 'providerIds must be an array when provided' };
    const normalized: TeamProviderId[] = [];
    for (const entry of providerIds) {
      if (!isTeamProviderId(entry))
        return {
          success: false,
          error: 'providerIds entries must be anthropic, codex, gemini, or opencode',
        };
      if (!normalized.includes(entry)) normalized.push(entry);
    }
    validatedProviderIds = normalized;
  }
  if (selectedModels !== undefined) {
    if (!Array.isArray(selectedModels))
      return { success: false, error: 'selectedModels must be an array when provided' };
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < selectedModels.length; index += 1) {
      if (!Object.hasOwn(selectedModels, index))
        return { success: false, error: 'selectedModels entries must be non-empty strings' };
      const entry = selectedModels[index];
      if (typeof entry !== 'string' || entry.trim().length === 0)
        return { success: false, error: 'selectedModels entries must be non-empty strings' };
      const model = entry.trim();
      if (!seen.has(model)) {
        seen.add(model);
        normalized.push(model);
      }
    }
    validatedSelectedModels = normalized;
  }
  if (limitContext !== undefined) {
    if (typeof limitContext !== 'boolean')
      return { success: false, error: 'limitContext must be a boolean when provided' };
    validatedLimitContext = limitContext;
  }
  if (modelVerificationMode !== undefined) {
    if (modelVerificationMode !== 'compatibility' && modelVerificationMode !== 'deep')
      return {
        success: false,
        error: 'modelVerificationMode must be compatibility or deep when provided',
      };
    validatedModelVerificationMode = modelVerificationMode;
  }
  if (selectedModelChecks !== undefined) {
    if (!Array.isArray(selectedModelChecks))
      return { success: false, error: 'selectedModelChecks must be an array when provided' };
    const normalized: TeamProvisioningModelCheckRequest[] = [];
    const seen = new Set<string>();
    for (const entry of selectedModelChecks) {
      if (!entry || typeof entry !== 'object')
        return { success: false, error: 'selectedModelChecks entries must be objects' };
      const rawEntry = entry as { providerId?: unknown; model?: unknown; effort?: unknown };
      if (!isTeamProviderId(rawEntry.providerId))
        return {
          success: false,
          error: 'selectedModelChecks entries must include a valid providerId',
        };
      if (typeof rawEntry.model !== 'string' || rawEntry.model.trim().length === 0)
        return {
          success: false,
          error: 'selectedModelChecks entries must include a non-empty model',
        };
      const effortValidation = parseOptionalTeamEffort(rawEntry.effort, rawEntry.providerId);
      if (!effortValidation.valid)
        return { success: false, error: `selectedModelChecks ${effortValidation.error}` };
      const model = rawEntry.model.trim();
      const key = `${rawEntry.providerId}\n${model}\n${effortValidation.value ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      normalized.push({
        providerId: rawEntry.providerId,
        model,
        ...(effortValidation.value ? { effort: effortValidation.value } : {}),
      });
    }
    validatedSelectedModelChecks = normalized;
  }
  return legacy(validatedCwd, {
    providerId: validatedProviderId,
    providerIds: validatedProviderIds,
    modelIds: validatedSelectedModels,
    limitContext: validatedLimitContext,
    modelVerificationMode: validatedModelVerificationMode,
    modelChecks: validatedSelectedModelChecks,
  });
}
