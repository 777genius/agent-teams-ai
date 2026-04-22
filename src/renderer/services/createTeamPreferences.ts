import { normalizeCreateLaunchProviderForUi } from '@renderer/utils/geminiUiFreeze';
import { normalizeExplicitTeamModelForUi } from '@renderer/utils/teamModelAvailability';
import { isTeamEffortLevel } from '@shared/utils/effortLevels';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import type { EffortLevel, TeamFastMode, TeamProviderId } from '@shared/types';

const CREATE_TEAM_PREFIX = 'createTeam:';
const LEGACY_TEAM_PREFIX = 'team:';

const CREATE_TEAM_PROVIDER_KEY = `${CREATE_TEAM_PREFIX}lastSelectedProvider`;
const CREATE_TEAM_FAST_MODE_KEY = `${CREATE_TEAM_PREFIX}lastSelectedFastMode`;
const CREATE_TEAM_LIMIT_CONTEXT_KEY = `${CREATE_TEAM_PREFIX}lastLimitContext`;
const CREATE_TEAM_SKIP_PERMISSIONS_KEY = `${CREATE_TEAM_PREFIX}lastSkipPermissions`;
const CREATE_TEAM_EFFORT_KEY = `${CREATE_TEAM_PREFIX}lastSelectedEffort`;
const CREATE_TEAM_SYNC_MODELS_KEY = `${CREATE_TEAM_PREFIX}lastSyncModelsWithLead`;
const CREATE_TEAM_MEMBER_RUNTIME_PREFERENCES_KEY = `${CREATE_TEAM_PREFIX}lastMemberRuntimePreferences`;
const CREATE_TEAM_MEMBER_RUNTIME_PREFERENCES_VERSION = 1;

export interface CreateTeamMemberRuntimePreference {
  name: string;
  providerId?: TeamProviderId;
  model?: string;
  effort?: EffortLevel;
}

interface StoredCreateTeamMemberRuntimePreferences {
  version: number;
  members: CreateTeamMemberRuntimePreference[];
}

function readStorageItem(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStorageItem(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Ignore storage write failures in renderer helpers.
  }
}

function removeStorageItem(key: string): void {
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    // Ignore storage delete failures in renderer helpers.
  }
}

function readCreateTeamPreference(key: string, legacyKey?: string): string | null {
  const nextValue = readStorageItem(key);
  if (nextValue != null) {
    return nextValue;
  }
  return legacyKey ? readStorageItem(legacyKey) : null;
}

function isValidCreateTeamMemberRuntimePreference(
  value: unknown
): value is CreateTeamMemberRuntimePreference {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.name === 'string' &&
    (entry.providerId === undefined || normalizeOptionalTeamProviderId(entry.providerId) != null) &&
    (entry.model === undefined || typeof entry.model === 'string') &&
    (entry.effort === undefined || isTeamEffortLevel(entry.effort))
  );
}

function parseStoredCreateTeamMemberRuntimePreferences(
  value: string | null
): CreateTeamMemberRuntimePreference[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as StoredCreateTeamMemberRuntimePreferences;
    if (
      parsed.version !== CREATE_TEAM_MEMBER_RUNTIME_PREFERENCES_VERSION ||
      !Array.isArray(parsed.members)
    ) {
      return [];
    }

    return parsed.members.filter(isValidCreateTeamMemberRuntimePreference).map((entry) => {
      const providerId = normalizeOptionalTeamProviderId(entry.providerId);
      const normalizedModel = normalizeExplicitTeamModelForUi(providerId, entry.model ?? '');
      return {
        name: entry.name.trim(),
        providerId,
        model: normalizedModel || undefined,
        effort: entry.effort,
      };
    });
  } catch {
    return [];
  }
}

function normalizeCreateTeamMemberRuntimePreferences(
  members: readonly {
    name: string;
    providerId?: TeamProviderId;
    model?: string;
    effort?: EffortLevel;
    removedAt?: number | string | null;
  }[]
): CreateTeamMemberRuntimePreference[] {
  const normalizedMembers: CreateTeamMemberRuntimePreference[] = [];
  const seenNames = new Set<string>();

  for (const member of members) {
    if (member.removedAt) {
      continue;
    }

    const name = member.name.trim();
    const normalizedName = name.toLowerCase();
    if (!name || seenNames.has(normalizedName)) {
      continue;
    }
    seenNames.add(normalizedName);

    const providerId = normalizeOptionalTeamProviderId(member.providerId);
    const model = normalizeExplicitTeamModelForUi(providerId, member.model ?? '');
    normalizedMembers.push({
      name,
      providerId,
      model: model || undefined,
      effort: isTeamEffortLevel(member.effort) ? member.effort : undefined,
    });
  }

  return normalizedMembers;
}

