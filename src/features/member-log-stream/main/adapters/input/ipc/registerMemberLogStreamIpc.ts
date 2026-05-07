import { validateMemberName, validateTeamName } from '@main/ipc/guards';
import { createLogger } from '@shared/utils/logger';

import {
  MEMBER_LOG_STREAM_GET,
  MEMBER_LOG_STREAM_GET_PREVIEWS,
  MEMBER_LOG_STREAM_SET_TRACKING,
  normalizeMemberLogPreviewResponse,
  normalizeMemberLogStreamResponse,
} from '../../../../contracts';

import type {
  MemberLogPreviewRequestOptions,
  MemberLogPreviewResponse,
  MemberLogStreamRequestOptions,
  MemberLogStreamResponse,
} from '../../../../contracts';
import type { MemberLogStreamFeatureFacade } from '../../../composition/createMemberLogStreamFeature';
import type { IpcResult } from '@shared/types';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

const logger = createLogger('Feature:MemberLogStream:IPC');
const ALLOWED_OPTION_KEYS = new Set(['limitSegments', 'since', 'laneId', 'forceRefresh']);
const ALLOWED_PREVIEW_OPTION_KEYS = new Set([
  'maxItemsPerMember',
  'textLimit',
  'laneIdsByMember',
  'forceRefresh',
]);

interface ValidationResult<T> {
  valid: boolean;
  value?: T;
  error?: string;
}

function validateOptionalRuntimeLaneId(value: unknown): ValidationResult<string | undefined> {
  if (value == null) return { valid: true, value: undefined };
  if (typeof value !== 'string') return { valid: false, error: 'laneId must be a string' };
  const trimmed = value.trim();
  if (!trimmed) return { valid: true, value: undefined };
  if (trimmed.length > 256) return { valid: false, error: 'laneId exceeds max length (256)' };
  if (
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    [...trimmed].some((char) => {
      const code = char.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    return { valid: false, error: 'laneId contains invalid characters' };
  }
  return { valid: true, value: trimmed };
}

function normalizeOptions(options: unknown): ValidationResult<{
  limitSegments?: number;
  sinceMs?: number | null;
  laneId?: string;
  forceRefresh?: boolean;
}> {
  if (options == null) {
    return { valid: true, value: {} };
  }
  if (typeof options !== 'object' || Array.isArray(options)) {
    return { valid: false, error: 'options must be an object' };
  }

  const record = options as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_OPTION_KEYS.has(key)) {
      return { valid: false, error: `Unknown getMemberLogStream option: ${key}` };
    }
  }

  let limitSegments: number | undefined;
  if (record.limitSegments != null) {
    if (typeof record.limitSegments !== 'number' || !Number.isFinite(record.limitSegments)) {
      return { valid: false, error: 'limitSegments must be a finite number' };
    }
    limitSegments = Math.max(1, Math.min(80, Math.floor(record.limitSegments)));
  }

  let sinceMs: number | null | undefined;
  if (record.since != null) {
    if (typeof record.since !== 'string') {
      return { valid: false, error: 'since must be an ISO timestamp string' };
    }
    const parsed = Date.parse(record.since);
    if (!Number.isFinite(parsed)) {
      return { valid: false, error: 'since must be a valid timestamp' };
    }
    sinceMs = parsed;
  }

  const lane = validateOptionalRuntimeLaneId(record.laneId);
  if (!lane.valid) {
    return { valid: false, error: lane.error };
  }

  let forceRefresh: boolean | undefined;
  if (record.forceRefresh != null) {
    if (typeof record.forceRefresh !== 'boolean') {
      return { valid: false, error: 'forceRefresh must be a boolean' };
    }
    forceRefresh = record.forceRefresh;
  }

  return {
    valid: true,
    value: {
      ...(limitSegments !== undefined ? { limitSegments } : {}),
      ...(sinceMs !== undefined ? { sinceMs } : {}),
      ...(lane.value !== undefined ? { laneId: lane.value } : {}),
      ...(forceRefresh !== undefined ? { forceRefresh } : {}),
    },
  };
}

function validateMemberNames(value: unknown): ValidationResult<string[]> {
  if (!Array.isArray(value)) {
    return { valid: false, error: 'memberNames must be an array' };
  }
  if (value.length > 80) {
    return { valid: false, error: 'memberNames exceeds max length (80)' };
  }
  const memberNames: string[] = [];
  for (const item of value) {
    const vMember = validateMemberName(item);
    if (!vMember.valid) {
      return { valid: false, error: vMember.error ?? 'Invalid memberName' };
    }
    memberNames.push(vMember.value!);
  }
  return { valid: true, value: memberNames };
}

