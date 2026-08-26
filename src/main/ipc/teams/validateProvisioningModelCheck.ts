import { isTeamProviderId } from '@shared/utils/teamProvider';

import {
  parseOptionalLaunchProviderBackendId,
  parseOptionalTeamEffort,
} from '../teamIpcRequestParsers';

import type { TeamProvisioningModelCheckRequest } from '@shared/types';

export function validateProvisioningModelCheck(
  entry: unknown
):
  | { valid: true; value: TeamProvisioningModelCheckRequest; key: string }
  | { valid: false; error: string } {
  if (!entry || typeof entry !== 'object') {
    return { valid: false, error: 'selectedModelChecks entries must be objects' };
  }
  const raw = entry as Record<'providerId' | 'providerBackendId' | 'model' | 'effort', unknown>;
  if (!isTeamProviderId(raw.providerId)) {
    return { valid: false, error: 'selectedModelChecks entries must include a valid providerId' };
  }
  if (!Object.hasOwn(raw, 'providerBackendId')) {
    return {
      valid: false,
      error: 'selectedModelChecks require an explicit providerBackendId (null for Anthropic)',
    };
  }
  const backend = parseOptionalLaunchProviderBackendId(raw.providerBackendId, raw.providerId);
  if (!backend.valid) return { valid: false, error: `selectedModelChecks ${backend.error}` };
  if (
    raw.providerId !== 'anthropic' &&
    (!backend.value || (backend.value === 'auto' && raw.providerId !== 'codex'))
  ) {
    return {
      valid: false,
      error: 'selectedModelChecks require a concrete resolved providerBackendId',
    };
  }
  if (typeof raw.model !== 'string' || !raw.model.trim()) {
    return { valid: false, error: 'selectedModelChecks entries must include a non-empty model' };
  }
  const effort = parseOptionalTeamEffort(raw.effort, raw.providerId);
  if (!effort.valid) return { valid: false, error: `selectedModelChecks ${effort.error}` };
  const value = {
    providerId: raw.providerId,
    providerBackendId: backend.value ?? null,
    model: raw.model.trim(),
    ...(effort.value ? { effort: effort.value } : {}),
  };
  return { valid: true, value, key: JSON.stringify(value) };
}
