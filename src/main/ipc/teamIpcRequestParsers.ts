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

type ParseResult<T> = { valid: true; value: T | undefined } | { valid: false; error: string };

function parseOptionalProviderId(value: unknown, fieldName: string): ParseResult<TeamProviderId> {
  if (value === undefined || value === null || value === '') {
    return { valid: true, value: undefined };
  }
  return isTeamProviderId(value)
    ? { valid: true, value }
    : { valid: false, error: `${fieldName} must be anthropic, codex, gemini, or opencode` };
}

export function parseOptionalMemberProviderId(value: unknown): ParseResult<TeamProviderId> {
  return parseOptionalProviderId(value, 'member providerId');
}

export function parseOptionalTeamProviderId(value: unknown): ParseResult<TeamProviderId> {
  return parseOptionalProviderId(value, 'providerId');
}

export function parseOptionalProviderBackendId(
  value: unknown,
  providerId?: TeamProviderId
): ParseResult<TeamProviderBackendId> {
  if (value === undefined || value === null || value === '') {
    return { valid: true, value: undefined };
  }
  if (typeof value !== 'string') {
    return { valid: false, error: 'providerBackendId must be a string' };
  }
  const trimmed = value.trim();
  if (!trimmed) return { valid: true, value: undefined };
  if (trimmed.length > 64) {
    return { valid: false, error: 'providerBackendId too long (max 64)' };
  }
  const migratedBackendId = providerId
    ? migrateProviderBackendId(providerId, trimmed, 'explicit-selection')
    : isTeamProviderBackendId(trimmed)
      ? trimmed
      : null;
  return migratedBackendId
    ? { valid: true, value: migratedBackendId }
    : {
        valid: false,
        error:
          'providerBackendId must be valid for the selected provider (auto, adapter, api, cli-sdk, codex-native, or opencode-cli)',
      };
}

export function parseOptionalLaunchProviderBackendId(
  value: unknown,
  providerId?: TeamProviderId
): ParseResult<TeamProviderBackendId> {
  if (value === undefined || value === null || value === '') {
    return { valid: true, value: undefined };
  }
  if (typeof value !== 'string') {
    return { valid: false, error: 'providerBackendId must be a string' };
  }
  const trimmed = value.trim();
  if (!trimmed) return { valid: true, value: undefined };
  if (trimmed.length > 64) {
    return { valid: false, error: 'providerBackendId too long (max 64)' };
  }
  const migratedBackendId = migrateProviderBackendId(providerId, trimmed, 'explicit-selection');
  return migratedBackendId
    ? { valid: true, value: migratedBackendId }
    : {
        valid: false,
        error:
          'providerBackendId must be valid for the selected provider (auto, adapter, api, cli-sdk, codex-native, or opencode-cli)',
      };
}

export function parseOptionalMemberEffort(
  value: unknown,
  providerId?: TeamProviderId | null
): ParseResult<EffortLevel> {
  if (value === undefined || value === null || value === '') {
    return { valid: true, value: undefined };
  }
  return isTeamEffortLevelForProvider(value, providerId)
    ? { valid: true, value }
    : {
        valid: false,
        error: `member effort must be one of ${formatEffortLevelListForProvider(providerId)}`,
      };
}

export function parseOptionalTeamEffort(
  value: unknown,
  providerId?: TeamProviderId | null
): ParseResult<EffortLevel> {
  if (value === undefined || value === null || value === '') {
    return { valid: true, value: undefined };
  }
  return isTeamEffortLevelForProvider(value, providerId)
    ? { valid: true, value }
    : {
        valid: false,
        error: `effort must be one of ${formatEffortLevelListForProvider(providerId)}`,
      };
}

export function parseOptionalTeamFastMode(value: unknown): ParseResult<TeamFastMode> {
  if (value === undefined || value === null || value === '') {
    return { valid: true, value: undefined };
  }
  return value === 'inherit' || value === 'on' || value === 'off'
    ? { valid: true, value }
    : { valid: false, error: 'fastMode must be one of inherit, on, or off' };
}

export function parseOptionalBoolean(value: unknown, fieldName: string): ParseResult<boolean> {
  if (value === undefined) return { valid: true, value: undefined };
  return typeof value === 'boolean'
    ? { valid: true, value }
    : { valid: false, error: `${fieldName} must be a boolean` };
}
