import {
  AgentAttachmentError,
  buildOpenCodeAttachmentDeliveryParts,
  type OpenCodeFilePart,
} from '@features/agent-attachments/main';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { getErrorMessage } from '@shared/utils/errorHandling';
import { createLogger } from '@shared/utils/logger';

import {
  inspectOpenCodeRuntimeLaneStorage,
  type OpenCodeCommittedBootstrapSessionRecord,
  recoverStaleOpenCodeRuntimeLaneIndexEntry,
} from '../store/OpenCodeRuntimeManifestEvidenceReader';

import {
  isOpenCodeSessionRefreshRetryRecord,
  type OpenCodePromptDeliveryFollowUpPolicy,
} from './OpenCodePromptDeliveryFollowUpPolicy';
import {
  buildOpenCodePromptDeliveryAttemptId,
  hashOpenCodePromptDeliveryPayload,
  isOpenCodePromptDeliveryAttemptDue,
  type OpenCodePromptDeliveryLedgerRecord,
  type OpenCodePromptDeliveryLedgerStore,
  type OpenCodePromptDeliveryStatus,
} from './OpenCodePromptDeliveryLedger';
import {
  buildOpenCodePromptDeliveryAttemptText,
  buildOpenCodePromptDeliveryRepairControlText,
  hasOpenCodeAcceptedRuntimePrompt,
  isOpenCodeAcceptedDeliveryMissingPromptProof,
  isOpenCodeDeliveryRetryablePendingResponse,
  isOpenCodePromptAcceptanceUnknownFailure,
  isOpenCodePromptAcceptedByObservation,
  normalizeOpenCodeDeliveryResponseObservation,
} from './OpenCodePromptDeliveryReadCommitPolicy';
import {
  isOpenCodePromptDeliveryRetryAttemptDue,
  OPENCODE_PROMPT_DELIVERY_OBSERVE_DELAY_MS,
  type OpenCodeVisibleReplyProof,
} from './OpenCodePromptDeliveryWatchdog';

import type {
  OpenCodeTeamRuntimeMessageInput,
  OpenCodeTeamRuntimeMessageResult,
  TeamLaunchRuntimeAdapter,
} from '../../runtime';
import type { OpenCodePromptDeliveryWatchdogScheduler } from './OpenCodePromptDeliveryWatchdogScheduler';
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

const logger = createLogger('Service:OpenCodeMemberMessageDelivery');

function nowIso(): string {
  return new Date().toISOString();
}

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
  reason?: string;
  diagnostics?: string[];
  userVisibleImpact?: OpenCodeRuntimeDeliveryUserVisibleImpact;
}

