import type {
  OpenCodeTeamRuntimeMessageInput,
  OpenCodeTeamRuntimeMessageResult,
  TeamLaunchRuntimeAdapter,
} from '../../runtime';
import type { OpenCodeCommittedBootstrapSessionRecord } from '../store/OpenCodeRuntimeManifestEvidenceReader';
import type { OpenCodePromptDeliveryFollowUpPolicy } from './OpenCodePromptDeliveryFollowUpPolicy';
import type {
  OpenCodePromptDeliveryLedgerRecord,
  OpenCodePromptDeliveryLedgerStore,
  OpenCodePromptDeliveryStatus,
} from './OpenCodePromptDeliveryLedger';
import type { OpenCodeStalePendingPolicyConfig } from './OpenCodePromptDeliveryStalePendingPolicy';
import type { OpenCodeVisibleReplyProof } from './OpenCodePromptDeliveryWatchdog';
import type { OpenCodePromptDeliveryWatchdogScheduler } from './OpenCodePromptDeliveryWatchdogScheduler';
import type { OpenCodeMemberContextUsageProbe } from './OpenCodeStalePendingObservationSignals';
import type { OpenCodeVisibleReplyProofService } from './OpenCodeVisibleReplyProofService';
import type {
  AgentActionMode,
  AttachmentPayload,
  InboxMessage,
  OpenCodeRuntimeDeliveryUserVisibleImpact,
  TaskRef,
  TeamConfig,
  TeamMember,
  TeamProviderId,
} from '@shared/types';

export type OpenCodeRuntimeMessageAdapter = TeamLaunchRuntimeAdapter & {
  sendMessageToMember(
    input: OpenCodeTeamRuntimeMessageInput
  ): Promise<OpenCodeTeamRuntimeMessageResult>;
  observeMessageDelivery?(
    input: OpenCodeTeamRuntimeMessageInput & {
      prePromptCursor?: string | null;
      sessionId?: string;
      runtimePromptMessageId?: string;
    }
  ): Promise<OpenCodeTeamRuntimeMessageResult>;
};

export type OpenCodeMemberMessageDeliverySource =
  | 'watcher'
  | 'ui-send'
  | 'manual'
  | 'watchdog'
  | 'member-work-sync-review-pickup';

export interface OpenCodeMemberMessageDeliveryInput {
  memberName: string;
  text: string;
  messageId?: string;
  replyRecipient?: string;
  actionMode?: AgentActionMode;
  messageKind?: InboxMessage['messageKind'];
  workSyncIntent?: InboxMessage['workSyncIntent'];
  workSyncReviewRequestEventIds?: string[];
  taskRefs?: TaskRef[];
  attachments?: AttachmentPayload[];
  source?: OpenCodeMemberMessageDeliverySource;
  inboxTimestamp?: string;
  /**
   * Extra reply-optional notices delivered inside the same prompt (inbox relay
   * coalescing). Appended to the prompt body only; the ledger payload hash is
   * computed from `text`, so retries of the same inbox row stay consistent.
   */
  coalescedNoticeText?: string;
}

/**
 * The prompt body actually sent to the runtime: the inbox row's own text plus
 * whatever notices the relay folded into this delivery. Keep this separate from
 * `input.text`, which is the identity of the inbox row and the only thing the
 * payload hash may see.
 */
export function buildOpenCodePromptBodyText(
  input: Pick<OpenCodeMemberMessageDeliveryInput, 'text' | 'coalescedNoticeText'>
): string {
  const extra = input.coalescedNoticeText?.trim();
  return extra ? `${input.text}\n\n${extra}` : input.text;
}

export interface OpenCodeMemberInboxDelivery {
  delivered: boolean;
  accepted?: boolean;
  responsePending?: boolean;
  acceptanceUnknown?: boolean;
  responseState?: NonNullable<OpenCodeTeamRuntimeMessageResult['responseObservation']>['state'];
  ledgerStatus?: OpenCodePromptDeliveryStatus;
  ledgerRecordId?: string;
  laneId?: string;
  visibleReplyMessageId?: string;
  visibleReplyCorrelation?:
    | 'relayOfMessageId'
    | 'direct_child_message_send'
    | 'plain_assistant_text';
  queuedBehindMessageId?: string;
  /**
   * True only when THIS call dispatched a prompt carrying `coalescedNoticeText`
   * and the runtime accepted it. `delivered` is not proof of dispatch (see the
   * INVARIANT note at the end of `deliver`), so the inbox relay read-commits
   * coalesced riders on this flag alone.
   */
  coalescedNoticesDelivered?: boolean;
  reason?: string;
  diagnostics?: string[];
  userVisibleImpact?: OpenCodeRuntimeDeliveryUserVisibleImpact;
}

