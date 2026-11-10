import type {
  TeamAgentRuntimeBackendType,
  TeamAgentRuntimeDiagnosticSeverity,
  TeamAgentRuntimeLoadScope,
  TeamAgentRuntimePidSource,
  TeamProviderId,
} from '@shared/types';

export type RuntimeProjectionEvidenceSource =
  | 'live-process'
  | 'runtime-adapter'
  | 'spawn-status'
  | 'persisted-launch'
  | 'persisted-runtime'
  | 'process-table'
  | 'tmux'
  | 'config';

export interface RuntimeProjectionDiagnosticEvidence {
  message?: string;
  severity?: TeamAgentRuntimeDiagnosticSeverity;
  diagnostics?: readonly string[];
}

export interface RuntimeProjectionProcessEvidence {
  pid?: number;
  metricsPid?: number;
  command?: string;
  running?: boolean;
  identityVerified?: boolean;
  pidSource?: TeamAgentRuntimePidSource;
  processTableAvailable?: boolean;
}

export interface RuntimeProjectionHeartbeatEvidence {
  bootstrapConfirmed?: boolean;
  lastHeartbeatAt?: string;
  lastSeenAt?: string;
  runtimeSessionId?: string;
  staleAfterMs?: number;
}

export interface RuntimeProjectionRegistrationEvidence {
  agentId?: string;
  backendType?: TeamAgentRuntimeBackendType;
  providerId?: TeamProviderId;
  tmuxPaneId?: string;
  runtimePid?: number;
  runtimeSessionId?: string;
}

export interface RuntimeProjectionPermissionEvidence {
  blocked?: boolean;
  pendingPermissionRequestIds?: readonly string[];
}

export interface RuntimeProjectionLivenessEvidence {
  source?: RuntimeProjectionEvidenceSource;
  process?: RuntimeProjectionProcessEvidence;
  heartbeat?: RuntimeProjectionHeartbeatEvidence;
  registration?: RuntimeProjectionRegistrationEvidence;
  permission?: RuntimeProjectionPermissionEvidence;
  diagnostic?: RuntimeProjectionDiagnosticEvidence;
}

export interface RuntimeProjectionResourceUsageEvidence {
  rssBytes?: number;
  cpuPercent?: number;
  primaryRssBytes?: number;
  primaryCpuPercent?: number;
  childRssBytes?: number;
  childCpuPercent?: number;
  processCount?: number;
  runtimeLoadScope?: TeamAgentRuntimeLoadScope;
  runtimeLoadTruncated?: boolean;
}

export interface RuntimeProjectionResourceSampleEvidence extends RuntimeProjectionResourceUsageEvidence {
  timestamp: string;
  pidSource?: TeamAgentRuntimePidSource;
  pid?: number;
  runtimePid?: number;
}

export interface RuntimeProjectionResourceEvidence {
  source?: RuntimeProjectionEvidenceSource;
  pid?: number;
  runtimePid?: number;
  pidSource?: TeamAgentRuntimePidSource;
  processAlive?: boolean;
  usage?: RuntimeProjectionResourceUsageEvidence;
  history?: readonly RuntimeProjectionResourceSampleEvidence[];
}