export interface OpenCodeMemberDirectory {
  config: TeamConfig | null;
  teamMeta: {
    launchIdentity?: { providerId?: unknown } | null;
    providerId?: unknown;
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

export class OpenCodeMemberMessageDeliveryService {
  constructor(private readonly deps: OpenCodeMemberMessageDeliveryServiceDependencies) {}

  async deliver(
    teamName: string,
    input: OpenCodeMemberMessageDeliveryInput
  ): Promise<OpenCodeMemberInboxDelivery> {
    const adapter = this.deps.getOpenCodeRuntimeMessageAdapter();
    if (!adapter) {
      return { delivered: false, reason: 'opencode_runtime_message_bridge_unavailable' };
    }
    const directory = await this.deps.readOpenCodeMemberDirectory(teamName);
    const identity = this.deps.resolveOpenCodeMemberIdentityFromDirectory(
      teamName,
      input.memberName,
      directory
    );
    if (identity.ok === false) {
      return {
        delivered: false,
        reason:
          identity.reason === 'opencode_recipient_unavailable'
            ? 'recipient_is_not_opencode'
            : identity.reason,
      };
    }
    const { config } = directory;
    const { canonicalMemberName, laneIdentity, configMember, metaMember, memberRuntimeCwd } =
      identity;
    const normalizedMemberName = input.memberName.trim();
    if (
      laneIdentity.laneKind === 'secondary' &&
      laneIdentity.laneOwnerProviderId === 'opencode' &&
      this.deps.stoppingSecondaryRuntimeTeams.has(teamName)
    ) {
      return { delivered: false, reason: 'opencode_runtime_not_active' };
    }
    const cwd =
      laneIdentity.laneKind === 'secondary' && laneIdentity.laneOwnerProviderId === 'opencode'
        ? memberRuntimeCwd ||
          config?.projectPath?.trim() ||
          this.deps.readPersistedTeamProjectPath(teamName)
        : config?.projectPath?.trim() ||
          memberRuntimeCwd ||
          this.deps.readPersistedTeamProjectPath(teamName);
    if (!cwd) {
      return { delivered: false, reason: 'opencode_project_path_unavailable' };
    }

    const trackedRunId = this.deps.resolveDeliverableTrackedRuntimeRunId(teamName);
    const trackedRun = trackedRunId ? this.deps.runs.get(trackedRunId) : null;
    let liveSecondaryLaneRunId: string | null = null;
    let trackedSecondaryLanePresent = false;
    let trackedSecondaryLaneSnapshotKnown = false;
    if (
      trackedRun &&
      laneIdentity.laneKind === 'secondary' &&
      laneIdentity.laneOwnerProviderId === 'opencode'
    ) {
      const secondaryLanes = trackedRun.mixedSecondaryLanes;
      trackedSecondaryLaneSnapshotKnown = secondaryLanes.length > 0;
      const liveLane = secondaryLanes.find(
        (lane) =>
          lane.laneId === laneIdentity.laneId ||
          lane.member.name.trim().toLowerCase() === normalizedMemberName.toLowerCase()
      );
      trackedSecondaryLanePresent = liveLane != null;
      liveSecondaryLaneRunId = liveLane?.runId?.trim() || null;
      if (!liveLane && trackedSecondaryLaneSnapshotKnown) {
        return { delivered: false, reason: 'opencode_runtime_not_active' };
      }
    }
    const inMemorySecondaryLaneRunId =
      laneIdentity.laneKind === 'secondary' && laneIdentity.laneOwnerProviderId === 'opencode'
        ? this.deps.getCurrentOpenCodeRuntimeRunId(teamName, laneIdentity.laneId)
        : null;
    let runtimeRunId =
      laneIdentity.laneKind === 'secondary' && laneIdentity.laneOwnerProviderId === 'opencode'
        ? (liveSecondaryLaneRunId ??
          inMemorySecondaryLaneRunId ??
          (await this.deps.resolveCurrentOpenCodeRuntimeRunId(teamName, laneIdentity.laneId)))
        : (trackedRunId ??
          (await this.deps.resolveCurrentOpenCodeRuntimeRunId(teamName, laneIdentity.laneId)));
    let runtimeActive = Boolean(runtimeRunId);
    if (!runtimeActive) {
      if (
        trackedRun &&
        laneIdentity.laneKind === 'secondary' &&
        laneIdentity.laneOwnerProviderId === 'opencode' &&
        !trackedSecondaryLanePresent &&
        trackedSecondaryLaneSnapshotKnown
      ) {
        return { delivered: false, reason: 'opencode_runtime_not_active' };
      }
      runtimeActive = await this.deps.isOpenCodeRuntimeLaneIndexActive(
        teamName,
        laneIdentity.laneId
      );
    }
    if (
      !runtimeActive &&
      laneIdentity.laneKind === 'secondary' &&
      laneIdentity.laneOwnerProviderId === 'opencode'
    ) {
      let recovered = await this.deps.tryRecoverOpenCodeRuntimeLaneBeforeDelivery({
        teamName,
        laneId: laneIdentity.laneId,
        member: {
          ...(configMember ?? {}),
          ...(metaMember ?? {}),
          name: canonicalMemberName,
          providerId: 'opencode',
          model: metaMember?.model ?? configMember?.model,
          role: metaMember?.role ?? configMember?.role,
          workflow: metaMember?.workflow ?? configMember?.workflow,
          effort: metaMember?.effort ?? configMember?.effort,
          cwd: memberRuntimeCwd || undefined,
          isolation: metaMember?.isolation ?? configMember?.isolation,
        },
        projectPath:
          config?.projectPath?.trim() || this.deps.readPersistedTeamProjectPath(teamName),
      });
      if (!recovered) {
        recovered = await this.deps.tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery(
          {
            teamName,
            laneId: laneIdentity.laneId,
            member: {
              ...(configMember ?? {}),
              ...(metaMember ?? {}),
              name: canonicalMemberName,
              providerId: 'opencode',
              model: metaMember?.model ?? configMember?.model,
              role: metaMember?.role ?? configMember?.role,
              workflow: metaMember?.workflow ?? configMember?.workflow,
              effort: metaMember?.effort ?? configMember?.effort,
              cwd: memberRuntimeCwd || undefined,
              isolation: metaMember?.isolation ?? configMember?.isolation,
            },
            projectPath:
              config?.projectPath?.trim() || this.deps.readPersistedTeamProjectPath(teamName),
          }
        );
      }
      if (recovered) {
        runtimeRunId = await this.deps.resolveCurrentOpenCodeRuntimeRunId(
          teamName,
          laneIdentity.laneId
        );
        runtimeActive = await this.deps.isOpenCodeRuntimeLaneIndexActive(
          teamName,
          laneIdentity.laneId
        );
      }
    }
    if (
      runtimeActive &&
      runtimeRunId &&
      laneIdentity.laneKind === 'secondary' &&
      laneIdentity.laneOwnerProviderId === 'opencode' &&
      !liveSecondaryLaneRunId &&
      !inMemorySecondaryLaneRunId
    ) {
      const laneStorage = await inspectOpenCodeRuntimeLaneStorage({
        teamsBasePath: getTeamsBasePath(),
        teamName,
        laneId: laneIdentity.laneId,
      });
      const staleLane = await recoverStaleOpenCodeRuntimeLaneIndexEntry({
        teamsBasePath: getTeamsBasePath(),
        teamName,
        laneId: laneIdentity.laneId,
      });
      if (!laneStorage.hasRuntimeEvidenceOnDisk) {
        if (staleLane.stale) {
          this.deps.deleteSecondaryRuntimeRun(teamName, laneIdentity.laneId);
        }
        return {
          delivered: false,
          reason: 'opencode_runtime_not_active',
          diagnostics: staleLane.diagnostics.length
            ? staleLane.diagnostics
            : [
                `OpenCode runtime bootstrap evidence is not ready for ${canonicalMemberName}. ` +
                  'Message was saved and will be retried after runtime check-in.',
              ],
        };
      }
    }
    if (!runtimeActive) {
      this.deps.cleanupStoppedTeamOpenCodeRuntimeLanesInBackground(teamName);
      return { delivered: false, reason: 'opencode_runtime_not_active' };
    }

    let legacyOpenCodeBootstrapSessionToStamp: OpenCodeCommittedBootstrapSessionRecord | null =
      null;
    let refreshedOpenCodeBootstrapSessionToStamp: OpenCodeCommittedBootstrapSessionRecord | null =
      null;
    let forceOpenCodeSessionRefreshReason: string | undefined;
    if (laneIdentity.laneOwnerProviderId === 'opencode') {
      const bootstrapSession =
        await this.deps.findDeliverableOpenCodeRuntimeBootstrapSessionEvidence({
          teamName,
          runId: runtimeRunId,
          laneId: laneIdentity.laneId,
          memberName: canonicalMemberName,
        });
      if (!bootstrapSession) {
        if (laneIdentity.laneKind === 'secondary') {
          return {
            delivered: false,
            reason: 'opencode_runtime_not_active',
            diagnostics: [
              `OpenCode runtime bootstrap is not confirmed for ${canonicalMemberName}. ` +
                'Message was saved and will be retried after runtime check-in.',
            ],
          };
        }
      } else {
        if (!bootstrapSession.appMcpTransportHash?.trim()) {
          legacyOpenCodeBootstrapSessionToStamp = bootstrapSession;
        }
        const appMcpTransportMismatch =
          this.deps.getOpenCodeAppMcpTransportMismatchDiagnostic(bootstrapSession);
        if (appMcpTransportMismatch) {
          refreshedOpenCodeBootstrapSessionToStamp = bootstrapSession;
          forceOpenCodeSessionRefreshReason = appMcpTransportMismatch;
          logger.info(
            `[${teamName}] OpenCode delivery detected stale app MCP transport for ` +
              `${canonicalMemberName}; requesting bridge session refresh before send. ` +
              appMcpTransportMismatch
          );
        }
      }
    }

    let openCodeFileParts: OpenCodeFilePart[] = [];
    if (input.attachments?.length && laneIdentity.laneOwnerProviderId === 'opencode') {
      try {
        openCodeFileParts = buildOpenCodeAttachmentDeliveryParts({
          text: input.text,
          model: metaMember?.model ?? configMember?.model ?? '',
          attachments: input.attachments,
        }).fileParts;
      } catch (error) {
        const reason =
          error instanceof AgentAttachmentError
            ? error.code
            : 'opencode_attachment_delivery_prepare_failed';
        const diagnostic = `opencode_attachment_delivery_prepare_failed: ${getErrorMessage(error)}`;
        const userVisibleMessage =
          error instanceof AgentAttachmentError
            ? error.message
            : 'OpenCode could not prepare the attachment for live delivery.';
        return {
          delivered: false,
          reason,
          diagnostics: [diagnostic],
          userVisibleImpact: {
            state: 'error',
            reasonCode: 'backend_error',
            message: userVisibleMessage,
          },
        };
      }
    }

    if (!this.deps.openCodePromptDeliveryWatchdogScheduler.isEnabled()) {
      const controlUrl =
        input.messageKind === 'member_work_sync_nudge'
          ? await this.deps.resolveControlApiBaseUrl()
          : null;
      const result = await this.deps.sendOpenCodeMemberMessageToRuntimeSerialized({
        teamName,
        laneId: laneIdentity.laneId,
        send: async () =>
          await adapter.sendMessageToMember({
            ...(runtimeRunId ? { runId: runtimeRunId } : {}),
            teamName,
            laneId: laneIdentity.laneId,
            memberName: canonicalMemberName,
            cwd,
            text: input.text,
            messageId: input.messageId,
            fileParts: openCodeFileParts,
            replyRecipient: input.replyRecipient,
            actionMode: input.actionMode,
            messageKind: input.messageKind,
            workSyncIntent: input.workSyncIntent,
            workSyncReviewRequestEventIds: input.workSyncReviewRequestEventIds,
            controlUrl: controlUrl ?? undefined,
            taskRefs: input.taskRefs,
            forceSessionRefreshReason: forceOpenCodeSessionRefreshReason,
          }),
      });
      await this.deps.rememberOpenCodeRuntimePidFromBridge({
        teamName,
        memberName: canonicalMemberName,
        laneId: laneIdentity.laneId,
        runId: runtimeRunId,
        runtimeSessionId: result.sessionId,
        runtimePid: result.runtimePid,
        reason: 'opencode_delivery_runtime_pid_observed',
      });
      if (result.ok && legacyOpenCodeBootstrapSessionToStamp) {
        await this.deps.stampOpenCodeAppMcpTransportEvidenceIfMissing(
          legacyOpenCodeBootstrapSessionToStamp
        );
      }
      if (result.ok && result.sessionId && refreshedOpenCodeBootstrapSessionToStamp) {
        await this.deps.stampOpenCodeAppMcpTransportEvidenceIfMissing(
          refreshedOpenCodeBootstrapSessionToStamp,
          {
            overwriteExistingHash: true,
            runtimeSessionId: result.sessionId,
          }
        );
      }
      const responseObservation = normalizeOpenCodeDeliveryResponseObservation(
        result.responseObservation
      );
      await this.deps.maybeSyncOpenCodeRuntimePermissionsAfterDelivery({
        teamName,
        runId: runtimeRunId,
        laneId: laneIdentity.laneId,
        memberName: canonicalMemberName,
        cwd,
        sessionId: result.sessionId,
        responseState: responseObservation?.state,
        reason: responseObservation?.reason ?? result.diagnostics[0],
        diagnostics: result.diagnostics,
        teamColor: config?.color,
        teamDisplayName: config?.name,
      });
      const legacyWorkSyncReadAllowed =
        input.messageKind === 'member_work_sync_nudge' && result.ok
          ? await this.deps.isLegacyOpenCodeMemberWorkSyncReadCommitAllowed({
              teamName,
              memberName: canonicalMemberName,
              workSyncIntent: input.workSyncIntent,
              responseObservation,
            })
          : true;
      const legacyWorkSyncResponsePending =
        result.ok && input.messageKind === 'member_work_sync_nudge' && !legacyWorkSyncReadAllowed;
      return {
        delivered: result.ok,
        accepted: result.ok,
        responsePending: legacyWorkSyncResponsePending,
        responseState: responseObservation?.state,
        ...(legacyWorkSyncResponsePending
          ? { reason: responseObservation?.reason ?? 'member_work_sync_report_required' }
          : result.ok
            ? {}
            : { reason: result.diagnostics[0] ?? 'opencode_message_delivery_failed' }),
        diagnostics: result.diagnostics,
      };
    }

    const messageId = input.messageId?.trim();
    const ledger = messageId
      ? this.deps.createOpenCodePromptDeliveryLedger(teamName, laneIdentity.laneId)
      : null;
    const now = nowIso();
    let active = ledger
      ? await ledger.getActiveForMember({
          teamName,
          memberName: canonicalMemberName,
          laneId: laneIdentity.laneId,
        })
      : null;
    if (active && active.inboxMessageId !== messageId && ledger) {
      let proof = await this.deps.openCodeVisibleReplyProofService.applyDestinationProof({
        ledger,
        ledgerRecord: active,
        teamName,
        replyRecipient: active.replyRecipient,
        memberName: canonicalMemberName,
      });
      active = proof.ledgerRecord;
      proof = await this.deps.openCodeVisibleReplyProofService.materializePlainTextReplyIfNeeded({
        ledger,
        ledgerRecord: active,
        teamName,
        memberName: canonicalMemberName,
        visibleReply: proof.visibleReply,
      });
      active = proof.ledgerRecord;
      const activeReadAllowed = await this.deps.isOpenCodeDeliveryResponseReadCommitAllowed({
        teamName,
        memberName: canonicalMemberName,
        responseState: active.responseState,
        actionMode: active.actionMode ?? undefined,
        taskRefs: active.taskRefs,
        visibleReply: proof.visibleReply,
        ledgerRecord: active,
      });
      if (activeReadAllowed) {
        this.deps.logOpenCodePromptDeliveryEvent(
          'opencode_prompt_delivery_response_observed',
          active,
          {
            visibleReplySemanticallySufficient: true,
            unblockedNextDelivery: true,
          }
        );
        active = null;
      } else if (isOpenCodeAcceptedDeliveryMissingPromptProof(active)) {
        active = await this.deps.markOpenCodeAcceptedDeliveryMissingPromptProofForRetry({
          ledger,
          ledgerRecord: active,
          eventContext: { recoveredActiveBlocker: true },
        });
        this.deps.scheduleOpenCodePromptDeliveryWatchdog({
          teamName,
          memberName: canonicalMemberName,
          messageId: active.inboxMessageId,
          delayMs: 500,
        });
      }
    }
    if (active && active.inboxMessageId !== messageId) {
      const activeDueMs = active.nextAttemptAt ? Date.parse(active.nextAttemptAt) : NaN;
      this.deps.scheduleOpenCodePromptDeliveryWatchdog({
        teamName,
        memberName: canonicalMemberName,
        messageId: active.inboxMessageId,
        delayMs: Number.isFinite(activeDueMs)
          ? Math.max(500, activeDueMs - Date.now())
          : OPENCODE_PROMPT_DELIVERY_OBSERVE_DELAY_MS,
      });
      return {
        delivered: true,
        accepted: false,
        responsePending: true,
        responseState: active.responseState,
        ledgerStatus: active.status,
        ledgerRecordId: active.id,
        laneId: laneIdentity.laneId,
        queuedBehindMessageId: active.inboxMessageId,
        reason: 'opencode_delivery_response_pending',
        diagnostics: [`OpenCode delivery is queued behind ${active.inboxMessageId}.`],
      };
    }

    let ledgerRecord = messageId
      ? await ledger?.ensurePending({
          teamName,
          memberName: canonicalMemberName,
          laneId: laneIdentity.laneId,
          runId: runtimeRunId ?? null,
          inboxMessageId: messageId,
          inboxTimestamp: input.inboxTimestamp ?? now,
          source: input.source ?? 'manual',
          replyRecipient: input.replyRecipient ?? 'user',
          actionMode: input.actionMode ?? null,
          messageKind: input.messageKind ?? null,
          workSyncIntent: input.workSyncIntent ?? null,
          taskRefs: input.taskRefs ?? [],
          payloadHash: hashOpenCodePromptDeliveryPayload({
            text: input.text,
            replyRecipient: input.replyRecipient ?? 'user',
            actionMode: input.actionMode ?? null,
            taskRefs: input.taskRefs ?? [],
            attachments: input.attachments,
            source: input.source,
          }),
          now,
        })
      : null;
    if (ledgerRecord?.createdAt === now) {
      this.deps.logOpenCodePromptDeliveryEvent(
        'opencode_prompt_delivery_ledger_created',
        ledgerRecord
      );
    }
    const deliveryAttemptId = ledgerRecord
      ? buildOpenCodePromptDeliveryAttemptId(ledgerRecord)
      : undefined;

    if (ledgerRecord && ledger && messageId) {
      let proof = await this.deps.openCodeVisibleReplyProofService.applyDestinationProof({
        ledger,
        ledgerRecord,
        teamName,
        replyRecipient: input.replyRecipient,
        memberName: canonicalMemberName,
      });
      ledgerRecord = proof.ledgerRecord;
      proof = await this.deps.openCodeVisibleReplyProofService.materializePlainTextReplyIfNeeded({
        ledger,
        ledgerRecord,
        teamName,
        memberName: canonicalMemberName,
        visibleReply: proof.visibleReply,
      });
      ledgerRecord = proof.ledgerRecord;
      let readAllowed = await this.deps.isOpenCodeDeliveryResponseReadCommitAllowed({
        teamName,
        memberName: canonicalMemberName,
        responseState: ledgerRecord.responseState,
        actionMode: ledgerRecord.actionMode ?? undefined,
        taskRefs: ledgerRecord.taskRefs,
        visibleReply: proof.visibleReply,
        ledgerRecord,
      });
      if (readAllowed) {
        this.deps.logOpenCodePromptDeliveryEvent(
          'opencode_prompt_delivery_response_observed',
          ledgerRecord,
          { visibleReplySemanticallySufficient: true }
        );
        return {
          delivered: true,
          accepted: true,
          responsePending: false,
          responseState: ledgerRecord.responseState,
          ledgerStatus: ledgerRecord.status,
          ledgerRecordId: ledgerRecord.id,
          laneId: laneIdentity.laneId,
          visibleReplyMessageId: ledgerRecord.visibleReplyMessageId ?? undefined,
          visibleReplyCorrelation: ledgerRecord.visibleReplyCorrelation ?? undefined,
          diagnostics: ledgerRecord.diagnostics,
        };
      }

      ledgerRecord = await this.deps.requeueOpenCodeRuntimeManifestWatermarkDeliveryIfNeeded({
        ledger,
        ledgerRecord,
      });

      if (ledgerRecord.status === 'failed_terminal') {
        this.deps.logOpenCodePromptDeliveryEvent(
          'opencode_prompt_delivery_terminal_failure',
          ledgerRecord
        );
        return {
          delivered: false,
          accepted: false,
          responsePending: false,
          responseState: ledgerRecord.responseState,
          ledgerStatus: ledgerRecord.status,
          ledgerRecordId: ledgerRecord.id,
          laneId: laneIdentity.laneId,
          reason: ledgerRecord.lastReason ?? 'opencode_prompt_delivery_failed_terminal',
          diagnostics: ledgerRecord.diagnostics,
        };
      }

      let attemptDue = isOpenCodePromptDeliveryAttemptDue(ledgerRecord);
      if (isOpenCodeAcceptedDeliveryMissingPromptProof(ledgerRecord)) {
        ledgerRecord = await this.deps.markOpenCodeAcceptedDeliveryMissingPromptProofForRetry({
          ledger,
          ledgerRecord,
        });
        attemptDue = true;
      }
      if (ledgerRecord.status !== 'pending' && !attemptDue) {
        const nextAttemptMs = ledgerRecord.nextAttemptAt
          ? Date.parse(ledgerRecord.nextAttemptAt)
          : NaN;
        const accepted = hasOpenCodeAcceptedRuntimePrompt(ledgerRecord);
        const acceptanceUnknown = Boolean(ledgerRecord.acceptanceUnknown && !accepted);
        this.deps.scheduleOpenCodePromptDeliveryWatchdog({
          teamName,
          memberName: canonicalMemberName,
          messageId,
          delayMs: Number.isFinite(nextAttemptMs)
            ? Math.max(500, nextAttemptMs - Date.now())
            : OPENCODE_PROMPT_DELIVERY_OBSERVE_DELAY_MS,
        });
        return {
          delivered: accepted || acceptanceUnknown,
          accepted,
          responsePending: true,
          responseState: ledgerRecord.responseState,
          ledgerStatus: ledgerRecord.status,
          ledgerRecordId: ledgerRecord.id,
          laneId: laneIdentity.laneId,
          ...(acceptanceUnknown ? { acceptanceUnknown: true } : {}),
          visibleReplyMessageId: ledgerRecord.visibleReplyMessageId ?? undefined,
          visibleReplyCorrelation: ledgerRecord.visibleReplyCorrelation ?? undefined,
          reason: ledgerRecord.lastReason ?? 'opencode_delivery_response_pending',
          diagnostics: ledgerRecord.diagnostics,
        };
      }

      const retryDueBeforeObserve = isOpenCodePromptDeliveryRetryAttemptDue({
        attemptDue,
        ledgerRecord,
      });
      const hasAcceptedRuntimePromptBeforeObserve = hasOpenCodeAcceptedRuntimePrompt(ledgerRecord);
      if (
        ledgerRecord.status !== 'pending' &&
        !adapter.observeMessageDelivery &&
        (!retryDueBeforeObserve || hasAcceptedRuntimePromptBeforeObserve)
      ) {
        const accepted = hasAcceptedRuntimePromptBeforeObserve;
        const acceptanceUnknown = Boolean(ledgerRecord.acceptanceUnknown && !accepted);
        return {
          delivered: accepted || acceptanceUnknown,
          accepted,
          responsePending: true,
          responseState: ledgerRecord.responseState,
          ledgerStatus: ledgerRecord.status,
          ledgerRecordId: ledgerRecord.id,
          laneId: laneIdentity.laneId,
          ...(acceptanceUnknown ? { acceptanceUnknown: true } : {}),
          reason: acceptanceUnknown
            ? (ledgerRecord.lastReason ?? 'opencode_delivery_acceptance_unknown')
            : 'opencode_delivery_observe_bridge_unavailable',
          diagnostics: [
            ...ledgerRecord.diagnostics,
            'OpenCode message delivery observe bridge is unavailable.',
          ],
        };
      }

      const retryShouldRefreshSessionBeforeObserve =
        retryDueBeforeObserve &&
        ledgerRecord.status === 'retry_scheduled' &&
        !hasOpenCodeAcceptedRuntimePrompt(ledgerRecord) &&
        isOpenCodeSessionRefreshRetryRecord(ledgerRecord, ledgerRecord.lastReason);
      if (
        ledgerRecord.status !== 'pending' &&
        adapter.observeMessageDelivery &&
        !retryShouldRefreshSessionBeforeObserve
      ) {
        const observed = await adapter.observeMessageDelivery({
          ...(runtimeRunId ? { runId: runtimeRunId } : {}),
          teamName,
          laneId: laneIdentity.laneId,
          memberName: canonicalMemberName,
          cwd,
          text: input.text,
          messageId,
          replyRecipient: input.replyRecipient,
          actionMode: input.actionMode,
          messageKind: input.messageKind,
          workSyncIntent: input.workSyncIntent,
          workSyncReviewRequestEventIds: input.workSyncReviewRequestEventIds,
          taskRefs: input.taskRefs,
          prePromptCursor: ledgerRecord.prePromptCursor,
          sessionId: ledgerRecord.runtimeSessionId ?? undefined,
          runtimePromptMessageId:
            ledgerRecord.lastRuntimePromptMessageId ??
            ledgerRecord.runtimePromptMessageId ??
            undefined,
        });
        await this.deps.rememberOpenCodeRuntimePidFromBridge({
          teamName,
          memberName: canonicalMemberName,
          laneId: laneIdentity.laneId,
          runId: runtimeRunId,
          runtimeSessionId: observed.sessionId,
          runtimePid: observed.runtimePid,
          reason: 'opencode_delivery_observe_runtime_pid_observed',
        });
        const responseObservation = normalizeOpenCodeDeliveryResponseObservation(
          observed.responseObservation
        );
        await this.deps.maybeSyncOpenCodeRuntimePermissionsAfterDelivery({
          teamName,
          runId: runtimeRunId,
          laneId: laneIdentity.laneId,
          memberName: canonicalMemberName,
          cwd,
          sessionId: observed.sessionId,
          responseState: responseObservation?.state,
          reason: responseObservation?.reason ?? observed.diagnostics[0],
          diagnostics: observed.diagnostics,
          teamColor: config?.color,
          teamDisplayName: config?.name,
        });
        ledgerRecord = await ledger.applyObservation({
          id: ledgerRecord.id,
          responseObservation: responseObservation ?? {
            state: observed.ok ? 'not_observed' : 'reconcile_failed',
            deliveredUserMessageId: null,
            assistantMessageId: null,
            toolCallNames: [],
            visibleMessageToolCallId: null,
            visibleReplyMessageId: null,
            visibleReplyCorrelation: null,
            latestAssistantPreview: null,
            reason: observed.diagnostics[0] ?? null,
          },
          sessionId: observed.sessionId,
          runtimePromptMessageId: observed.runtimePromptMessageId,
          diagnostics: observed.diagnostics,
          observedAt: nowIso(),
        });
        proof = await this.deps.openCodeVisibleReplyProofService.applyDestinationProof({
          ledger,
          ledgerRecord,
          teamName,
          replyRecipient: input.replyRecipient,
          memberName: canonicalMemberName,
        });
        ledgerRecord = proof.ledgerRecord;
        proof = await this.deps.openCodeVisibleReplyProofService.materializePlainTextReplyIfNeeded({
          ledger,
          ledgerRecord,
          teamName,
          memberName: canonicalMemberName,
          visibleReply: proof.visibleReply,
        });
        ledgerRecord = proof.ledgerRecord;
        readAllowed = await this.deps.isOpenCodeDeliveryResponseReadCommitAllowed({
          teamName,
          memberName: canonicalMemberName,
          responseState: ledgerRecord.responseState,
          actionMode: ledgerRecord.actionMode ?? undefined,
          taskRefs: ledgerRecord.taskRefs,
          visibleReply: proof.visibleReply,
          ledgerRecord,
        });
        if (readAllowed) {
          this.deps.logOpenCodePromptDeliveryEvent(
            'opencode_prompt_delivery_response_observed',
            ledgerRecord,
            { visibleReplySemanticallySufficient: true }
          );
          return {
            delivered: true,
            accepted: true,
            responsePending: false,
            responseState: ledgerRecord.responseState,
            ledgerStatus: ledgerRecord.status,
            ledgerRecordId: ledgerRecord.id,
            laneId: laneIdentity.laneId,
            visibleReplyMessageId: ledgerRecord.visibleReplyMessageId ?? undefined,
            visibleReplyCorrelation: ledgerRecord.visibleReplyCorrelation ?? undefined,
            diagnostics: ledgerRecord.diagnostics,
          };
        }

        const pendingReason = this.deps.getOpenCodeDeliveryPendingReason({
          responseState: ledgerRecord.responseState,
          actionMode: ledgerRecord.actionMode,
          taskRefs: ledgerRecord.taskRefs,
          visibleReply: proof.visibleReply,
          ledgerRecord,
        });
        const retryable = isOpenCodeDeliveryRetryablePendingResponse({
          ledgerRecord,
          visibleReply: proof.visibleReply,
          readAllowed,
        });
        const retryDue = retryDueBeforeObserve;
        if (
          retryDue &&
          retryable &&
          isOpenCodeSessionRefreshRetryRecord(ledgerRecord, pendingReason)
        ) {
          ledgerRecord = await this.deps.openCodePromptDeliveryFollowUpPolicy.schedule({
            ledger,
            ledgerRecord,
            teamName,
            memberName: canonicalMemberName,
            retry: true,
            reason: pendingReason,
          });
          if (ledgerRecord.status === 'failed_terminal') {
            return {
              delivered: false,
              accepted: true,
              responsePending: false,
              responseState: ledgerRecord.responseState,
              ledgerStatus: ledgerRecord.status,
              ledgerRecordId: ledgerRecord.id,
              laneId: laneIdentity.laneId,
              visibleReplyMessageId: ledgerRecord.visibleReplyMessageId ?? undefined,
              visibleReplyCorrelation: ledgerRecord.visibleReplyCorrelation ?? undefined,
              reason: ledgerRecord.lastReason ?? 'opencode_prompt_delivery_failed_terminal',
              diagnostics: ledgerRecord.diagnostics.length
                ? ledgerRecord.diagnostics
                : [ledgerRecord.lastReason ?? 'opencode_prompt_delivery_failed_terminal'],
            };
          }
          return {
            delivered: true,
            accepted: true,
            responsePending: true,
            responseState: ledgerRecord.responseState,
            ledgerStatus: ledgerRecord.status,
            ledgerRecordId: ledgerRecord.id,
            laneId: laneIdentity.laneId,
            visibleReplyMessageId: ledgerRecord.visibleReplyMessageId ?? undefined,
            visibleReplyCorrelation: ledgerRecord.visibleReplyCorrelation ?? undefined,
            reason: ledgerRecord.lastReason ?? 'opencode_delivery_response_pending',
            diagnostics: ledgerRecord.diagnostics,
          };
        }
        if (!retryDue || !retryable) {
          ledgerRecord = await this.deps.openCodePromptDeliveryFollowUpPolicy.schedule({
            ledger,
            ledgerRecord,
            teamName,
            memberName: canonicalMemberName,
            retry: retryable,
            reason: pendingReason,
          });
          if (ledgerRecord.status === 'failed_terminal') {
            return {
              delivered: false,
              accepted: true,
              responsePending: false,
              responseState: ledgerRecord.responseState,
              ledgerStatus: ledgerRecord.status,
              ledgerRecordId: ledgerRecord.id,
              laneId: laneIdentity.laneId,
              visibleReplyMessageId: ledgerRecord.visibleReplyMessageId ?? undefined,
              visibleReplyCorrelation: ledgerRecord.visibleReplyCorrelation ?? undefined,
              reason: ledgerRecord.lastReason ?? 'opencode_prompt_delivery_failed_terminal',
              diagnostics: ledgerRecord.diagnostics.length
                ? ledgerRecord.diagnostics
                : [ledgerRecord.lastReason ?? 'opencode_prompt_delivery_failed_terminal'],
            };
          }
          return {
            delivered: true,
            accepted: true,
            responsePending: true,
            responseState: ledgerRecord.responseState,
            ledgerStatus: ledgerRecord.status,
            ledgerRecordId: ledgerRecord.id,
            laneId: laneIdentity.laneId,
            visibleReplyMessageId: ledgerRecord.visibleReplyMessageId ?? undefined,
            visibleReplyCorrelation: ledgerRecord.visibleReplyCorrelation ?? undefined,
            reason: ledgerRecord.lastReason ?? 'opencode_delivery_response_pending',
            diagnostics: ledgerRecord.diagnostics,
          };
        }
      }
    }

    const retryReadAllowed = ledgerRecord
      ? await this.deps.isOpenCodeDeliveryResponseReadCommitAllowed({
          teamName,
          memberName: canonicalMemberName,
          responseState: ledgerRecord.responseState,
          actionMode: ledgerRecord.actionMode ?? undefined,
          taskRefs: ledgerRecord.taskRefs,
          visibleReply: null,
          ledgerRecord,
        })
      : false;
    const retryPendingReason = ledgerRecord
      ? this.deps.getOpenCodeDeliveryPendingReason({
          responseState: ledgerRecord.responseState,
          actionMode: ledgerRecord.actionMode,
          taskRefs: ledgerRecord.taskRefs,
          visibleReply: null,
          ledgerRecord,
        })
      : 'opencode_delivery_response_pending';
    const controlUrl =
      input.messageKind === 'member_work_sync_nudge'
        ? await this.deps.resolveControlApiBaseUrl()
        : null;
    if (
      !forceOpenCodeSessionRefreshReason &&
      ledgerRecord?.status === 'retry_scheduled' &&
      !hasOpenCodeAcceptedRuntimePrompt(ledgerRecord) &&
      isOpenCodePromptDeliveryAttemptDue(ledgerRecord) &&
      isOpenCodeSessionRefreshRetryRecord(ledgerRecord, ledgerRecord.lastReason)
    ) {
      forceOpenCodeSessionRefreshReason =
        ledgerRecord.lastSessionRefreshReason ??
        ledgerRecord.lastReason ??
        ledgerRecord.responseState ??
        'session_stale';
    }
    const deliveryText = buildOpenCodePromptDeliveryAttemptText({
      text: input.text,
      controlText: buildOpenCodePromptDeliveryRepairControlText({
        ledgerRecord,
        readAllowed: retryReadAllowed,
        pendingReason: retryPendingReason,
        controlUrl,
      }),
    });
    let result: OpenCodeTeamRuntimeMessageResult;
    try {
      result = await this.deps.sendOpenCodeMemberMessageToRuntimeSerialized({
        teamName,
        laneId: laneIdentity.laneId,
        send: async () =>
          await adapter.sendMessageToMember({
            ...(runtimeRunId ? { runId: runtimeRunId } : {}),
            teamName,
            laneId: laneIdentity.laneId,
            memberName: canonicalMemberName,
            cwd,
            text: deliveryText,
            messageId: input.messageId,
            deliveryAttemptId,
            fileParts: openCodeFileParts,
            replyRecipient: input.replyRecipient,
            actionMode: input.actionMode,
            messageKind: input.messageKind,
            workSyncIntent: input.workSyncIntent,
            workSyncReviewRequestEventIds: input.workSyncReviewRequestEventIds,
            controlUrl: controlUrl ?? undefined,
            taskRefs: input.taskRefs,
            forceSessionRefreshReason: forceOpenCodeSessionRefreshReason,
          }),
      });
    } catch (error) {
      const diagnostic = `opencode_message_delivery_exception: ${getErrorMessage(error)}`;
      await this.deps.maybeSyncOpenCodeRuntimePermissionsAfterDelivery({
        teamName,
        runId: runtimeRunId,
        laneId: laneIdentity.laneId,
        memberName: canonicalMemberName,
        cwd,
        reason: diagnostic,
        diagnostics: [diagnostic],
        teamColor: config?.color,
        teamDisplayName: config?.name,
      });
      if (ledgerRecord && ledger) {
        ledgerRecord = await ledger.applyDeliveryResult({
          id: ledgerRecord.id,
          accepted: false,
          attempted: true,
          responseObservation: {
            state: 'reconcile_failed',
            deliveredUserMessageId: null,
            assistantMessageId: null,
            toolCallNames: [],
            visibleMessageToolCallId: null,
            visibleReplyMessageId: null,
            visibleReplyCorrelation: null,
            latestAssistantPreview: null,
            reason: diagnostic,
          },
          deliveryAttemptId,
          prePromptCursor: ledgerRecord.prePromptCursor,
          diagnostics: [diagnostic],
          reason: diagnostic,
          now: nowIso(),
        });
        this.deps.emitOpenCodePromptDeliveryTaskLogChange(
          ledgerRecord,
          'opencode-prompt-delivery-send-exception'
        );
        ledgerRecord = await this.deps.openCodePromptDeliveryFollowUpPolicy.schedule({
          ledger,
          ledgerRecord,
          teamName,
          memberName: canonicalMemberName,
          retry: true,
          reason: diagnostic,
        });
        const terminalFailure = ledgerRecord.status === 'failed_terminal';
        return {
          delivered: false,
          accepted: false,
          responsePending: !terminalFailure,
          responseState: ledgerRecord.responseState,
          ledgerStatus: ledgerRecord.status,
          ledgerRecordId: ledgerRecord.id,
          laneId: laneIdentity.laneId,
          reason: terminalFailure ? (ledgerRecord.lastReason ?? diagnostic) : diagnostic,
          diagnostics: ledgerRecord.diagnostics.length
            ? ledgerRecord.diagnostics
            : [terminalFailure ? (ledgerRecord.lastReason ?? diagnostic) : diagnostic],
        };
      }
      return {
        delivered: false,
        accepted: false,
        responsePending: false,
        reason: diagnostic,
        diagnostics: [diagnostic],
      };
    }
    await this.deps.rememberOpenCodeRuntimePidFromBridge({
      teamName,
      memberName: canonicalMemberName,
      laneId: laneIdentity.laneId,
      runId: runtimeRunId,
      runtimeSessionId: result.sessionId,
      runtimePid: result.runtimePid,
      reason: 'opencode_delivery_runtime_pid_observed',
    });
    if (result.ok && legacyOpenCodeBootstrapSessionToStamp) {
      await this.deps.stampOpenCodeAppMcpTransportEvidenceIfMissing(
        legacyOpenCodeBootstrapSessionToStamp
      );
    }
    if (result.ok && result.sessionId && refreshedOpenCodeBootstrapSessionToStamp) {
      await this.deps.stampOpenCodeAppMcpTransportEvidenceIfMissing(
        refreshedOpenCodeBootstrapSessionToStamp,
        {
          overwriteExistingHash: true,
          runtimeSessionId: result.sessionId,
        }
      );
    }
    const responseObservation = normalizeOpenCodeDeliveryResponseObservation(
      result.responseObservation
    );
    await this.deps.maybeSyncOpenCodeRuntimePermissionsAfterDelivery({
      teamName,
      runId: runtimeRunId,
      laneId: laneIdentity.laneId,
      memberName: canonicalMemberName,
      cwd,
      sessionId: result.sessionId,
      responseState: responseObservation?.state,
      reason: responseObservation?.reason ?? result.diagnostics[0],
      diagnostics: result.diagnostics,
      teamColor: config?.color,
      teamDisplayName: config?.name,
    });
    const promptAcceptedByRuntimeIdentity = Boolean(
      result.ok && result.runtimePromptMessageId?.trim()
    );
    const promptAcceptedByObservation = isOpenCodePromptAcceptedByObservation(responseObservation);
    const promptAccepted = promptAcceptedByRuntimeIdentity || promptAcceptedByObservation;
    const promptAcceptanceMissingRuntimePromptId =
      result.ok && !promptAcceptedByRuntimeIdentity && !promptAcceptedByObservation;
    const deliveryDiagnostics = promptAcceptanceMissingRuntimePromptId
      ? [...result.diagnostics, 'opencode_prompt_acceptance_missing_runtime_prompt_id']
      : result.diagnostics;
    if (ledgerRecord && ledger) {
      ledgerRecord = await ledger.applyDeliveryResult({
        id: ledgerRecord.id,
        accepted: promptAccepted,
        attempted: true,
        responseObservation,
        sessionId: result.sessionId,
        runtimePromptMessageId: result.runtimePromptMessageId,
        deliveryAttemptId,
        prePromptCursor: result.prePromptCursor,
        diagnostics: deliveryDiagnostics,
        reason: promptAccepted ? responseObservation?.reason : deliveryDiagnostics[0],
        now: nowIso(),
      });
      this.deps.emitOpenCodePromptDeliveryTaskLogChange(
        ledgerRecord,
        'opencode-prompt-delivery-session-evidence'
      );
      let proof = await this.deps.openCodeVisibleReplyProofService.applyDestinationProof({
        ledger,
        ledgerRecord,
        teamName,
        replyRecipient: input.replyRecipient,
        memberName: canonicalMemberName,
      });
      ledgerRecord = proof.ledgerRecord;
      proof = await this.deps.openCodeVisibleReplyProofService.materializePlainTextReplyIfNeeded({
        ledger,
        ledgerRecord,
        teamName,
        memberName: canonicalMemberName,
        visibleReply: proof.visibleReply,
      });
      ledgerRecord = proof.ledgerRecord;
      proof = await this.deps.observeOpenCodeDirectUserDeliveryInlineIfNeeded({
        adapter,
        ledger,
        ledgerRecord,
        teamName,
        memberName: canonicalMemberName,
        laneId: laneIdentity.laneId,
        cwd,
        text: input.text,
        messageId: ledgerRecord.inboxMessageId,
        runtimeRunId,
        replyRecipient: input.replyRecipient,
        actionMode: input.actionMode,
        messageKind: input.messageKind,
        workSyncIntent: input.workSyncIntent,
        workSyncReviewRequestEventIds: input.workSyncReviewRequestEventIds,
        taskRefs: input.taskRefs,
        promptAccepted,
        visibleReply: proof.visibleReply,
      });
      ledgerRecord = proof.ledgerRecord;
      this.deps.logOpenCodePromptDeliveryEvent(
        promptAccepted
          ? ledgerRecord.status === 'unanswered'
            ? 'opencode_prompt_delivery_unanswered'
            : ledgerRecord.status === 'responded'
              ? 'opencode_prompt_delivery_response_observed'
              : 'opencode_prompt_delivery_prompt_accepted'
          : 'opencode_prompt_delivery_retry_scheduled',
        ledgerRecord,
        {
          accepted: promptAccepted,
          reason: ledgerRecord.lastReason ?? deliveryDiagnostics[0] ?? null,
        }
      );
    }
    const responseState = ledgerRecord?.responseState ?? responseObservation?.state;
    const visibleReply = ledgerRecord
      ? await this.deps.openCodeVisibleReplyProofService.findByRelayOfMessageId({
          teamName,
          replyRecipient: input.replyRecipient ?? ledgerRecord.replyRecipient,
          from: canonicalMemberName,
          relayOfMessageId: ledgerRecord.inboxMessageId,
          expectedMessageId:
            ledgerRecord.visibleReplyCorrelation === 'relayOfMessageId'
              ? ledgerRecord.visibleReplyMessageId
              : null,
          allowUserFallbackForLeadRecipient:
            ledgerRecord.visibleReplyCorrelation === 'relayOfMessageId',
        })
      : null;
    const readAllowed = await this.deps.isOpenCodeDeliveryResponseReadCommitAllowed({
      teamName,
      memberName: canonicalMemberName,
      responseState,
      actionMode: input.actionMode,
      taskRefs: input.taskRefs,
      visibleReply,
      ledgerRecord,
    });
    if (ledgerRecord && promptAccepted && !readAllowed) {
      const retry = isOpenCodeDeliveryRetryablePendingResponse({
        ledgerRecord,
        visibleReply,
        readAllowed,
      });
      ledgerRecord = await this.deps.openCodePromptDeliveryFollowUpPolicy.schedule({
        ledger: ledger!,
        ledgerRecord,
        teamName,
        memberName: canonicalMemberName,
        retry,
        reason: this.deps.getOpenCodeDeliveryPendingReason({
          responseState: ledgerRecord.responseState,
          actionMode: ledgerRecord.actionMode,
          taskRefs: ledgerRecord.taskRefs,
          visibleReply,
          ledgerRecord,
        }),
      });
      if (ledgerRecord.status === 'failed_terminal') {
        return {
          delivered: false,
          accepted: true,
          responsePending: false,
          responseState: ledgerRecord.responseState,
          ledgerStatus: ledgerRecord.status,
          ledgerRecordId: ledgerRecord.id,
          laneId: laneIdentity.laneId,
          reason: ledgerRecord.lastReason ?? 'opencode_prompt_delivery_failed_terminal',
          diagnostics: ledgerRecord.diagnostics.length
            ? ledgerRecord.diagnostics
            : [ledgerRecord.lastReason ?? 'opencode_prompt_delivery_failed_terminal'],
        };
      }
    }
    if (ledgerRecord && !promptAccepted) {
      const reason = promptAcceptanceMissingRuntimePromptId
        ? 'opencode_prompt_acceptance_unknown_missing_runtime_prompt_id'
        : isOpenCodePromptAcceptanceUnknownFailure(deliveryDiagnostics)
          ? 'opencode_prompt_acceptance_unknown_after_bridge_timeout'
          : (deliveryDiagnostics[0] ?? 'opencode_message_delivery_failed');
      if (
        reason === 'opencode_prompt_acceptance_unknown_after_bridge_timeout' ||
        reason === 'opencode_prompt_acceptance_unknown_missing_runtime_prompt_id'
      ) {
        const delayMs = OPENCODE_PROMPT_DELIVERY_OBSERVE_DELAY_MS;
        ledgerRecord = await ledger!.markAcceptanceUnknown({
          id: ledgerRecord.id,
          reason,
          nextAttemptAt: new Date(Date.now() + delayMs).toISOString(),
          diagnostics: deliveryDiagnostics,
          markedAt: nowIso(),
        });
        this.deps.scheduleOpenCodePromptDeliveryWatchdog({
          teamName,
          memberName: canonicalMemberName,
          messageId: ledgerRecord.inboxMessageId,
          delayMs,
        });
        this.deps.logOpenCodePromptDeliveryEvent(
          'opencode_prompt_delivery_retry_scheduled',
          ledgerRecord,
          { acceptanceUnknown: true, reason }
        );
      } else {
        ledgerRecord = await this.deps.openCodePromptDeliveryFollowUpPolicy.schedule({
          ledger: ledger!,
          ledgerRecord,
          teamName,
          memberName: canonicalMemberName,
          retry: true,
          reason,
        });
      }
    }
    const responseVisibleReplyMessageId =
      ledgerRecord?.visibleReplyMessageId ??
      responseObservation?.visibleReplyMessageId ??
      undefined;
    const responseVisibleReplyCorrelation =
      ledgerRecord?.visibleReplyCorrelation ??
      responseObservation?.visibleReplyCorrelation ??
      undefined;
    const acceptanceUnknown = Boolean(ledgerRecord?.acceptanceUnknown && !promptAccepted);
    const responsePending =
      acceptanceUnknown || (promptAccepted && Boolean(ledgerRecord || responseObservation))
        ? !readAllowed
        : false;
    const pendingReason =
      responsePending && ledgerRecord
        ? (ledgerRecord.lastReason ?? 'opencode_delivery_response_pending')
        : null;
    const diagnostics =
      pendingReason && result.diagnostics.length === 0
        ? [pendingReason]
        : ledgerRecord?.diagnostics.length
          ? ledgerRecord.diagnostics
          : result.diagnostics;
    // INVARIANT: `delivered: true` alone is NOT proof of acceptance. When
    // acceptanceUnknown is set, responsePending stays true until read-commit
    // is allowed, and callers MUST keep the inbox row unread while
    // responsePending is true — reacting to `delivered` only would mark an
    // unconfirmed message as read and silently lose it on a dead lane.
    return {
      delivered: promptAccepted || acceptanceUnknown,
      ...(ledgerRecord || responseObservation ? { accepted: promptAccepted } : {}),
      ...(ledgerRecord || responseObservation ? { responsePending } : {}),
      ...(acceptanceUnknown ? { acceptanceUnknown: true } : {}),
      ...(ledgerRecord
        ? {
            ledgerStatus: ledgerRecord.status,
            ledgerRecordId: ledgerRecord.id,
            laneId: laneIdentity.laneId,
          }
        : {}),
      ...(responseState
        ? {
            responseState,
            ...(responseVisibleReplyMessageId
              ? { visibleReplyMessageId: responseVisibleReplyMessageId }
              : {}),
            ...(responseVisibleReplyCorrelation
              ? { visibleReplyCorrelation: responseVisibleReplyCorrelation }
              : {}),
          }
        : {}),
      ...(pendingReason
        ? { reason: pendingReason }
        : promptAccepted
          ? {}
          : { reason: result.diagnostics[0] ?? 'opencode_message_delivery_failed' }),
      diagnostics,
    };
  }
}