export interface OpenCodeMemberDirectory {
  config: TeamConfig | null;
  teamMeta: {
    launchIdentity?: {
      providerId?: unknown;
      selectedModel?: unknown;
      resolvedLaunchModel?: unknown;
    } | null;
    providerId?: unknown;
    model?: unknown;
    cwd?: unknown;
  } | null;
  metaMembers: TeamMember[];
}

export interface OpenCodeMemberLaneIdentity {
  laneId: string;
  laneKind: 'primary' | 'secondary';
  laneOwnerProviderId?: TeamProviderId;
}

export type OpenCodeMemberIdentityResolution =
  | {
      ok: true;
      canonicalMemberName: string;
      laneId: string;
      laneIdentity: OpenCodeMemberLaneIdentity;
      configMember?: TeamMember;
      metaMember?: TeamMember;
      memberRuntimeCwd?: string;
    }
  | {
      ok: false;
      reason: 'recipient_is_not_opencode' | 'recipient_removed' | 'opencode_recipient_unavailable';
    };

interface DeliverableTrackedRun {
  mixedSecondaryLanes: readonly {
    laneId: string;
    member: { name: string };
    runId?: string | null;
  }[];
}

export interface OpenCodeLeadTurnActivityNotification {
  teamName: string;
  memberName: string;
  laneId: string;
  runId: string | null;
  state: 'active' | 'idle';
}

