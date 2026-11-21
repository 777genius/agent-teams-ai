import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import type {
  MemberSettingsEffort,
  MemberSettingsFastMode,
  MemberSettingsProviderBackendId,
  MemberSettingsProviderId,
} from '../../../contracts/memberSettings';

/** Saved values as member settings read them: anything unknown is "not set". */

export function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function providerId(value: unknown): MemberSettingsProviderId | null {
  return normalizeOptionalTeamProviderId(value) ?? null;
}

export function backendId(value: unknown): MemberSettingsProviderBackendId | null {
  return value === 'auto' ||
    value === 'adapter' ||
    value === 'api' ||
    value === 'cli-sdk' ||
    value === 'codex-native' ||
    value === 'opencode-cli'
    ? value
    : null;
}

export function effort(value: unknown): MemberSettingsEffort | null {
  return value === 'none' ||
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max' ||
    value === 'ultra'
    ? value
    : null;
}

export function fastMode(value: unknown): MemberSettingsFastMode | null {
  return value === 'inherit' || value === 'on' || value === 'off' ? value : null;
}
