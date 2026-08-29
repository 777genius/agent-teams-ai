import { isTeamProviderId } from '@shared/utils/teamProvider';
import * as path from 'path';

import { validateAuthoritativePrepareRequest } from './validateAuthoritativePrepareRequest';
import { validateProvisioningModelCheck } from './validateProvisioningModelCheck';

import type {
  TeamLaunchRequest,
  TeamProviderId,
  TeamProvisioningModelCheckRequest,
  TeamProvisioningModelVerificationMode,
} from '@shared/types';

export interface PrepareProvisioningRequestInput {
  cwd: unknown;
  providerId: unknown;
  providerIds: unknown;
  selectedModels: unknown;
  limitContext: unknown;
  modelVerificationMode: unknown;
  selectedModelChecks: unknown;
  allowExperimentalLocalModels: unknown;
}

export interface ValidatedPrepareProvisioningRequest {
  cwd: string | undefined;
  providerId: TeamLaunchRequest['providerId'];
  providerIds: TeamProviderId[] | undefined;
  selectedModels: string[] | undefined;
  limitContext: boolean | undefined;
  modelVerificationMode: TeamProvisioningModelVerificationMode | undefined;
  selectedModelChecks: TeamProvisioningModelCheckRequest[] | undefined;
  allowExperimentalLocalModels: boolean | undefined;
}

type ValidationResult =
  | { valid: true; value: ValidatedPrepareProvisioningRequest }
  | { valid: false; error: string };

export function validatePrepareProvisioningRequest(
  input: PrepareProvisioningRequestInput
): ValidationResult {
  let cwd: string | undefined;
  if (input.cwd !== undefined) {
    if (typeof input.cwd !== 'string' || input.cwd.trim().length === 0) {
      return { valid: false, error: 'cwd must be a non-empty string' };
    }
    cwd = input.cwd.trim();
    if (!path.isAbsolute(cwd)) return { valid: false, error: 'cwd must be an absolute path' };
  }

  let providerId: TeamLaunchRequest['providerId'];
  if (input.providerId !== undefined) {
    if (!isTeamProviderId(input.providerId)) {
      return {
        valid: false,
        error: 'providerId must be anthropic, codex, gemini, or opencode',
      };
    }
    providerId = input.providerId;
  }

  let providerIds: TeamProviderId[] | undefined;
  if (input.providerIds !== undefined) {
    if (!Array.isArray(input.providerIds)) {
      return { valid: false, error: 'providerIds must be an array when provided' };
    }
    providerIds = [];
    for (const entry of input.providerIds) {
      if (!isTeamProviderId(entry)) {
        return {
          valid: false,
          error: 'providerIds entries must be anthropic, codex, gemini, or opencode',
        };
      }
      if (!providerIds.includes(entry)) providerIds.push(entry);
    }
  }

  let selectedModels: string[] | undefined;
  if (input.selectedModels !== undefined) {
    if (!Array.isArray(input.selectedModels)) {
      return { valid: false, error: 'selectedModels must be an array when provided' };
    }
    selectedModels = [];
    const seen = new Set<string>();
    for (let index = 0; index < input.selectedModels.length; index += 1) {
      if (!Object.hasOwn(input.selectedModels, index)) {
        return { valid: false, error: 'selectedModels entries must be non-empty strings' };
      }
      const entry = input.selectedModels[index];
      if (typeof entry !== 'string' || entry.trim().length === 0) {
        return { valid: false, error: 'selectedModels entries must be non-empty strings' };
      }
      const model = entry.trim();
      if (!seen.has(model)) {
        seen.add(model);
        selectedModels.push(model);
      }
    }
  }

  let limitContext: boolean | undefined;
  if (input.limitContext !== undefined) {
    if (typeof input.limitContext !== 'boolean') {
      return { valid: false, error: 'limitContext must be a boolean when provided' };
    }
    limitContext = input.limitContext;
  }

  let modelVerificationMode: TeamProvisioningModelVerificationMode | undefined;
  if (input.modelVerificationMode !== undefined) {
    if (input.modelVerificationMode !== 'compatibility' && input.modelVerificationMode !== 'deep') {
      return {
        valid: false,
        error: 'modelVerificationMode must be compatibility or deep when provided',
      };
    }
    modelVerificationMode = input.modelVerificationMode;
  }

  let selectedModelChecks: TeamProvisioningModelCheckRequest[] | undefined;
  if (input.selectedModelChecks !== undefined) {
    if (!Array.isArray(input.selectedModelChecks)) {
      return { valid: false, error: 'selectedModelChecks must be an array when provided' };
    }
    selectedModelChecks = [];
    const seen = new Set<string>();
    for (const entry of input.selectedModelChecks) {
      const validation = validateProvisioningModelCheck(entry);
      if (!validation.valid) return { valid: false, error: validation.error };
      if (seen.has(validation.key)) {
        return {
          valid: false,
          error: 'selectedModelChecks must not contain duplicate checks',
        };
      }
      seen.add(validation.key);
      selectedModelChecks.push(validation.value);
    }
  }

  const proofRequest = validateAuthoritativePrepareRequest({
    providerId,
    providerIds,
    mode: modelVerificationMode,
    checks: selectedModelChecks,
    allowExperimentalLocalModels: input.allowExperimentalLocalModels,
  });
  if (!proofRequest.valid) return { valid: false, error: proofRequest.error };
  return {
    valid: true,
    value: {
      cwd,
      providerId,
      providerIds,
      selectedModels,
      limitContext,
      modelVerificationMode,
      selectedModelChecks,
      allowExperimentalLocalModels: proofRequest.allowExperimentalLocalModels,
    },
  };
}