export interface OpenCodeMemberMessageDeliveryServiceDependencies {
  getOpenCodeRuntimeMessageAdapter(): OpenCodeRuntimeMessageAdapter | null;
  readOpenCodeMemberDirectory(teamName: string): Promise<OpenCodeMemberDirectory>;
  resolveOpenCodeMemberIdentityFromDirectory(
    teamName: string,
    memberName: string,
    directory: OpenCodeMemberDirectory
  ): OpenCodeMemberIdentityResolution;
  stoppingSecondaryRuntimeTeams: { has(teamName: string): boolean };
  readPersistedTeamProjectPath(teamName: string): string | null;
  resolveDeliverableTrackedRuntimeRunId(teamName: string): string | null;
  runs: { get(runId: string): DeliverableTrackedRun | undefined };
  getCurrentOpenCodeRuntimeRunId(teamName: string, laneId: string): string | null;
  resolveCurrentOpenCodeRuntimeRunId(teamName: string, laneId: string): Promise<string | null>;
  isOpenCodeRuntimeLaneIndexActive(teamName: string, laneId: string): Promise<boolean>;
  tryRecoverOpenCodeRuntimeLaneBeforeDelivery(input: {
    teamName: string;
    laneId: string;
    member: TeamMember;
    projectPath: string | null;
  }): Promise<boolean>;
  tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery(input: {
    teamName: string;
    laneId: string;
    member: TeamMember;
    projectPath: string | null;
  }): Promise<boolean>;
  /**
   * Runtime turn/context token usage for a lane member: the only progress proof
   * an ACP bridge produces. Unset, the probe short-circuits and the
   * stale-pending clock is pure wall time.
   */
  readOpenCodeMemberContextUsage?: OpenCodeMemberContextUsageProbe;
  deleteSecondaryRuntimeRun(teamName: string, laneId: string): void;
  cleanupStoppedTeamOpenCodeRuntimeLanesInBackground(teamName: string): void;
  findDeliverableOpenCodeRuntimeBootstrapSessionEvidence(input: {
    teamName: string;
    runId: string | null;
    laneId: string;
    memberName: string;
  }): Promise<OpenCodeCommittedBootstrapSessionRecord | null>;
  getOpenCodeAppMcpTransportMismatchDiagnostic(
    session: OpenCodeCommittedBootstrapSessionRecord
  ): string | null;
  stampOpenCodeAppMcpTransportEvidenceIfMissing(
    session: OpenCodeCommittedBootstrapSessionRecord,
    options?: { overwriteExistingHash?: boolean; runtimeSessionId?: string | null }
  ): Promise<void>;
  resolveControlApiBaseUrl(): Promise<string | null>;
  sendOpenCodeMemberMessageToRuntimeSerialized(input: {
    teamName: string;
    laneId: string;
    memberName: string;
    send: () => Promise<OpenCodeTeamRuntimeMessageResult>;
  }): Promise<OpenCodeTeamRuntimeMessageResult>;
  rememberOpenCodeRuntimePidFromBridge(input: {
    teamName: string;
    memberName: string;
    laneId: string;
    runId?: string | null;
    runtimeSessionId?: string | null;
    runtimePid?: number;
    reason: string;
  }): Promise<void>;
  maybeSyncOpenCodeRuntimePermissionsAfterDelivery(input: {
    teamName: string;
    runId?: string | null;
    laneId: string;
    memberName: string;
    cwd: string;
    sessionId?: string | null;
    responseState?: OpenCodeMemberInboxDelivery['responseState'];
    reason?: string | null;
    diagnostics?: readonly string[];
    teamColor?: string;
    teamDisplayName?: string;
  }): Promise<void>;
  isLegacyOpenCodeMemberWorkSyncReadCommitAllowed(input: {
    teamName: string;
    memberName: string;
    workSyncIntent?: OpenCodeTeamRuntimeMessageInput['workSyncIntent'];
    responseObservation?: NonNullable<OpenCodeTeamRuntimeMessageResult['responseObservation']>;
  }): Promise<boolean>;
  createOpenCodePromptDeliveryLedger(
    teamName: string,
    laneId: string
  ): OpenCodePromptDeliveryLedgerStore;
  openCodeVisibleReplyProofService: Pick<
    OpenCodeVisibleReplyProofService,
    'applyDestinationProof' | 'materializePlainTextReplyIfNeeded' | 'findByRelayOfMessageId'
  >;
  openCodePromptDeliveryWatchdogScheduler: Pick<
    OpenCodePromptDeliveryWatchdogScheduler,
    'isEnabled'
  >;
  openCodePromptDeliveryFollowUpPolicy: Pick<OpenCodePromptDeliveryFollowUpPolicy, 'schedule'>;
  /**
   * Windows the stale-pending guard bounds a pending delivery with. Supplied by
   * whoever composes this service; the policy itself has no defaults.
   */
  openCodeStalePendingPolicyConfig: OpenCodeStalePendingPolicyConfig;
  isOpenCodeDeliveryResponseReadCommitAllowed(input: {
    teamName?: string;
    memberName?: string;
    responseState?: OpenCodeMemberInboxDelivery['responseState'];
    actionMode?: AgentActionMode;
    taskRefs?: TaskRef[];
    visibleReply?: OpenCodeVisibleReplyProof | null;
    ledgerRecord?: OpenCodePromptDeliveryLedgerRecord | null;
  }): Promise<boolean>;
  getOpenCodeDeliveryPendingReason(input: {
    responseState?: OpenCodeMemberInboxDelivery['responseState'];
    actionMode?: AgentActionMode | null;
    taskRefs?: TaskRef[];
    visibleReply?: OpenCodeVisibleReplyProof | null;
    ledgerRecord?: OpenCodePromptDeliveryLedgerRecord | null;
  }): string;
  markOpenCodeAcceptedDeliveryMissingPromptProofForRetry(input: {
    ledger: OpenCodePromptDeliveryLedgerStore;
    ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
    eventContext?: Record<string, unknown>;
  }): Promise<OpenCodePromptDeliveryLedgerRecord>;
  scheduleOpenCodePromptDeliveryWatchdog(input: {
    teamName: string;
    memberName: string;
    messageId?: string | null;
    delayMs: number;
  }): void;
  logOpenCodePromptDeliveryEvent(
    event: string,
    record: OpenCodePromptDeliveryLedgerRecord,
    extra?: Record<string, unknown>
  ): void;
  requeueOpenCodeRuntimeManifestWatermarkDeliveryIfNeeded(input: {
    ledger: OpenCodePromptDeliveryLedgerStore;
    ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
  }): Promise<OpenCodePromptDeliveryLedgerRecord>;
  emitOpenCodePromptDeliveryTaskLogChange(
    record: OpenCodePromptDeliveryLedgerRecord,
    detail: string
  ): void;
  /**
   * Lead activity for the OpenCode primary lane. A pure-OpenCode lead has no
   * stdin stream, so "Working"/"Idle" is derived from prompt-delivery turns:
   * 'active' once a prompt is accepted, 'idle' once the delivery settles.
   */
  notifyOpenCodeLeadTurnActivity?(input: OpenCodeLeadTurnActivityNotification): void;
  observeOpenCodeDirectUserDeliveryInlineIfNeeded(input: {
    adapter: OpenCodeRuntimeMessageAdapter;
    ledger: OpenCodePromptDeliveryLedgerStore;
    ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
    teamName: string;
    memberName: string;
    laneId: string;
    cwd: string;
    text: string;
    messageId: string;
    runtimeRunId?: string | null;
    replyRecipient?: string | null;
    actionMode?: AgentActionMode;
    messageKind?: OpenCodeTeamRuntimeMessageInput['messageKind'];
    workSyncIntent?: OpenCodeTeamRuntimeMessageInput['workSyncIntent'];
    workSyncReviewRequestEventIds?: string[];
    taskRefs?: TaskRef[];
    promptAccepted: boolean;
    visibleReply?: OpenCodeVisibleReplyProof | null;
  }): Promise<{
    ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
    visibleReply: OpenCodeVisibleReplyProof | null;
  }>;
}
