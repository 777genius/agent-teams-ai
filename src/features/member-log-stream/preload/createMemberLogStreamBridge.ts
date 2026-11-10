import { ipcRenderer } from 'electron';

import {
  MEMBER_LOG_STREAM_GET,
  MEMBER_LOG_STREAM_GET_PREVIEWS,
  MEMBER_LOG_STREAM_GET_RUNTIME_LOG_TAIL,
  MEMBER_LOG_STREAM_SET_TRACKING,
  normalizeMemberLogPreviewResponse,
  normalizeMemberLogStreamResponse,
  normalizeMemberRuntimeLogTailResponse,
} from '../contracts';

import type {
  MemberLogPreviewRequestOptions,
  MemberLogPreviewResponse,
  MemberLogStreamApi,
  MemberLogStreamRequestOptions,
  MemberLogStreamResponse,
  MemberRuntimeLogTailOptions,
  MemberRuntimeLogTailResponse,
} from '../contracts';
import type { IpcResult } from '@shared/types';

async function invokeIpcWithResult<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as IpcResult<T>;
  if (!result.success) {
    throw new Error(result.error ?? 'Unknown error');
  }
  return result.data as T;
}

export function createMemberLogStreamBridge(): MemberLogStreamApi {
  return {
    getMemberLogStream: async (
      teamName: string,
      memberName: string,
      options?: MemberLogStreamRequestOptions
    ): Promise<MemberLogStreamResponse> =>
      normalizeMemberLogStreamResponse(
        await invokeIpcWithResult<MemberLogStreamResponse>(
          MEMBER_LOG_STREAM_GET,
          teamName,
          memberName,
          options
        )
      ),
    getMemberLogPreviews: async (
      teamName: string,
      memberNames: string[],
      options?: MemberLogPreviewRequestOptions
    ): Promise<MemberLogPreviewResponse> =>
      normalizeMemberLogPreviewResponse(
        await invokeIpcWithResult<MemberLogPreviewResponse>(
          MEMBER_LOG_STREAM_GET_PREVIEWS,
          teamName,
          memberNames,
          options
        )
      ),
    getMemberRuntimeLogTail: async (
      teamName: string,
      memberName: string,
      options: MemberRuntimeLogTailOptions
    ): Promise<MemberRuntimeLogTailResponse> =>
      normalizeMemberRuntimeLogTailResponse(
        await invokeIpcWithResult<MemberRuntimeLogTailResponse>(
          MEMBER_LOG_STREAM_GET_RUNTIME_LOG_TAIL,
          teamName,
          memberName,
          options
        )
      ),
    setMemberLogStreamTracking: (teamName: string, enabled: boolean): Promise<void> =>
      invokeIpcWithResult<void>(MEMBER_LOG_STREAM_SET_TRACKING, teamName, enabled),
  };
}
