import type {
  MemberWorkSyncAgenda,
  MemberWorkSyncOutboxClaimInput,
  MemberWorkSyncOutboxCountRecentDeliveredInput,
  MemberWorkSyncOutboxEnsureInput,
  MemberWorkSyncOutboxEnsureResult,
  MemberWorkSyncOutboxItem,
  MemberWorkSyncOutboxMarkDeliveredInput,
  MemberWorkSyncOutboxMarkFailedInput,
  MemberWorkSyncOutboxMarkSupersededInput,
  MemberWorkSyncProviderId,
  MemberWorkSyncReport,
  MemberWorkSyncReportIntent,
  MemberWorkSyncReportIntentStatus,
  MemberWorkSyncReportRequest,
  MemberWorkSyncStatus,
  MemberWorkSyncTeamMetrics,
} from '../../contracts';

export interface MemberWorkSyncClockPort {
  now(): Date;
}

export interface MemberWorkSyncHashPort {
  sha256Hex(value: string): string;
}

export interface MemberWorkSyncReportTokenCreateInput {
  teamName: string;
  memberName: string;
  agendaFingerprint: string;
  issuedAt: string;
}

export interface MemberWorkSyncReportTokenVerifyInput {
  token?: string;
  teamName: string;
  memberName: string;
  agendaFingerprint: string;
  nowIso: string;
}

export type MemberWorkSyncReportTokenVerification =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'expired' | 'invalid' };

export interface MemberWorkSyncReportTokenPort {
  create(input: MemberWorkSyncReportTokenCreateInput): Promise<{
    token: string;
    expiresAt: string;
  }>;
  verify(
    input: MemberWorkSyncReportTokenVerifyInput
  ): Promise<MemberWorkSyncReportTokenVerification>;
}

export interface MemberWorkSyncLifecyclePort {
  isTeamActive(teamName: string): Promise<boolean> | boolean;
  isMemberActive?(input: { teamName: string; memberName: string }): Promise<boolean> | boolean;
}

export interface MemberWorkSyncLoggerPort {
  debug(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>): void;
}

export type MemberWorkSyncAuditEventName =
  | 'turn_settled_claimed'
  | 'turn_settled_resolved'
  | 'turn_settled_unresolved'
  | 'turn_settled_ignored'
  | 'queue_enqueued'
  | 'queue_coalesced'
  | 'queue_retry_scheduled'
  | 'queue_reconciled'
  | 'queue_dropped'
  | 'reconcile_started'
  | 'agenda_loaded'
  | 'decision_made'
  | 'status_written'
  | 'report_received'
  | 'report_accepted'
  | 'report_rejected'
  | 'nudge_planned'
  | 'nudge_delivered'
  | 'nudge_wake_failed'
  | 'nudge_skipped'
  | 'nudge_retryable'
  | 'nudge_superseded'
  | 'review_pickup_delivery_unavailable'
  | 'review_pickup_member_nudge_delivered'
  | 'review_pickup_escalated'
  | 'review_pickup_wake_failed_retryable'
  | 'watchdog_cooldown_active'
  | 'member_busy'
  | 'team_inactive'
  | 'index_repaired'
  | 'legacy_fallback_used'
  | 'proof_missing_recovery_scheduled'
  | 'proof_missing_recovery_coalesced'
  | 'proof_missing_recovery_suppressed'
  | 'proof_missing_recovery_conflict';

