import type {
  MemberWorkSyncAgenda,
  MemberWorkSyncOutboxClaimInput,
  MemberWorkSyncOutboxCountDeliveredForAgendaInput,
  MemberWorkSyncOutboxCountRecentDeliveredInput,
  MemberWorkSyncOutboxEnsureInput,
  MemberWorkSyncOutboxEnsureResult,
  MemberWorkSyncOutboxItem,
  MemberWorkSyncOutboxMarkDeliveredInput,
  MemberWorkSyncOutboxMarkFailedInput,
  MemberWorkSyncOutboxMarkSupersededInput,
  MemberWorkSyncOutboxRecentDeliveredSummary,
  MemberWorkSyncProviderId,
  MemberWorkSyncReport,
  MemberWorkSyncReportIntent,
  MemberWorkSyncReportIntentStatus,
  MemberWorkSyncReportRequest,
  MemberWorkSyncStatus,
  MemberWorkSyncTeamMetrics,
} from '../../contracts/index.js';
import type { MemberWorkSyncConditionalStatusPort } from './MemberWorkSyncConditionalStatusPort.js';
import type { MemberWorkSyncReportJournalPort } from './MemberWorkSyncReportJournalPort.js';

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
  token?: string | undefined;
  teamName: string;
  memberName: string;
  agendaFingerprint: string;
  nowIso: string;
}

export interface MemberWorkSyncVerifiedReportTokenClaims {
  expiresAt: string;
  expiresAtMs: number;
}

export type MemberWorkSyncReportTokenVerification =
  | { ok: true; claims?: MemberWorkSyncVerifiedReportTokenClaims | undefined }
  | { ok: false; reason: 'expired'; claims?: MemberWorkSyncVerifiedReportTokenClaims | undefined }
  | { ok: false; reason: 'missing' | 'invalid' };

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
  | 'nudge_suppressed'
  | 'nudge_superseded'
  | 'review_pickup_delivery_unavailable'
  | 'review_pickup_member_nudge_delivered'
  | 'review_pickup_escalated'
  | 'review_pickup_wake_failed_retryable'
  | 'watchdog_cooldown_active'
  | 'member_busy'
  | 'runtime_stall_observed'
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
  agendaFingerprint?: string | undefined;
  state?: string | undefined;
  actionableCount?: number | undefined;
  reason?: string | undefined;
  triggerReasons?: string[] | undefined;
  providerId?: string | undefined;
  taskRefs?:
    | { taskId: string; displayId?: string | undefined; teamName?: string | undefined }[]
    | undefined;
  diagnostics?: string[] | undefined;
  messagePreview?: string | undefined;
  metadata?: Record<string, string | number | boolean | null> | undefined;
}

export interface MemberWorkSyncAuditJournalPort {
  append(event: MemberWorkSyncAuditEvent): Promise<void>;
}

export interface MemberWorkSyncAgendaSourceResult {
  agenda: Omit<MemberWorkSyncAgenda, 'fingerprint'>;
  activeMemberNames: string[];
  inactive: boolean;
  providerId?: MemberWorkSyncProviderId | undefined;
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
  countRecentDelivered(
    input: MemberWorkSyncOutboxCountRecentDeliveredInput
  ): Promise<MemberWorkSyncOutboxRecentDeliveredSummary>;
  countDeliveredForAgenda?(
    input: MemberWorkSyncOutboxCountDeliveredForAgendaInput
  ): Promise<number>;
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
    deliveredMessageId?: string | undefined;
    payloadHash: string;
    updatedAt: string;
  } | null>;
  readItem?(input: {
    teamName: string;
    memberName: string;
    id: string;
  }): Promise<MemberWorkSyncOutboxItem | null>;
}

