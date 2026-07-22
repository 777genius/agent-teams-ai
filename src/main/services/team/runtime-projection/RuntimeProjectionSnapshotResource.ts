import { projectRuntimeResource } from './RuntimeProjectionResource';

import type {
  RuntimeProjectionEvidenceSource,
  RuntimeProjectionResourceUsageEvidence,
} from './RuntimeProjectionEvidence';
import type {
  TeamAgentRuntimeEntry,
  TeamAgentRuntimePidSource,
  TeamAgentRuntimeResourceSample,
} from '@shared/types';

export type RuntimeProjectionSnapshotResourceFields = Pick<
  TeamAgentRuntimeEntry,
  | 'rssBytes'
  | 'cpuPercent'
  | 'primaryRssBytes'
  | 'primaryCpuPercent'
  | 'childRssBytes'
  | 'childCpuPercent'
  | 'processCount'
  | 'runtimeLoadScope'
  | 'runtimeLoadTruncated'
  | 'resourceHistory'
>;

export interface RuntimeProjectionSnapshotResourceFieldInput {
  source: RuntimeProjectionEvidenceSource;
  pid?: number;
  runtimePid?: number;
  pidSource?: TeamAgentRuntimePidSource;
  usageStats?: RuntimeProjectionResourceUsageEvidence;
  resourceHistory?: TeamAgentRuntimeResourceSample[];
}

export function projectRuntimeSnapshotResourceFields(
  input: RuntimeProjectionSnapshotResourceFieldInput
): RuntimeProjectionSnapshotResourceFields {
  return projectRuntimeResource({
    source: input.source,
    pid: input.pid,
    runtimePid: input.runtimePid,
    pidSource: input.pidSource,
    // Persisted and shared runtime hosts can expose resource metrics even when liveness is weak.
    usage: input.usageStats,
    history: input.resourceHistory,
  });
}