export interface MemberWorkSyncAuditEvent {
  timestamp: string;
  teamName: string;
  memberName: string;
  event: MemberWorkSyncAuditEventName;
  source: string;
  agendaFingerprint?: string;
  state?: string;
  actionableCount?: number;
  reason?: string;
  triggerReasons?: string[];
  providerId?: string;
  taskRefs?: { taskId: string; displayId?: string; teamName?: string }[];
  diagnostics?: string[];
  messagePreview?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface MemberWorkSyncAuditJournalPort {
  append(event: MemberWorkSyncAuditEvent): Promise<void>;
}

export interface MemberWorkSyncAgendaSourceResult {
  agenda: Omit<MemberWorkSyncAgenda, 'fingerprint'>;
  activeMemberNames: string[];
  inactive: boolean;
  providerId?: MemberWorkSyncProviderId;
  diagnostics: string[];
}

export interface MemberWorkSyncAgendaSourcePort {
  loadAgenda(input: {
    teamName: string;
    memberName: string;
  }): Promise<MemberWorkSyncAgendaSourceResult>;
}

export interface MemberWorkSyncStatusStorePort {
  read(input: { teamName: string; memberName: string }): Promise<MemberWorkSyncStatus | null>;
  write(status: MemberWorkSyncStatus): Promise<void>;
  readTeamMetrics?(teamName: string): Promise<MemberWorkSyncTeamMetrics>;
}

export interface MemberWorkSyncReportStorePort {
  appendPendingReport?(request: MemberWorkSyncReportRequest, reason: string): Promise<void>;
  listPendingReports?(teamName: string): Promise<MemberWorkSyncReportIntent[]>;
  markPendingReportProcessed?(
    teamName: string,
    id: string,
    result: { status: MemberWorkSyncReportIntentStatus; resultCode: string; processedAt: string }
  ): Promise<void>;
}

export interface MemberWorkSyncOutboxStorePort {
  ensurePending(input: MemberWorkSyncOutboxEnsureInput): Promise<MemberWorkSyncOutboxEnsureResult>;
  claimDue(input: MemberWorkSyncOutboxClaimInput): Promise<MemberWorkSyncOutboxItem[]>;
  markDelivered(input: MemberWorkSyncOutboxMarkDeliveredInput): Promise<void>;
  markSuperseded(input: MemberWorkSyncOutboxMarkSupersededInput): Promise<void>;
  markFailed(input: MemberWorkSyncOutboxMarkFailedInput): Promise<void>;
  countRecentDelivered(input: MemberWorkSyncOutboxCountRecentDeliveredInput): Promise<number>;
  findDeliveredReviewPickupRequestEventIds?(input: {
    teamName: string;
    memberName: string;
    reviewRequestEventIds: string[];
  }): Promise<string[]>;
  findRecentRecoveryByIntent?(input: {
    teamName: string;
    memberName: string;
    intentKey: string;
    sinceIso: string;
  }): Promise<{
    id: string;
    status: MemberWorkSyncOutboxItem['status'];
    deliveredMessageId?: string;
    payloadHash: string;
    updatedAt: string;
  } | null>;
}

export interface MemberWorkSyncInboxNudgePort {
  insertIfAbsent(input: {
    teamName: string;
    memberName: string;
    messageId: string;
    payloadHash: string;
    payload: MemberWorkSyncOutboxItem['payload'];
    timestamp: string;
  }): Promise<{ inserted: boolean; messageId: string; conflict?: boolean }>;
}

export interface MemberWorkSyncWatchdogCooldownPort {
  hasRecentNudge(input: {
    teamName: string;
    memberName: string;
    taskIds: string[];
    nowIso: string;
  }): Promise<boolean>;
  getRecentNudgeCooldown?(input: {
    teamName: string;
    memberName: string;
    taskIds: string[];
    nowIso: string;
  }): Promise<{ active: boolean; retryAfterIso?: string }>;
}

export interface MemberWorkSyncBusySignalPort {
  isBusy(input: {
    teamName: string;
    memberName: string;
    nowIso: string;
    workSyncIntent?: MemberWorkSyncOutboxItem['payload']['workSyncIntent'];
    workSyncIntentKey?: MemberWorkSyncOutboxItem['payload']['workSyncIntentKey'];
    taskRefs?: MemberWorkSyncOutboxItem['payload']['taskRefs'];
  }): Promise<{ busy: boolean; reason?: string; retryAfterIso?: string }>;
}

export interface MemberWorkSyncProofMissingRecoveryGuardPort {
  shouldDispatch(input: {
    teamName: string;
    memberName: string;
    intentKey: string;
    originalMessageId: string;
    taskIds: string[];
    nowIso: string;
  }): Promise<
    { ok: true } | { ok: false; reason: string; retryable: boolean; nextAttemptAt?: string }
  >;
}

export interface MemberWorkSyncNudgeDeliveryWakePort {
  schedule(input: {
    teamName: string;
    memberName: string;
    messageId: string;
    providerId?: MemberWorkSyncProviderId | null;
    reason: 'member_work_sync_nudge_inserted' | 'member_work_sync_nudge_existing';
    delayMs?: number;
  }): Promise<void> | void;
}

export type MemberWorkSyncReviewPickupDeliveryOutcome =
  | {
      ok: true;
      state: 'prompt_accepted' | 'response_proven';
      messageId: string;
      diagnostics?: string[];
    }
  | {
      ok: false;
      reason: 'capability_absent' | 'retryable_failure' | 'terminal_failure';
      message: string;
      diagnostics?: string[];
      retryAfterIso?: string;
    };

export interface MemberWorkSyncReviewPickupDeliveryPort {
  canDeliver(input: {
    teamName: string;
    memberName: string;
    providerId?: MemberWorkSyncProviderId | null;
  }):
    | Promise<{ ok: true } | { ok: false; reason: string; diagnostics?: string[] }>
    | {
        ok: true;
      }
    | { ok: false; reason: string; diagnostics?: string[] };
  deliver(input: {
    teamName: string;
    memberName: string;
    messageId: string;
    providerId?: MemberWorkSyncProviderId | null;
    payload: MemberWorkSyncOutboxItem['payload'];
    inserted: boolean;
    nowIso: string;
  }): Promise<MemberWorkSyncReviewPickupDeliveryOutcome>;
}

export interface MemberWorkSyncReviewPickupEscalationPort {
  escalate(input: {
    teamName: string;
    memberName: string;
    reason: string;
    nowIso: string;
    agendaFingerprint?: string;
    reviewRequestEventIds?: string[];
    diagnostics?: string[];
    taskRefs: { taskId: string; displayId?: string; teamName?: string }[];
  }): Promise<void> | void;
}

export interface MemberWorkSyncUseCaseDeps {
  clock: MemberWorkSyncClockPort;
  hash: MemberWorkSyncHashPort;
  agendaSource: MemberWorkSyncAgendaSourcePort;
  statusStore: MemberWorkSyncStatusStorePort;
  reportStore?: MemberWorkSyncReportStorePort;
  outboxStore?: MemberWorkSyncOutboxStorePort;
  inboxNudge?: MemberWorkSyncInboxNudgePort;
  watchdogCooldown?: MemberWorkSyncWatchdogCooldownPort;
  busySignal?: MemberWorkSyncBusySignalPort;
  proofMissingRecoveryGuard?: MemberWorkSyncProofMissingRecoveryGuardPort;
  nudgeDeliveryWake?: MemberWorkSyncNudgeDeliveryWakePort;
  reviewPickupDelivery?: MemberWorkSyncReviewPickupDeliveryPort;
  reviewPickupEscalation?: MemberWorkSyncReviewPickupEscalationPort;
  reportToken?: MemberWorkSyncReportTokenPort;
  auditJournal?: MemberWorkSyncAuditJournalPort;
  lifecycle?: MemberWorkSyncLifecyclePort;
  logger?: MemberWorkSyncLoggerPort;
}

export interface LatestAcceptedReportLookup {
  latestAcceptedReport?: MemberWorkSyncReport;
}