function getCreateTeamModelKey(providerId: TeamProviderId): string {
  return `${CREATE_TEAM_PREFIX}lastSelectedModel:${providerId}`;
}

function getLegacyTeamModelKey(providerId: TeamProviderId): string {
  return `${LEGACY_TEAM_PREFIX}lastSelectedModel:${providerId}`;
}

function copyLegacyPreferenceIfMissing(key: string, legacyKey: string): void {
  if (readStorageItem(key) != null) {
    return;
  }
  const legacyValue = readStorageItem(legacyKey);
  if (legacyValue != null) {
    writeStorageItem(key, legacyValue);
  }
}

export function migrateLegacyCreateTeamPreferences(): void {
  copyLegacyPreferenceIfMissing(
    CREATE_TEAM_PROVIDER_KEY,
    `${LEGACY_TEAM_PREFIX}lastSelectedProvider`
  );
  copyLegacyPreferenceIfMissing(
    CREATE_TEAM_FAST_MODE_KEY,
    `${LEGACY_TEAM_PREFIX}lastSelectedFastMode`
  );
  copyLegacyPreferenceIfMissing(
    CREATE_TEAM_LIMIT_CONTEXT_KEY,
    `${LEGACY_TEAM_PREFIX}lastLimitContext`
  );
  copyLegacyPreferenceIfMissing(
    CREATE_TEAM_SKIP_PERMISSIONS_KEY,
    `${LEGACY_TEAM_PREFIX}lastSkipPermissions`
  );
  copyLegacyPreferenceIfMissing(CREATE_TEAM_EFFORT_KEY, `${LEGACY_TEAM_PREFIX}lastSelectedEffort`);

  for (const providerId of ['anthropic', 'codex', 'gemini', 'opencode'] as const) {
    copyLegacyPreferenceIfMissing(
      getCreateTeamModelKey(providerId),
      getLegacyTeamModelKey(providerId)
    );
  }

  const legacyTeamModel = readStorageItem(`${LEGACY_TEAM_PREFIX}lastSelectedModel`);
  if (legacyTeamModel != null && readStorageItem(getCreateTeamModelKey('anthropic')) == null) {
    writeStorageItem(getCreateTeamModelKey('anthropic'), legacyTeamModel);
  }
  removeStorageItem(`${LEGACY_TEAM_PREFIX}lastSelectedModel`);
}

export function getStoredCreateTeamProvider(): TeamProviderId {
  const stored = readCreateTeamPreference(
    CREATE_TEAM_PROVIDER_KEY,
    `${LEGACY_TEAM_PREFIX}lastSelectedProvider`
  );
  return normalizeCreateLaunchProviderForUi(normalizeOptionalTeamProviderId(stored), true);
}

export function setStoredCreateTeamProvider(providerId: TeamProviderId): void {
  writeStorageItem(CREATE_TEAM_PROVIDER_KEY, providerId);
}

export function getStoredCreateTeamModel(providerId: TeamProviderId): string {
  const stored = readCreateTeamPreference(
    getCreateTeamModelKey(providerId),
    getLegacyTeamModelKey(providerId)
  );
  if (stored === null) {
    return providerId === 'anthropic' ? 'opus' : '';
  }
  return normalizeExplicitTeamModelForUi(providerId, stored === '__default__' ? '' : stored);
}

export function setStoredCreateTeamModel(providerId: TeamProviderId, model: string): void {
  writeStorageItem(getCreateTeamModelKey(providerId), model);
}

export function getStoredCreateTeamFastMode(): TeamFastMode {
  const stored = readCreateTeamPreference(
    CREATE_TEAM_FAST_MODE_KEY,
    `${LEGACY_TEAM_PREFIX}lastSelectedFastMode`
  );
  return stored === 'on' || stored === 'off' || stored === 'inherit' ? stored : 'inherit';
}

export function setStoredCreateTeamFastMode(value: TeamFastMode): void {
  writeStorageItem(CREATE_TEAM_FAST_MODE_KEY, value);
}

