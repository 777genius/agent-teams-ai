export type MemberWorkSyncReportState = 'still_working' | 'blocked' | 'caught_up';

export type MemberWorkSyncStatusState =
  | 'caught_up'
  | 'needs_sync'
  | 'still_working'
  | 'blocked'
  | 'inactive'
  | 'unknown';

export type MemberWorkSyncActionableWorkKind =
  | 'work'
  | 'review'
  | 'clarification'
  | 'blocked_dependency';

export type MemberWorkSyncActionableWorkPriority =
  | 'normal'
  | 'review_requested'
  | 'blocked'
  | 'needs_clarification';

export type MemberWorkSyncProviderId = 'anthropic' | 'codex' | 'gemini' | 'opencode';

export type MemberWorkSyncReviewObligation = 'review_pickup_required' | 'review_in_progress';

export type MemberWorkSyncNudgeIntent = 'agenda_sync' | 'review_pickup';

export type MemberWorkSyncReviewPickupDeliveryState =
  | 'inbox_persisted'
  | 'prompt_accepted'
  | 'response_proven';

export interface MemberWorkSyncActionableWorkItem {
  taskId: string;
  displayId?: string;
  subject: string;
  kind: MemberWorkSyncActionableWorkKind;
  assignee: string;
  priority: MemberWorkSyncActionableWorkPriority;
  reason: string;
  evidence: {
    status: string;
    owner?: string;
    reviewer?: string;
    reviewState?: string;
    reviewCycleId?: string;
    reviewRequestEventId?: string;
    reviewRequestedAt?: string;
    reviewStartedEventId?: string;
    reviewStartedAt?: string;
    reviewStartedBy?: string;
    reviewObligation?: MemberWorkSyncReviewObligation;
    canBypassPhase2?: boolean;
    reviewDiagnostics?: string[];
    needsClarification?: 'lead' | 'user';
    blockerTaskIds?: string[];
    blockedByTaskIds?: string[];
    historyEventIds?: string[];
  };
}

export interface MemberWorkSyncAgenda {
  teamName: string;
  memberName: string;
  generatedAt: string;
  fingerprint: string;
  items: MemberWorkSyncActionableWorkItem[];
  diagnostics: string[];
  sourceRevision?: string;
}

export interface MemberWorkSyncReport {
  state: MemberWorkSyncReportState;
  agendaFingerprint: string;
  memberName: string;
  teamName: string;
  reportedAt: string;
  expiresAt?: string;
  taskIds?: string[];
  note?: string;
  source?: 'mcp' | 'app' | 'test';
  accepted: boolean;
  rejectionCode?: string;
}

export type MemberWorkSyncReportIntentStatus = 'pending' | 'accepted' | 'rejected' | 'superseded';

export interface MemberWorkSyncReportJournalMetadata {
  incarnation: string;
  requestDigest: string;
  firstRecordedAt: string;
  origin: 'online' | 'fallback';
  receipt?: MemberWorkSyncReportReceipt;
}

export interface MemberWorkSyncReportIntent {
  journal?: MemberWorkSyncReportJournalMetadata;
  id: string;
  teamName: string;
  memberName: string;
  request: MemberWorkSyncReportRequest;
  reason: string;
  status: MemberWorkSyncReportIntentStatus;
  recordedAt: string;
  processedAt?: string;
  resultCode?: string;
}

export interface MemberWorkSyncShadowDiagnostics {
  reconciledBy: 'request' | 'queue' | 'report';
  wouldNudge: boolean;
  fingerprintChanged: boolean;
  previousFingerprint?: string;
  triggerReasons?: string[];
  nudgeSuppressionResetAt?: string;
  nudgeSuppression?: {
    reason: 'no_accepted_report';
    agendaFingerprint: string;
    deliveredCount: number;
    suppressedAt: string;
    resetAt?: string;
  };
  recovery?: {
    kind: 'proof_missing';
    intentKey: string;
    originalMessageId: string;
    taskIds: string[];
  };
}

export interface MemberWorkSyncStatusRevision {
  incarnation: string;
  lineageId: string;
  sequence: number;
  nonce: string;
}

export interface MemberWorkSyncReportReceiptDraft {
  intentId: string;
  incarnation: string;
  requestDigest: string;
  acceptedAt: string;
  originalExpiresAt?: string;
}

export interface MemberWorkSyncReportReceipt extends MemberWorkSyncReportReceiptDraft {
  appliedStatusRevision: MemberWorkSyncStatusRevision;
}