function normalizePreviewOptions(options: unknown): ValidationResult<{
  maxItemsPerMember?: number;
  textLimit?: number;
  laneIdsByMember?: Record<string, string>;
  forceRefresh?: boolean;
}> {
  if (options == null) {
    return { valid: true, value: {} };
  }
  if (typeof options !== 'object' || Array.isArray(options)) {
    return { valid: false, error: 'options must be an object' };
  }

  const record = options as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_PREVIEW_OPTION_KEYS.has(key)) {
      return { valid: false, error: `Unknown getMemberLogPreviews option: ${key}` };
    }
  }

  let maxItemsPerMember: number | undefined;
  if (record.maxItemsPerMember != null) {
    if (
      typeof record.maxItemsPerMember !== 'number' ||
      !Number.isFinite(record.maxItemsPerMember)
    ) {
      return { valid: false, error: 'maxItemsPerMember must be a finite number' };
    }
    maxItemsPerMember = Math.max(1, Math.min(3, Math.floor(record.maxItemsPerMember)));
  }

  let textLimit: number | undefined;
  if (record.textLimit != null) {
    if (typeof record.textLimit !== 'number' || !Number.isFinite(record.textLimit)) {
      return { valid: false, error: 'textLimit must be a finite number' };
    }
    textLimit = Math.max(80, Math.min(240, Math.floor(record.textLimit)));
  }

  let laneIdsByMember: Record<string, string> | undefined;
  if (record.laneIdsByMember != null) {
    if (typeof record.laneIdsByMember !== 'object' || Array.isArray(record.laneIdsByMember)) {
      return { valid: false, error: 'laneIdsByMember must be an object' };
    }
    laneIdsByMember = {};
    for (const [memberName, laneId] of Object.entries(
      record.laneIdsByMember as Record<string, unknown>
    )) {
      const vMember = validateMemberName(memberName);
      if (!vMember.valid) {
        return { valid: false, error: vMember.error ?? 'Invalid laneIdsByMember key' };
      }
      const vLane = validateOptionalRuntimeLaneId(laneId);
      if (!vLane.valid) {
        return { valid: false, error: vLane.error ?? 'Invalid laneId' };
      }
      if (vLane.value) {
        laneIdsByMember[vMember.value!] = vLane.value;
        laneIdsByMember[vMember.value!.toLowerCase()] = vLane.value;
      }
    }
  }

  let forceRefresh: boolean | undefined;
  if (record.forceRefresh != null) {
    if (typeof record.forceRefresh !== 'boolean') {
      return { valid: false, error: 'forceRefresh must be a boolean' };
    }
    forceRefresh = record.forceRefresh;
  }

  return {
    valid: true,
    value: {
      ...(maxItemsPerMember !== undefined ? { maxItemsPerMember } : {}),
      ...(textLimit !== undefined ? { textLimit } : {}),
      ...(laneIdsByMember !== undefined ? { laneIdsByMember } : {}),
      ...(forceRefresh !== undefined ? { forceRefresh } : {}),
    },
  };
}

export function registerMemberLogStreamIpc(
  ipcMain: IpcMain,
  feature: MemberLogStreamFeatureFacade
): void {
  ipcMain.handle(
    MEMBER_LOG_STREAM_GET,
    async (
      _event: IpcMainInvokeEvent,
      teamName: unknown,
      memberName: unknown,
      options?: MemberLogStreamRequestOptions
    ): Promise<IpcResult<MemberLogStreamResponse>> => {
      const vTeam = validateTeamName(teamName);
      if (!vTeam.valid) {
        return { success: false, error: vTeam.error ?? 'Invalid teamName' };
      }
      const vMember = validateMemberName(memberName);
      if (!vMember.valid) {
        return { success: false, error: vMember.error ?? 'Invalid memberName' };
      }
      const vOptions = normalizeOptions(options);
      if (!vOptions.valid) {
        return { success: false, error: vOptions.error ?? 'Invalid options' };
      }

      try {
        const response = await feature.getMemberLogStream({
          teamName: vTeam.value!,
          memberName: vMember.value!,
          ...vOptions.value!,
        });
        return { success: true, data: normalizeMemberLogStreamResponse(response) };
      } catch (error) {
        logger.error('Failed to load member log stream', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to load member log stream',
        };
      }
    }
  );

  ipcMain.handle(
    MEMBER_LOG_STREAM_SET_TRACKING,
    async (
      _event: IpcMainInvokeEvent,
      teamName: unknown,
      enabled: unknown
    ): Promise<IpcResult<void>> => {
      const vTeam = validateTeamName(teamName);
      if (!vTeam.valid) {
        return { success: false, error: vTeam.error ?? 'Invalid teamName' };
      }
      if (typeof enabled !== 'boolean') {
        return { success: false, error: 'enabled must be a boolean' };
      }
      try {
        await feature.setMemberLogStreamTracking(vTeam.value!, enabled);
        return { success: true };
      } catch (error) {
        logger.error('Failed to update member log stream tracking', error);
        return {
          success: false,
          error:
            error instanceof Error ? error.message : 'Failed to update member log stream tracking',
        };
      }
    }
  );

  ipcMain.handle(
    MEMBER_LOG_STREAM_GET_PREVIEWS,
    async (
      _event: IpcMainInvokeEvent,
      teamName: unknown,
      memberNames: unknown,
      options?: MemberLogPreviewRequestOptions
    ): Promise<IpcResult<MemberLogPreviewResponse>> => {
      const vTeam = validateTeamName(teamName);
      if (!vTeam.valid) {
        return { success: false, error: vTeam.error ?? 'Invalid teamName' };
      }
      const vMembers = validateMemberNames(memberNames);
      if (!vMembers.valid) {
        return { success: false, error: vMembers.error ?? 'Invalid memberNames' };
      }
      const vOptions = normalizePreviewOptions(options);
      if (!vOptions.valid) {
        return { success: false, error: vOptions.error ?? 'Invalid options' };
      }

      try {
        const response = await feature.getMemberLogPreviews({
          teamName: vTeam.value!,
          memberNames: vMembers.value!,
          ...vOptions.value!,
        });
        return { success: true, data: normalizeMemberLogPreviewResponse(response) };
      } catch (error) {
        logger.error('Failed to load member log previews', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to load member log previews',
        };
      }
    }
  );
}

export function removeMemberLogStreamIpc(ipcMain: IpcMain): void {
  ipcMain.removeHandler(MEMBER_LOG_STREAM_GET);
  ipcMain.removeHandler(MEMBER_LOG_STREAM_GET_PREVIEWS);
  ipcMain.removeHandler(MEMBER_LOG_STREAM_SET_TRACKING);
}
