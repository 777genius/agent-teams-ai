export interface TeamArtifactReconciliationTrigger {
  source: 'inbox' | 'task';
  detail?: string;
}

export interface TeamArtifactReconciliationResult {
  staleKanbanEntriesRemoved?: number;
  staleColumnOrderRefsRemoved?: number;
  linkedCommentsCreated?: number;
}

export interface TeamArtifactMaintenanceReconciliationRequest {
  reason: 'file-watch';
}

export interface TeamArtifactMaintenanceReconciliationPort {
  reconcileArtifacts(
    teamName: string,
    request: TeamArtifactMaintenanceReconciliationRequest
  ): unknown;
}

export interface TeamArtifactReconciliationMonotonicClockPort {
  nowMs(): number;
}

export interface TeamArtifactReconciliationWarningLoggerPort {
  warn(message: string): void;
}

export interface TeamArtifactReconciliationPorts {
  maintenance: TeamArtifactMaintenanceReconciliationPort;
  clock: TeamArtifactReconciliationMonotonicClockPort;
  logger: TeamArtifactReconciliationWarningLoggerPort;
}
