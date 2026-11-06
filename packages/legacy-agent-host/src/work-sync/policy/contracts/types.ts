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
  displayId?: string | undefined;
  subject: string;
  kind: MemberWorkSyncActionableWorkKind;
  assignee: string;
  priority: MemberWorkSyncActionableWorkPriority;
  reason: string;
  evidence: {
    status: string;
    owner?: string | undefined;
    reviewer?: string | undefined;
    reviewState?: string | undefined;
    reviewCycleId?: string | undefined;
    reviewRequestEventId?: string | undefined;
    reviewRequestedAt?: string | undefined;
    reviewStartedEventId?: string | undefined;
    reviewStartedAt?: string | undefined;
    reviewStartedBy?: string | undefined;
    reviewObligation?: MemberWorkSyncReviewObligation | undefined;
    canBypassPhase2?: boolean | undefined;
    reviewDiagnostics?: string[] | undefined;
    needsClarification?: ('lead' | 'user') | undefined;
    blockerTaskIds?: string[] | undefined;
    blockedByTaskIds?: string[] | undefined;
    historyEventIds?: string[] | undefined;
  };
}

export interface MemberWorkSyncAgenda {
  teamName: string;
  memberName: string;
  generatedAt: string;
  fingerprint: string;
  items: MemberWorkSyncActionableWorkItem[];
  diagnostics: string[];
  sourceRevision?: string | undefined;
}

export interface MemberWorkSyncReport {
  state: MemberWorkSyncReportState;
  agendaFingerprint: string;
  memberName: string;
  teamName: string;
  reportedAt: string;
  expiresAt?: string | undefined;
  taskIds?: string[] | undefined;
  note?: string | undefined;
  source?: ('mcp' | 'app' | 'test') | undefined;
  accepted: boolean;
  rejectionCode?: string | undefined;
}

export type MemberWorkSyncReportIntentStatus = 'pending' | 'accepted' | 'rejected' | 'superseded';

export interface MemberWorkSyncReportJournalMetadata {
  incarnation: string;
  requestDigest: string;
  firstRecordedAt: string;
  origin: 'online' | 'fallback';
  receipt?: MemberWorkSyncReportReceipt | undefined;
}

export interface MemberWorkSyncReportIntent {
  journal?: MemberWorkSyncReportJournalMetadata | undefined;
  id: string;
  teamName: string;
  memberName: string;
  request: MemberWorkSyncReportRequest;
  reason: string;
  status: MemberWorkSyncReportIntentStatus;
  recordedAt: string;
  processedAt?: string | undefined;
  resultCode?: string | undefined;
}

export interface MemberWorkSyncShadowDiagnostics {
  reconciledBy: 'request' | 'queue' | 'report';
  wouldNudge: boolean;
  fingerprintChanged: boolean;
  previousFingerprint?: string | undefined;
  triggerReasons?: string[] | undefined;
  nudgeSuppressionResetAt?: string | undefined;
  nudgeSuppression?:
    | {
        reason: 'no_accepted_report';
        agendaFingerprint: string;
        deliveredCount: number;
        suppressedAt: string;
        resetAt?: string | undefined;
      }
    | undefined;
  recovery?:
    | {
        kind: 'proof_missing';
        intentKey: string;
        originalMessageId: string;
        taskIds: string[];
      }
    | undefined;
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
  originalExpiresAt?: string | undefined;
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
  lastProgressAt?: string | undefined;
  lastEvidenceId?: string | undefined;
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
  boundTurnId?: string | undefined;
  deliveredAt?: string | undefined;
  terminalOutcome?: MemberWorkSyncRecoveryTerminalOutcome | undefined;
  terminalReceiptId?: string | undefined;
  pendingAck?: boolean | undefined;
  ackIdentity?: string | undefined;
  compactWitness?: boolean | undefined;
}

export interface MemberWorkSyncAutoResumeStopLatch {
  stoppedAt: string;
  reason: string;
  controlRevision: number;
}

