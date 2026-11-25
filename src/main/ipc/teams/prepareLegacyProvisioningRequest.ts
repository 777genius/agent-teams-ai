import path from 'node:path';

import { isTeamProviderId } from '@shared/utils/teamProvider';

import { parseOptionalTeamEffort } from '../teamIpcRequestParsers';

import type { TeamProvisioningPreflightApi } from '@main/services/team/contracts/TeamProvisioningApis';
import type { IpcResult } from '@shared/types/ipc';
import type {
  TeamLaunchRequest,
  TeamProviderId,
  TeamProvisioningModelCheckRequest,
  TeamProvisioningModelVerificationMode,
  TeamProvisioningPrepareResult,
} from '@shared/types/team';

type LegacyPrepare = (
  ...args: Parameters<TeamProvisioningPreflightApi['prepareForProvisioning']>
) => Promise<IpcResult<TeamProvisioningPrepareResult>>;

/** Existing IPC normalization; no service, native lookup or configuration is owned here. */
export function prepareLegacy(
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