export type MemberWorkSyncRecoveryPhase =
  | 'observing'
  | 'continuation_pending'
  | 'awaiting_outcome'
  | 'attention'
  | 'expected_wait';

export interface MemberWorkSyncRecoveryEpisode {
  episodeId: string;
  workKey: string;
  taskId: string;
  firstObservedAt: string;
  lastProgressAt?: string;
  lastEvidenceId?: string;
  dueAt: string;
  phase: MemberWorkSyncRecoveryPhase;
  reason: string;
}

export type MemberWorkSyncRecoveryTerminalOutcome =
  | 'retryable_refusal'
  | 'terminal_refusal'
  | 'settled'
  | 'unknown';

export interface MemberWorkSyncRecoveryReservation {
  intentId: string;
  episodeId: string;
  trigger: 'automatic' | 'manual';
  reservedAt: string;
  state: 'reserved' | 'awaiting_outcome' | 'resolved' | 'cancelled' | 'uncertain';
  payloadHash: string;
  controlRevision: number;
  terminalOutcome?: MemberWorkSyncRecoveryTerminalOutcome;
  terminalReceiptId?: string;
  pendingAck?: boolean;
  ackIdentity?: string;
  compactWitness?: boolean;
}

export interface MemberWorkSyncAutoResumeStopLatch {
  stoppedAt: string;
  reason: string;
  controlRevision: number;
}

export interface MemberWorkSyncRecoveryHealth {
  schemaVersion: 1;
  episodes: MemberWorkSyncRecoveryEpisode[];
  unresolvedIntentId?: string;
  attentionAt?: string;
  attentionAcknowledgedAt?: string;
  autoResumeStopLatch?: MemberWorkSyncAutoResumeStopLatch;
  controlRevision?: number;
  reservations?: MemberWorkSyncRecoveryReservation[];
}

export interface MemberWorkSyncStatus {
  teamName: string;
  memberName: string;
  state: MemberWorkSyncStatusState;
  agenda: MemberWorkSyncAgenda;
  /** Assigned only by the authority storage adapter, never by report input. */
  statusRevision?: MemberWorkSyncStatusRevision;
  pendingReportReceipt?: MemberWorkSyncReportReceipt;
  report?: MemberWorkSyncReport;
  /** Accepted lease authority, separate from the latest rejected diagnostic report. */
  lastAcceptedReport?: MemberWorkSyncReport;
  reportToken?: string;
  reportTokenExpiresAt?: string;
  shadow?: MemberWorkSyncShadowDiagnostics;
  evaluatedAt: string;
  diagnostics: string[];
  providerId?: MemberWorkSyncProviderId;
  recoveryHealth?: MemberWorkSyncRecoveryHealth;
}

export type MemberWorkSyncMetricEventKind =
  | 'status_evaluated'
  | 'would_nudge'
  | 'fingerprint_changed'
  | 'report_accepted'
  | 'report_rejected';

export interface MemberWorkSyncMetricEvent {
  id: string;
  teamName: string;
  memberName: string;
  kind: MemberWorkSyncMetricEventKind;
  state: MemberWorkSyncStatusState;
  agendaFingerprint: string;
  recordedAt: string;
  actionableCount: number;
  providerId?: MemberWorkSyncProviderId;
  previousFingerprint?: string;
  triggerReasons?: string[];
  reportState?: MemberWorkSyncReportState;
  rejectionCode?: string;
}

export interface MemberWorkSyncTeamMetrics {
  teamName: string;
  generatedAt: string;
  memberCount: number;
  stateCounts: Record<MemberWorkSyncStatusState, number>;
  actionableItemCount: number;
  wouldNudgeCount: number;
  fingerprintChangeCount: number;
  reportAcceptedCount: number;
  reportRejectedCount: number;
  recentEvents: MemberWorkSyncMetricEvent[];
  phase2Readiness: MemberWorkSyncPhase2ReadinessAssessment;
}

export type MemberWorkSyncPhase2ReadinessState =
  | 'collecting_shadow_data'
  | 'shadow_ready'
  | 'blocked';

export type MemberWorkSyncPhase2ReadinessReason =
  | 'insufficient_members'
  | 'insufficient_status_events'
  | 'insufficient_observation_window'
  | 'would_nudge_rate_high'
  | 'fingerprint_churn_high'
  | 'report_rejection_rate_high';

export interface MemberWorkSyncPhase2ReadinessThresholds {
  minObservedMembers: number;
  minStatusEvents: number;
  minObservationHours: number;
  maxWouldNudgesPerMemberHour: number;
  maxFingerprintChangesPerMemberHour: number;
  maxReportRejectionRate: number;
}

