import {
  formatEffortLevelListForProvider,
  isTeamEffortLevelForProvider,
} from '@shared/utils/effortLevels';
import { isTeamProviderBackendId, migrateProviderBackendId } from '@shared/utils/providerBackend';
import { isTeamProviderId } from '@shared/utils/teamProvider';

import type {
  EffortLevel,
  TeamFastMode,
  TeamProviderBackendId,
  TeamProviderId,
} from '@shared/types';

type ValidationResult<T> = { valid: true; value: T } | { valid: false; error: string };

export function isProvisioningTeamName(teamName: string): boolean {
  if (teamName.length > 64) return false;
  const parts = teamName.split('-');
  return parts.every((part) => /^[a-z0-9]+$/.test(part));
}

function isValidEffort(value: unknown, providerId?: TeamProviderId | null): value is EffortLevel {
  return isTeamEffortLevelForProvider(value, providerId);
}

function parseOptionalProviderId(
  value: unknown,
  fieldName: string
): ValidationResult<TeamProviderId | undefined> {
  if (value === undefined || value === null || value === '') {
    return { valid: true, value: undefined };
  }
  if (isTeamProviderId(value)) {
    return { valid: true, value };
  }
  return { valid: false, error: `${fieldName} must be anthropic, codex, gemini, or opencode` };
}

export function parseOptionalMemberProviderId(
  value: unknown
): ValidationResult<TeamProviderId | undefined> {
  return parseOptionalProviderId(value, 'member providerId');
}

export function parseOptionalTeamProviderId(
  value: unknown
): ValidationResult<TeamProviderId | undefined> {
  return parseOptionalProviderId(value, 'providerId');
}

export function parseOptionalProviderBackendId(
  value: unknown,
  providerId?: TeamProviderId
): ValidationResult<TeamProviderBackendId | undefined> {
  if (value === undefined || value === null || value === '') {
    return { valid: true, value: undefined };
  }
  if (typeof value !== 'string') {
    return { valid: false, error: 'providerBackendId must be a string' };
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return { valid: true, value: undefined };
  }
  if (trimmed.length > 64) {
    return { valid: false, error: 'providerBackendId too long (max 64)' };
  }
  if (providerId) {
    const migratedBackendId = migrateProviderBackendId(providerId, trimmed);
    if (migratedBackendId) {
      return { valid: true, value: migratedBackendId };
    }
  } else if (isTeamProviderBackendId(trimmed)) {
    return { valid: true, value: trimmed };
  }

  return {
    valid: false,
    error:
      'providerBackendId must be valid for the selected provider (auto, adapter, api, cli-sdk, codex-native, or opencode-cli)',
  };
}

export function parseOptionalLaunchProviderBackendId(
  value: unknown,
  providerId?: TeamProviderId
): ValidationResult<TeamProviderBackendId | undefined> {
  if (value === undefined || value === null || value === '') {
    return { valid: true, value: undefined };
  }
  if (typeof value !== 'string') {
    return { valid: false, error: 'providerBackendId must be a string' };
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return { valid: true, value: undefined };
  }
  if (trimmed.length > 64) {
    return { valid: false, error: 'providerBackendId too long (max 64)' };
  }

  const migratedBackendId = migrateProviderBackendId(providerId, trimmed);
  if (migratedBackendId) {
    return { valid: true, value: migratedBackendId };
  }

  if (isTeamProviderBackendId(trimmed)) {
    return { valid: true, value: undefined };
  }

  return {
    valid: false,
    error:
      'providerBackendId must be valid for the selected provider (auto, adapter, api, cli-sdk, codex-native, or opencode-cli)',
  };
}

export function parseOptionalMemberEffort(
  value: unknown,
  providerId?: TeamProviderId | null
): ValidationResult<EffortLevel | undefined> {
  if (value === undefined || value === null || value === '') {
    return { valid: true, value: undefined };
  }
  if (isValidEffort(value, providerId)) {
    return { valid: true, value };
  }
  return {
    valid: false,
    error: `member effort must be one of ${formatEffortLevelListForProvider(providerId)}`,
  };
}

export function parseOptionalTeamEffort(
  value: unknown,
  providerId?: TeamProviderId | null
): ValidationResult<EffortLevel | undefined> {
  if (value === undefined || value === null || value === '') {
    return { valid: true, value: undefined };
  }
  if (isValidEffort(value, providerId)) {
    return { valid: true, value };
  }
  return {
    valid: false,
    error: `effort must be one of ${formatEffortLevelListForProvider(providerId)}`,
  };
}

export function parseOptionalTeamFastMode(
  value: unknown
): ValidationResult<TeamFastMode | undefined> {
  if (value === undefined || value === null || value === '') {
    return { valid: true, value: undefined };
  }
  if (value === 'inherit' || value === 'on' || value === 'off') {
    return { valid: true, value };
  }
  return {
    valid: false,
    error: 'fastMode must be one of inherit, on, or off',
  };
}
