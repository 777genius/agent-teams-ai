import { validateMemberName, validateTeamName } from '@main/ipc/guards';
import { isReservedLeadRole } from '@shared/utils/leadDetection';

import { TEAM_GET_MEMBER_SETTINGS_TARGET, TEAM_UPDATE_MEMBER_SETTINGS } from '../../../contracts';

import type {
  EditableMemberSettings,
  GetMemberSettingsTargetRequest,
  MemberSettingsMcpPolicy,
  MemberSettingsTarget,
  UpdateMemberSettingsRequest,
  UpdateMemberSettingsResult,
} from '../../../contracts/memberSettings';
import type { TeamMemberSettingsFeatureApi } from '../../composition/createTeamMemberSettingsFeature';
import type { IpcResult } from '@shared/types';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

const SETTINGS_KEYS = [
  'role',
  'workflow',
  'isolation',
  'providerId',
  'providerBackendId',
  'model',
  'effort',
  'fastMode',
  'mcpPolicy',
] as const;
const MAX_ID_LENGTH = 256;
const MAX_NAME_LENGTH = 128;
const MAX_TEXT_LENGTH = 16_384;
const MAX_FINGERPRINT_LENGTH = 65_536;
const MAX_RELAUNCH_BASELINE_LENGTH = 256 * 1024;
const MAX_MCP_SERVERS = 100;
const MAX_MCP_SERVER_NAME_LENGTH = 128;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${field} must not be empty`);
  if (normalized.length > maxLength) throw new TypeError(`${field} is too long`);
  return normalized;
}

function nullableText(value: unknown, field: string): string | null {
  if (value === null) return null;
  return requiredString(value, field, MAX_TEXT_LENGTH);
}

function validatedIdentifier(
  value: unknown,
  field: 'teamName' | 'memberName',
  validate: typeof validateTeamName | typeof validateMemberName
): string {
  const raw = requiredString(value, field, MAX_NAME_LENGTH);
  const result = validate(raw);
  if (!result.valid || !result.value) {
    throw new TypeError(result.error ?? `${field} is invalid`);
  }
  return result.value;
}

function nullableUnion<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[]
): T | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new TypeError(`${field} has an unsupported value`);
  }
  return value as T;
}

function parseMcpPolicy(value: unknown): MemberSettingsMcpPolicy | null {
  if (value === null) return null;
  if (!isPlainObject(value)) throw new TypeError('settings.mcpPolicy must be an object or null');
  const unknownPolicyKey = Object.keys(value).find(
    (key) => key !== 'mode' && key !== 'scopes' && key !== 'serverNames'
  );
  if (unknownPolicyKey) throw new TypeError(`Unsupported MCP policy field: ${unknownPolicyKey}`);
  const mode = nullableUnion(value.mode, 'settings.mcpPolicy.mode', [
    'inheritLead',
    'inheritScopes',
    'strictAllowlist',
    'appOnly',
  ] as const);
  if (!mode) throw new TypeError('settings.mcpPolicy.mode is required');

  let scopes: MemberSettingsMcpPolicy['scopes'];
  if (value.scopes !== undefined) {
    if (!isPlainObject(value.scopes)) {
      throw new TypeError('settings.mcpPolicy.scopes must be an object');
    }
    const unknownScope = Object.keys(value.scopes).find(
      (key) => key !== 'user' && key !== 'project' && key !== 'local'
    );
    if (unknownScope) throw new TypeError(`Unsupported MCP scope: ${unknownScope}`);
    for (const [key, enabled] of Object.entries(value.scopes)) {
      if (typeof enabled !== 'boolean') {
        throw new TypeError(`settings.mcpPolicy.scopes.${key} must be boolean`);
      }
    }
    scopes = { ...value.scopes };
  }

  let serverNames: string[] | undefined;
  if (value.serverNames !== undefined) {
    if (!Array.isArray(value.serverNames) || value.serverNames.length > MAX_MCP_SERVERS) {
      throw new TypeError('settings.mcpPolicy.serverNames must be a bounded array');
    }
    const seen = new Set<string>();
    serverNames = value.serverNames
      .map((name, index) =>
        requiredString(name, `settings.mcpPolicy.serverNames[${index}]`, MAX_MCP_SERVER_NAME_LENGTH)
      )
      .filter((name) => {
        const key = name.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort();
  }
  return { mode, ...(scopes ? { scopes } : {}), ...(serverNames ? { serverNames } : {}) };
}

function parseSettings(value: unknown): EditableMemberSettings {
  if (!isPlainObject(value)) throw new TypeError('settings must be an object');
  for (const key of SETTINGS_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new TypeError(`settings.${key} is required; use null to clear it`);
    }
  }
  const unknownKey = Object.keys(value).find(
    (key) => !SETTINGS_KEYS.includes(key as (typeof SETTINGS_KEYS)[number])
  );
  if (unknownKey) throw new TypeError(`Unsupported settings field: ${unknownKey}`);

  const role = nullableText(value.role, 'settings.role');
  if (role && isReservedLeadRole(role)) {
    throw new TypeError('settings.role is reserved for the team lead');
  }

  return {
    role,
    workflow: nullableText(value.workflow, 'settings.workflow'),
    isolation: nullableUnion(value.isolation, 'settings.isolation', ['worktree'] as const),
    providerId: nullableUnion(value.providerId, 'settings.providerId', [
      'anthropic',
      'codex',
      'gemini',
      'opencode',
    ] as const),
    providerBackendId: nullableUnion(value.providerBackendId, 'settings.providerBackendId', [
      'auto',
      'adapter',
      'api',
      'cli-sdk',
      'codex-native',
      'opencode-cli',
    ] as const),
    model: nullableText(value.model, 'settings.model'),
    effort: nullableUnion(value.effort, 'settings.effort', [
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ] as const),
    fastMode: nullableUnion(value.fastMode, 'settings.fastMode', ['inherit', 'on', 'off'] as const),
    mcpPolicy: parseMcpPolicy(value.mcpPolicy),
  };
}

function parseRelaunchGuard(value: unknown): UpdateMemberSettingsRequest['relaunchGuard'] {
  if (value === undefined) return undefined;
  if (!isPlainObject(value) || !Array.isArray(value.baseline) || value.baseline.length > 128) {
    throw new TypeError('Invalid relaunch baseline');
  }
  const seen = new Set<string>();
  let totalLength = 0;
  const baseline = value.baseline.map((row) => {
    if (!isPlainObject(row)) throw new TypeError('Invalid relaunch baseline member');
    const memberName = validatedIdentifier(row.memberName, 'memberName', validateMemberName);
    const key = memberName.toLowerCase();
    if (seen.has(key)) throw new TypeError('Duplicate relaunch baseline member');
    seen.add(key);
    const expectedFingerprint = requiredString(
      row.expectedFingerprint,
      'expectedFingerprint',
      MAX_FINGERPRINT_LENGTH
    );
    totalLength += memberName.length + expectedFingerprint.length;
    if (totalLength > MAX_RELAUNCH_BASELINE_LENGTH)
      throw new TypeError('Relaunch baseline is too large');
    return { memberName, expectedFingerprint };
  });
  return {
    expectedTeamSettingsFingerprint: requiredString(
      value.expectedTeamSettingsFingerprint,
      'expectedTeamSettingsFingerprint',
      MAX_FINGERPRINT_LENGTH
    ),
    baseline,
  };
}

export function parseUpdateMemberSettingsRequest(value: unknown): UpdateMemberSettingsRequest {
  if (!isPlainObject(value)) throw new TypeError('request must be a plain object');
  const base = {
    commandId: requiredString(value.commandId, 'commandId', MAX_ID_LENGTH),
    idempotencyKey: requiredString(value.idempotencyKey, 'idempotencyKey', MAX_ID_LENGTH),
    teamName: validatedIdentifier(value.teamName, 'teamName', validateTeamName),
    memberName: validatedIdentifier(value.memberName, 'memberName', validateMemberName),
    ...(value.relaunchGuard === undefined
      ? {}
      : { relaunchGuard: parseRelaunchGuard(value.relaunchGuard) }),
    expectedFingerprint: requiredString(
      value.expectedFingerprint,
      'expectedFingerprint',
      MAX_FINGERPRINT_LENGTH
    ),
  };
  const targetKind = requiredString(value.targetKind, 'targetKind', 16);
  if (targetKind === 'lead') {
    if (!isPlainObject(value.leadRuntime)) {
      throw new TypeError('leadRuntime must be an object');
    }
    const unknownKey = Object.keys(value.leadRuntime).find(
      (key) => key !== 'model' && key !== 'effort'
    );
    if (unknownKey) throw new TypeError(`Unsupported lead runtime field: ${unknownKey}`);
    return {
      ...base,
      targetKind,
      leadRuntime: {
        model: nullableText(value.leadRuntime.model, 'leadRuntime.model'),
        effort: nullableUnion(value.leadRuntime.effort, 'leadRuntime.effort', [
          'none',
          'minimal',
          'low',
          'medium',
          'high',
          'xhigh',
          'max',
          'ultra',
        ] as const),
      },
    };
  }
  if (targetKind !== 'member') throw new TypeError('targetKind must be member or lead');
  return { ...base, targetKind, settings: parseSettings(value.settings) };
}

export function parseGetMemberSettingsTargetRequest(
  value: unknown
): GetMemberSettingsTargetRequest {
  if (!isPlainObject(value)) throw new TypeError('request must be a plain object');
  return {
    teamName: validatedIdentifier(value.teamName, 'teamName', validateTeamName),
    memberName: validatedIdentifier(value.memberName, 'memberName', validateMemberName),
  };
}

export function registerTeamMemberSettingsIpc(
  ipcMain: IpcMain,
  feature: TeamMemberSettingsFeatureApi
): void {
  ipcMain.handle(
    TEAM_UPDATE_MEMBER_SETTINGS,
    async (
      _event: IpcMainInvokeEvent,
      value: unknown
    ): Promise<IpcResult<UpdateMemberSettingsResult>> => {
      try {
        const data = await feature.updateMemberSettings(parseUpdateMemberSettingsRequest(value));
        return { success: true, data };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
  );
  ipcMain.handle(
    TEAM_GET_MEMBER_SETTINGS_TARGET,
    async (
      _event: IpcMainInvokeEvent,
      value: unknown
    ): Promise<IpcResult<MemberSettingsTarget | null>> => {
      try {
        const data = await feature.getMemberSettingsTarget(
          parseGetMemberSettingsTargetRequest(value)
        );
        return { success: true, data };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
  );
}

export function removeTeamMemberSettingsIpc(ipcMain: IpcMain): void {
  ipcMain.removeHandler(TEAM_UPDATE_MEMBER_SETTINGS);
  ipcMain.removeHandler(TEAM_GET_MEMBER_SETTINGS_TARGET);
}
