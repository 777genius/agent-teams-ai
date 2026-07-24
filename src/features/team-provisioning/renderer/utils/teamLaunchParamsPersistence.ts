import { isTeamEffortLevel } from '@shared/utils/effortLevels';
import { migrateProviderBackendId } from '@shared/utils/providerBackend';

import type { TeamLaunchParams } from './teamLaunchParams';
import type { TeamFastMode, TeamProviderId } from '@shared/types';

const TEAM_PROVIDER_IDS = new Set<TeamProviderId>(['anthropic', 'codex', 'gemini', 'opencode']);
const TEAM_FAST_MODES = new Set<TeamFastMode>(['inherit', 'on', 'off']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function normalizePersistedTeamLaunchParams(value: unknown): TeamLaunchParams | null {
  if (!isRecord(value)) {
    return null;
  }

  const normalized: TeamLaunchParams = {};
  if (hasOwn(value, 'providerId')) {
    if (
      typeof value.providerId !== 'string' ||
      !TEAM_PROVIDER_IDS.has(value.providerId as TeamProviderId)
    ) {
      return null;
    }
    normalized.providerId = value.providerId as TeamProviderId;
  }

  if (hasOwn(value, 'providerBackendId')) {
    if (typeof value.providerBackendId !== 'string' || value.providerBackendId.trim() === '') {
      return null;
    }
    if (!normalized.providerId) {
      return null;
    }
    const providerBackendId = migrateProviderBackendId(
      normalized.providerId,
      value.providerBackendId
    );
    if (!providerBackendId && normalized.providerId !== 'anthropic') {
      return null;
    }
    if (providerBackendId) {
      normalized.providerBackendId = providerBackendId;
    }
  }

  if (hasOwn(value, 'model')) {
    if (typeof value.model !== 'string' || value.model.trim() === '') {
      return null;
    }
    normalized.model = value.model.trim();
  }

  if (hasOwn(value, 'effort')) {
    if (!isTeamEffortLevel(value.effort)) {
      return null;
    }
    normalized.effort = value.effort;
  }

  if (hasOwn(value, 'fastMode')) {
    if (
      typeof value.fastMode !== 'string' ||
      !TEAM_FAST_MODES.has(value.fastMode as TeamFastMode)
    ) {
      return null;
    }
    normalized.fastMode = value.fastMode as TeamFastMode;
  }

  if (hasOwn(value, 'limitContext')) {
    if (typeof value.limitContext !== 'boolean') {
      return null;
    }
    normalized.limitContext = value.limitContext;
  }

  return normalized;
}