export interface MemberWorkSyncPhase2ReadinessRates {
  observationHours: number;
  statusEventCount: number;
  wouldNudgesPerMemberHour: number;
  fingerprintChangesPerMemberHour: number;
  reportRejectionRate: number;
}

export interface MemberWorkSyncPhase2ReadinessAssessment {
  state: MemberWorkSyncPhase2ReadinessState;
  reasons: MemberWorkSyncPhase2ReadinessReason[];
  thresholds: MemberWorkSyncPhase2ReadinessThresholds;
  rates: MemberWorkSyncPhase2ReadinessRates;
  diagnostics: string[];
}

export interface MemberWorkSyncReportRequest {
  teamName: string;
  memberName: string;
  state: MemberWorkSyncReportState;
  agendaFingerprint: string;
  reportToken?: string;
  taskIds?: string[];
  note?: string;
  reportedAt?: string;
  leaseTtlMs?: number;
  source?: 'mcp' | 'app' | 'test';
}

export interface MemberWorkSyncReportResult {
  accepted: boolean;
  code: string;
  message: string;
  status: MemberWorkSyncStatus;
  projectionDegraded?: boolean;
}

export interface MemberWorkSyncStatusRequest {
  teamName: string;
  memberName: string;
  forceNudge?: boolean;
}

export interface MemberWorkSyncMetricsRequest {
  teamName: string;
}

export type MemberWorkSyncOutboxStatus =
  | 'pending'
  | 'claimed'
  | 'delivered'
  | 'superseded'
  | 'failed_retryable'
  | 'failed_terminal';

export interface MemberWorkSyncNudgePayload {
  from: 'system';
  to: string;
  messageKind: 'member_work_sync_nudge';
  source: 'member-work-sync';
  actionMode: 'do';
  workSyncIntent: MemberWorkSyncNudgeIntent;
  workSyncIntentKey?: string;
  workSyncReviewRequestEventIds?: string[];
  workSyncRuntimeTicketId?: string;
  workSyncRuntimeGeneration?: number;
  text: string;
  taskRefs: {
    taskId: string;
    displayId: string;
    teamName: string;
  }[];
}

export interface MemberWorkSyncOutboxItem {
  id: string;
  teamName: string;
  memberName: string;
  agendaFingerprint: string;
  payloadHash: string;
  payload: MemberWorkSyncNudgePayload;
  status: MemberWorkSyncOutboxStatus;
  attemptGeneration: number;
  claimedBy?: string;
  claimedAt?: string;
  deliveredMessageId?: string;
  deliveryState?: MemberWorkSyncReviewPickupDeliveryState;
  deliveryDiagnostics?: string[];
  lastError?: string;
  nextAttemptAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type MemberWorkSyncOutboxEnsureResult =
  | { ok: true; outcome: 'created' | 'existing'; item: MemberWorkSyncOutboxItem }
  | {
      ok: false;
      outcome: 'payload_conflict';
      item: MemberWorkSyncOutboxItem;
      existingPayloadHash: string;
      requestedPayloadHash: string;
    };

export interface MemberWorkSyncOutboxEnsureInput {
  id: string;
  teamName: string;
  memberName: string;
  agendaFingerprint: string;
  payloadHash: string;
  payload: MemberWorkSyncNudgePayload;
  nowIso: string;
  nextAttemptAt?: string;
}

export interface MemberWorkSyncOutboxClaimInput {
  teamName: string;
  claimedBy: string;
  nowIso: string;
  limit: number;
}

export interface MemberWorkSyncOutboxMarkDeliveredInput {
  teamName: string;
  id: string;
  attemptGeneration: number;
  deliveredMessageId: string;
  deliveryState?: MemberWorkSyncReviewPickupDeliveryState;
  deliveryDiagnostics?: string[];
  nowIso: string;
}

export interface MemberWorkSyncOutboxMarkSupersededInput {
  teamName: string;
  id: string;
  reason: string;
  nowIso: string;
}

export interface MemberWorkSyncOutboxMarkFailedInput {
  teamName: string;
  id: string;
  attemptGeneration: number;
  error: string;
  retryable: boolean;
  nowIso: string;
  nextAttemptAt?: string;
}

export interface MemberWorkSyncOutboxCountRecentDeliveredInput {
  teamName: string;
  memberName: string;
  sinceIso: string;
  workSyncIntentKeyPrefix?: string;
}

export interface MemberWorkSyncOutboxCountDeliveredForAgendaInput {
  teamName: string;
  memberName: string;
  agendaFingerprint: string;
  sinceIso?: string;
}
