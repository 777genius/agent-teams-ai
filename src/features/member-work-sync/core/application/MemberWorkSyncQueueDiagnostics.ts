export type MemberWorkSyncTriggerReason =
  | 'startup_scan'
  | 'config_changed'
  | 'task_changed'
  | 'inbox_changed'
  | 'member_spawned'
  | 'tool_finished'
  | 'runtime_activity'
  | 'turn_settled'
  | 'proof_missing_recovery'
  | 'manual_refresh';

export interface MemberWorkSyncQueueDiagnostics {
  queued: number;
  running: number;
  enqueued: number;
  coalesced: number;
  reconciled: number;
  dropped: number;
  failed: number;
  nextRunAt?: string;
  oldestQueuedAgeMs?: number;
  oldestRunningAgeMs?: number;
  queuedItems: MemberWorkSyncQueuedItemDiagnostics[];
  runningItems: MemberWorkSyncRunningItemDiagnostics[];
}

export interface MemberWorkSyncQueuedItemDiagnostics {
  teamName: string;
  memberName: string;
  firstQueuedAt: string;
  lastQueuedAt: string;
  runAt: string;
  maxRunAt: string;
  triggerReasons: MemberWorkSyncTriggerReason[];
  triggerReasonCounts: Partial<Record<MemberWorkSyncTriggerReason, number>>;
}

export interface MemberWorkSyncRunningItemDiagnostics {
  teamName: string;
  memberName: string;
  startedAt: string;
  ageMs: number;
  rerunRequested: boolean;
  settlingAfterTimeout?: boolean;
  triggerReasons: MemberWorkSyncTriggerReason[];
}
