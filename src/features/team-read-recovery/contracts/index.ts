import type { IpcResult } from '@shared/types/ipc';
import type {
  MemberLogSummary,
  MessagesPage,
  TeamGetDataOptions,
  TeamMemberActivityMeta,
  TeamViewSnapshot,
} from '@shared/types/team';

export type TeamReadFailureMetadata =
  | { kind: 'recovering'; retryAt: number; recoveryId: string }
  | { kind: 'busy' | 'fatal' | 'operation' | 'disposed' };

export interface TeamReadLegacyApi {
  getData(teamName: string, options?: TeamGetDataOptions): Promise<TeamViewSnapshot>;
  getMessagesPage(
    teamName: string,
    options?: { cursor?: string | null; limit?: number }
  ): Promise<MessagesPage>;
  getMemberActivityMeta(teamName: string): Promise<TeamMemberActivityMeta>;
  getLogsForTask(
    teamName: string,
    taskId: string,
    options?: {
      owner?: string;
      status?: string;
      intervals?: { startedAt: string; completedAt?: string }[];
      since?: string;
    }
  ): Promise<MemberLogSummary[]>;
}

export type TeamReadRecoveryApi = {
  [K in keyof TeamReadLegacyApi]: (
    ...args: Parameters<TeamReadLegacyApi[K]>
  ) => Promise<IpcResult<Awaited<ReturnType<TeamReadLegacyApi[K]>>>>;
};