export interface MemberWorkSyncRecoveryHealth {
  schemaVersion: 1;
  episodes: MemberWorkSyncRecoveryEpisode[];
  unresolvedIntentId?: string | undefined;
  attentionAt?: string | undefined;
  attentionAcknowledgedAt?: string | undefined;
  autoResumeStopLatch?: MemberWorkSyncAutoResumeStopLatch | undefined;
  controlRevision?: number | undefined;
  reservations?: MemberWorkSyncRecoveryReservation[] | undefined;
}

export interface MemberWorkSyncStatus {
  teamName: string;
  memberName: string;
  state: MemberWorkSyncStatusState;
  agenda: MemberWorkSyncAgenda;
  /** Assigned only by the authority storage adapter, never by report input. */
  statusRevision?: MemberWorkSyncStatusRevision | undefined;
  pendingReportReceipt?: MemberWorkSyncReportReceipt | undefined;
  report?: MemberWorkSyncReport | undefined;
  /** Accepted lease authority, separate from the latest rejected diagnostic report. */
  lastAcceptedReport?: MemberWorkSyncReport | undefined;
  reportToken?: string | undefined;
  reportTokenExpiresAt?: string | undefined;
  shadow?: MemberWorkSyncShadowDiagnostics | undefined;
  evaluatedAt: string;
  diagnostics: string[];
  providerId?: MemberWorkSyncProviderId | undefined;
  recoveryHealth?: MemberWorkSyncRecoveryHealth | undefined;
  runtimeAdmission?:
    | {
        state: 'applied' | 'pending' | 'unknown' | 'superseded';
        controlRevision?: number | undefined;
      }
    | undefined;
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
  providerId?: MemberWorkSyncProviderId | undefined;
  previousFingerprint?: string | undefined;
  triggerReasons?: string[] | undefined;
  reportState?: MemberWorkSyncReportState | undefined;
  rejectionCode?: string | undefined;
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
  reportToken?: string | undefined;
  taskIds?: string[] | undefined;
  note?: string | undefined;
  reportedAt?: string | undefined;
  leaseTtlMs?: number | undefined;
  source?: ('mcp' | 'app' | 'test') | undefined;
}

export interface MemberWorkSyncReportResult {
  accepted: boolean;
  code: string;
  message: string;
  status: MemberWorkSyncStatus;
  projectionDegraded?: boolean | undefined;
}

export interface MemberWorkSyncStatusRequest {
  teamName: string;
  memberName: string;
  forceNudge?: boolean | undefined;
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
  workSyncIntentKey?: string | undefined;
  workSyncReviewRequestEventIds?: string[] | undefined;
  workSyncRuntimeTicketId?: string | undefined;
  workSyncRuntimeGeneration?: number | undefined;
  workSyncRuntimeInstanceId?: string | undefined;
  workSyncAdmissionPayloadHash?: string | undefined;
  workSyncTeamIncarnation?: string | undefined;
  workSyncControlRevision?: number | undefined;
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
  claimedBy?: string | undefined;
  claimedAt?: string | undefined;
  deliveredMessageId?: string | undefined;
  deliveryState?: MemberWorkSyncReviewPickupDeliveryState | undefined;
  deliveryDiagnostics?: string[] | undefined;
  lastError?: string | undefined;
  nextAttemptAt?: string | undefined;
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
  nextAttemptAt?: string | undefined;
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
  deliveryState?: MemberWorkSyncReviewPickupDeliveryState | undefined;
  deliveryDiagnostics?: string[] | undefined;
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
  nextAttemptAt?: string | undefined;
}

export interface MemberWorkSyncOutboxCountRecentDeliveredInput {
  teamName: string;
  memberName: string;
  sinceIso: string;
  workSyncIntentKeyPrefix?: string | undefined;
}

export interface MemberWorkSyncOutboxRecentDeliveredSummary {
  count: number;
  oldestUpdatedAt?: string | undefined;
}

export interface MemberWorkSyncOutboxCountDeliveredForAgendaInput {
  teamName: string;
  memberName: string;
  agendaFingerprint: string;
  sinceIso?: string | undefined;
}