export interface MemberWorkSyncInboxNudgePort {
  insertIfAbsent(input: {
    teamName: string;
    memberName: string;
    messageId: string;
    payloadHash: string;
    payload: MemberWorkSyncOutboxItem['payload'];
    timestamp: string;
    shouldAbort?: (() => boolean | Promise<boolean>) | undefined;
  }): Promise<{
    inserted: boolean;
    messageId: string;
    conflict?: boolean | undefined;
    aborted?: boolean | undefined;
  }>;
  repairIfPresent?(input: {
    teamName: string;
    memberName: string;
    messageId: string;
    payloadHash: string;
    payload: MemberWorkSyncOutboxItem['payload'];
  }): Promise<{ found: boolean; repaired: boolean; conflict?: boolean | undefined }>;
  invalidateDeliveredNudges?(input: {
    teamName: string;
    memberName: string;
    beforeControlRevision: number;
  }): Promise<{ invalidated: number; messageIds?: string[] | undefined }>;
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
  }): Promise<{ active: boolean; retryAfterIso?: string | undefined }>;
}

export interface MemberWorkSyncBusySignalPort {
  isBusy(input: {
    teamName: string;
    memberName: string;
    nowIso: string;
    workSyncIntent?: MemberWorkSyncOutboxItem['payload']['workSyncIntent'] | undefined;
    workSyncIntentKey?: MemberWorkSyncOutboxItem['payload']['workSyncIntentKey'] | undefined;
    taskRefs?: MemberWorkSyncOutboxItem['payload']['taskRefs'] | undefined;
    exactRuntimeTicket?: MemberWorkSyncRuntimeTicket | undefined;
  }): Promise<{ busy: boolean; reason?: string | undefined; retryAfterIso?: string | undefined }>;
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
    | { ok: true }
    | { ok: false; reason: string; retryable: boolean; nextAttemptAt?: string | undefined }
  >;
}

export interface MemberWorkSyncNudgeDeliveryWakePort {
  schedule(input: {
    teamName: string;
    memberName: string;
    messageId: string;
    providerId?: (MemberWorkSyncProviderId | null) | undefined;
    reason: 'member_work_sync_nudge_inserted' | 'member_work_sync_nudge_existing';
    delayMs?: number | undefined;
  }): Promise<void> | void;
}

export type MemberWorkSyncReviewPickupDeliveryOutcome =
  | {
      ok: true;
      state: 'prompt_accepted' | 'response_proven';
      messageId: string;
      diagnostics?: string[] | undefined;
    }
  | {
      ok: false;
      reason: 'capability_absent' | 'retryable_failure' | 'terminal_failure';
      message: string;
      diagnostics?: string[] | undefined;
      retryAfterIso?: string | undefined;
    };

export interface MemberWorkSyncReviewPickupDeliveryPort {
  canDeliver(input: {
    teamName: string;
    memberName: string;
    providerId?: (MemberWorkSyncProviderId | null) | undefined;
  }):
    | Promise<{ ok: true } | { ok: false; reason: string; diagnostics?: string[] | undefined }>
    | {
        ok: true;
      }
    | { ok: false; reason: string; diagnostics?: string[] | undefined };
  deliver(input: {
    teamName: string;
    memberName: string;
    messageId: string;
    providerId?: (MemberWorkSyncProviderId | null) | undefined;
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
    agendaFingerprint?: string | undefined;
    reviewRequestEventIds?: string[] | undefined;
    diagnostics?: string[] | undefined;
    taskRefs: { taskId: string; displayId?: string | undefined; teamName?: string | undefined }[];
  }): Promise<void> | void;
}