export function getStoredCreateTeamLimitContext(): boolean {
  return (
    readCreateTeamPreference(
      CREATE_TEAM_LIMIT_CONTEXT_KEY,
      `${LEGACY_TEAM_PREFIX}lastLimitContext`
    ) === 'true'
  );
}

export function setStoredCreateTeamLimitContext(value: boolean): void {
  writeStorageItem(CREATE_TEAM_LIMIT_CONTEXT_KEY, String(value));
}

export function getStoredCreateTeamSkipPermissions(): boolean {
  return (
    readCreateTeamPreference(
      CREATE_TEAM_SKIP_PERMISSIONS_KEY,
      `${LEGACY_TEAM_PREFIX}lastSkipPermissions`
    ) !== 'false'
  );
}

export function setStoredCreateTeamSkipPermissions(value: boolean): void {
  writeStorageItem(CREATE_TEAM_SKIP_PERMISSIONS_KEY, String(value));
}

export function getStoredCreateTeamEffort(): string {
  return (
    readCreateTeamPreference(CREATE_TEAM_EFFORT_KEY, `${LEGACY_TEAM_PREFIX}lastSelectedEffort`) ??
    'medium'
  );
}

export function setStoredCreateTeamEffort(value: string): void {
  writeStorageItem(CREATE_TEAM_EFFORT_KEY, value);
}

export function getStoredCreateTeamSyncModelsWithLead(): boolean {
  return readStorageItem(CREATE_TEAM_SYNC_MODELS_KEY) !== 'false';
}

export function setStoredCreateTeamSyncModelsWithLead(value: boolean): void {
  writeStorageItem(CREATE_TEAM_SYNC_MODELS_KEY, String(value));
}

export function getStoredCreateTeamMemberRuntimePreferences(): CreateTeamMemberRuntimePreference[] {
  return parseStoredCreateTeamMemberRuntimePreferences(
    readStorageItem(CREATE_TEAM_MEMBER_RUNTIME_PREFERENCES_KEY)
  );
}

export function setStoredCreateTeamMemberRuntimePreferences(
  members: readonly {
    name: string;
    providerId?: TeamProviderId;
    model?: string;
    effort?: EffortLevel;
    removedAt?: number | string | null;
  }[]
): void {
  const existingMembers = getStoredCreateTeamMemberRuntimePreferences();
  const nextMembers = normalizeCreateTeamMemberRuntimePreferences(members);
  const mergedMembers = [...existingMembers];
  const mergedIndexByName = new Map(
    mergedMembers.map((member, index) => [member.name.trim().toLowerCase(), index] as const)
  );

  for (const member of nextMembers) {
    const normalizedName = member.name.trim().toLowerCase();
    const existingIndex = mergedIndexByName.get(normalizedName);
    if (existingIndex == null) {
      mergedIndexByName.set(normalizedName, mergedMembers.length);
      mergedMembers.push(member);
      continue;
    }
    mergedMembers[existingIndex] = member;
  }

  writeStorageItem(
    CREATE_TEAM_MEMBER_RUNTIME_PREFERENCES_KEY,
    JSON.stringify({
      version: CREATE_TEAM_MEMBER_RUNTIME_PREFERENCES_VERSION,
      members: mergedMembers,
    } satisfies StoredCreateTeamMemberRuntimePreferences)
  );
}

export function applyStoredCreateTeamMemberRuntimePreferences<
  T extends {
    name: string;
    providerId?: TeamProviderId;
    model?: string;
    effort?: EffortLevel;
    removedAt?: number | string | null;
  },
>(members: readonly T[]): T[] {
  const storedPreferences = getStoredCreateTeamMemberRuntimePreferences();
  if (storedPreferences.length === 0) {
    return [...members];
  }

  const preferenceByName = new Map(
    storedPreferences
      .map((entry) => [entry.name.trim().toLowerCase(), entry] as const)
      .filter(([name]) => name.length > 0)
  );

  return members.map((member) => {
    if (member.removedAt) {
      return member;
    }

    const preference = preferenceByName.get(member.name.trim().toLowerCase());
    if (!preference) {
      return member;
    }

    return {
      ...member,
      providerId: preference.providerId,
      model: preference.model ?? '',
      effort: preference.effort,
    };
  });
}
