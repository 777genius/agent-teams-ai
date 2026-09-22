import { DEFAULT_TOOL_APPROVAL_SETTINGS } from '@shared/types/team';

import type { ToolApprovalSettings } from '@shared/types';

const TOOL_APPROVAL_SETTINGS_PREFIX = 'team:toolApprovalSettings:';
const LEGACY_TOOL_APPROVAL_SETTINGS_KEY = 'team:toolApprovalSettings';

interface ToolApprovalSettingsProjectionState {
  selectedTeamName: string | null;
  toolApprovalSettingsByTeam: Record<string, ToolApprovalSettings>;
}

const VALID_TIMEOUT_ACTIONS: ReadonlySet<ToolApprovalSettings['timeoutAction']> = new Set([
  'allow',
  'deny',
  'wait',
]);

export function parseToolApprovalSettings(raw: string | null): ToolApprovalSettings {
  if (!raw) return DEFAULT_TOOL_APPROVAL_SETTINGS;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const d = DEFAULT_TOOL_APPROVAL_SETTINGS;
    return {
      autoAllowAll: typeof parsed.autoAllowAll === 'boolean' ? parsed.autoAllowAll : d.autoAllowAll,
      autoAllowFileEdits:
        typeof parsed.autoAllowFileEdits === 'boolean'
          ? parsed.autoAllowFileEdits
          : d.autoAllowFileEdits,
      autoAllowSafeBash:
        typeof parsed.autoAllowSafeBash === 'boolean'
          ? parsed.autoAllowSafeBash
          : d.autoAllowSafeBash,
      timeoutAction:
        typeof parsed.timeoutAction === 'string' &&
        VALID_TIMEOUT_ACTIONS.has(parsed.timeoutAction as ToolApprovalSettings['timeoutAction'])
          ? (parsed.timeoutAction as ToolApprovalSettings['timeoutAction'])
          : d.timeoutAction,
      timeoutSeconds:
        typeof parsed.timeoutSeconds === 'number' &&
        Number.isFinite(parsed.timeoutSeconds) &&
        parsed.timeoutSeconds >= 5 &&
        parsed.timeoutSeconds <= 300
          ? parsed.timeoutSeconds
          : d.timeoutSeconds,
    };
  } catch {
    return DEFAULT_TOOL_APPROVAL_SETTINGS;
  }
}

export function loadToolApprovalSettingsForTeam(teamName: string): ToolApprovalSettings {
  try {
    return parseToolApprovalSettings(
      localStorage.getItem(`${TOOL_APPROVAL_SETTINGS_PREFIX}${teamName}`)
    );
  } catch {
    return DEFAULT_TOOL_APPROVAL_SETTINGS;
  }
}

export function loadAllToolApprovalSettingsByTeam(): Record<string, ToolApprovalSettings> {
  try {
    const settingsByTeam: Record<string, ToolApprovalSettings> = {};
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(TOOL_APPROVAL_SETTINGS_PREFIX)) {
        continue;
      }
      const teamName = key.slice(TOOL_APPROVAL_SETTINGS_PREFIX.length);
      if (teamName) {
        settingsByTeam[teamName] = parseToolApprovalSettings(localStorage.getItem(key));
      }
    }
    return settingsByTeam;
  } catch {
    return {};
  }
}

export function resolveToolApprovalSettingsForTeam(
  settingsByTeam: Readonly<Record<string, ToolApprovalSettings>>,
  selectedTeamSettings: ToolApprovalSettings,
  teamName?: string
): ToolApprovalSettings {
  return teamName
    ? (settingsByTeam[teamName] ?? loadToolApprovalSettingsForTeam(teamName))
    : selectedTeamSettings;
}

export function projectToolApprovalSettings(
  state: ToolApprovalSettingsProjectionState,
  teamName: string,
  settings: ToolApprovalSettings,
  selectTeam = false
) {
  return {
    toolApprovalSettingsByTeam: { ...state.toolApprovalSettingsByTeam, [teamName]: settings },
    ...(selectTeam || state.selectedTeamName === teamName
      ? { toolApprovalSettings: settings }
      : {}),
  };
}

export function saveToolApprovalSettingsForTeam(
  teamName: string,
  settings: ToolApprovalSettings
): void {
  try {
    localStorage.setItem(`${TOOL_APPROVAL_SETTINGS_PREFIX}${teamName}`, JSON.stringify(settings));
  } catch {
    // Best-effort renderer persistence. Main remains authoritative while the app is running.
  }
}

export function loadLegacyToolApprovalSettings(): ToolApprovalSettings {
  try {
    return parseToolApprovalSettings(localStorage.getItem(LEGACY_TOOL_APPROVAL_SETTINGS_KEY));
  } catch {
    return DEFAULT_TOOL_APPROVAL_SETTINGS;
  }
}

export function saveLegacyToolApprovalSettings(settings: ToolApprovalSettings): void {
  try {
    localStorage.setItem(LEGACY_TOOL_APPROVAL_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Best-effort legacy fallback for the no-team-selected state.
  }
}
