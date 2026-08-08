import type {
  MemberLogPreviewRequestOptions,
  MemberLogPreviewResponse,
  MemberLogStreamRequestOptions,
  MemberLogStreamResponse,
} from '../../contracts';
import type { MemberLogSummary } from '@shared/types';

export interface MemberLogWorkInterval {
  startedAt: string;
  completedAt?: string;
}

export interface MemberLogTaskQuery {
  owner?: string;
  status?: string;
  intervals?: MemberLogWorkInterval[];
  since?: string;
}

export interface MemberLogStreamQuery {
  teamName: string;
  memberName: string;
  options?: MemberLogStreamRequestOptions;
}

export interface MemberLogObservationChange {
  teamName: string;
  type: string;
}

export type MemberLogObservationListener = (change: MemberLogObservationChange) => void;

export interface MemberLogObservationRendererPorts {
  readTaskLogs(
    teamName: string,
    taskId: string,
    query?: MemberLogTaskQuery
  ): Promise<MemberLogSummary[]>;
  readMemberLogs(teamName: string, memberName: string): Promise<MemberLogSummary[]>;
  readMemberLogPreviews(
    teamName: string,
    memberNames: string[],
    options?: MemberLogPreviewRequestOptions
  ): Promise<MemberLogPreviewResponse>;
  readMemberLogStream(query: MemberLogStreamQuery): Promise<MemberLogStreamResponse>;
  setStreamTracking(teamName: string, enabled: boolean): Promise<void>;
  subscribeToChanges(listener: MemberLogObservationListener): () => void;
}

let configuredPorts: MemberLogObservationRendererPorts | null = null;

export function configureMemberLogObservationRendererPorts(
  ports: MemberLogObservationRendererPorts
): void {
  configuredPorts = ports;
}

function getConfiguredPorts(): MemberLogObservationRendererPorts {
  if (!configuredPorts) {
    throw new Error('Member log observation renderer ports are not configured');
  }
  return configuredPorts;
}

export const memberLogObservationPorts: MemberLogObservationRendererPorts = {
  readTaskLogs: (teamName, taskId, query) =>
    getConfiguredPorts().readTaskLogs(teamName, taskId, query),
  readMemberLogs: (teamName, memberName) =>
    getConfiguredPorts().readMemberLogs(teamName, memberName),
  readMemberLogPreviews: (teamName, memberNames, options) =>
    getConfiguredPorts().readMemberLogPreviews(teamName, memberNames, options),
  readMemberLogStream: (query) => getConfiguredPorts().readMemberLogStream(query),
  setStreamTracking: (teamName, enabled) =>
    getConfiguredPorts().setStreamTracking(teamName, enabled),
  subscribeToChanges: (listener) => getConfiguredPorts().subscribeToChanges(listener),
};