export interface MemberWorkSyncUseCaseDeps {
  clock: MemberWorkSyncClockPort;
  hash: MemberWorkSyncHashPort;
  agendaSource: MemberWorkSyncAgendaSourcePort;
  statusStore: MemberWorkSyncStatusStorePort;
  /** Bound by main admission; activated with the restore/replica ownership path. */
  statusMutations?: MemberWorkSyncConditionalStatusPort | undefined;
  reportStore?: MemberWorkSyncReportStorePort | undefined;
  reportJournal?: MemberWorkSyncReportJournalPort | undefined;
  outboxStore?: MemberWorkSyncOutboxStorePort | undefined;
  inboxNudge?: MemberWorkSyncInboxNudgePort | undefined;
  watchdogCooldown?: MemberWorkSyncWatchdogCooldownPort | undefined;
  busySignal?: MemberWorkSyncBusySignalPort | undefined;
  proofMissingRecoveryGuard?: MemberWorkSyncProofMissingRecoveryGuardPort | undefined;
  nudgeDeliveryWake?: MemberWorkSyncNudgeDeliveryWakePort | undefined;
  reviewPickupDelivery?: MemberWorkSyncReviewPickupDeliveryPort | undefined;
  reviewPickupEscalation?: MemberWorkSyncReviewPickupEscalationPort | undefined;
  reportToken?: MemberWorkSyncReportTokenPort | undefined;
  auditJournal?: MemberWorkSyncAuditJournalPort | undefined;
  lifecycle?: MemberWorkSyncLifecyclePort | undefined;
  logger?: MemberWorkSyncLoggerPort | undefined;
  /**
   * Qualified D0 protocol-1 admission. Until enabled, planners record
   * observation/attention only and must not create recovery reservations.
   */
  recoveryAllocation?: { enabled: boolean } | undefined;
  /** Declared runtime recovery protocol for this instance. Missing means 0. */
  recoveryProtocol?: { version: number } | undefined;
  /**
   * Protocol-2 ticket admission. Required together with recoveryProtocol.version >= 2
   * before early continuation may allocate. Missing/not_early falls through to D0.
   */
  runtimeTicketAdmission?: MemberWorkSyncRuntimeTicketAdmissionPort | undefined;
}

export type MemberWorkSyncRuntimeTicketAdmissionCode =
  | 'not_early'
  | 'busy'
  | 'user_input'
  | 'approval'
  | 'stopped'
  | 'instance_mismatch'
  | 'conflict'
  | 'unknown';

export interface MemberWorkSyncRuntimeTicket {
  teamName: string;
  teamIncarnation: string;
  memberName: string;
  runtimeInstanceId: string;
  expectedGeneration: number;
  ticketId: string;
  intentId: string;
  controlRevision: number;
  admissionPayloadHash: string;
}

export interface MemberWorkSyncRuntimeTicketAdmissionPort {
  admit(input: {
    teamName: string;
    memberName: string;
    teamIncarnation: string;
    intentId: string;
    admissionPayloadHash: string;
    expectedGeneration: number;
    runtimeInstanceId?: string | undefined;
    controlRevision: number;
    providerId?: string | undefined;
  }): Promise<
    | { admitted: true; ticket: MemberWorkSyncRuntimeTicket }
    | { admitted: false; code: MemberWorkSyncRuntimeTicketAdmissionCode }
  >;
  cancel(ticket: MemberWorkSyncRuntimeTicket): Promise<void>;
  syncControl?(input: {
    teamName: string;
    memberName: string;
    teamIncarnation?: string | undefined;
    runtimeInstanceId: string;
    controlRevision: number;
    stopped: boolean;
  }): Promise<
    | { ok: true; code: 'closed' | 'open'; controlRevision: number }
    | { ok: false; code: 'unknown' | 'superseded' | 'conflict' | 'instance_mismatch' }
  >;
  readLiveControl?(input: { teamName: string; memberName: string }): Promise<{
    runtimeInstanceId: string;
    controlRevision: number;
    stopped: boolean;
    handshakeCompleted: boolean;
  } | null>;
  confirmReserved?(
    ticket: MemberWorkSyncRuntimeTicket
  ): Promise<{ ok: true } | { ok: false; code: 'stale' | 'unknown' }>;
}

export interface LatestAcceptedReportLookup {
  latestAcceptedReport?: MemberWorkSyncReport | undefined;
}
