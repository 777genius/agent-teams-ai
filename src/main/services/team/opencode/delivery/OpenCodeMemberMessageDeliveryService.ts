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

import { recoverOpenCodeActiveDeliveryBlocker } from './OpenCodeActiveDeliveryPreemption';
import { isOpenCodeLeadRecipient } from './OpenCodeLeadTurnActivity';
import { deliverOpenCodeMemberMessageWithoutWatchdog } from './OpenCodeLegacyMemberMessageDelivery';
import { buildOpenCodePromptBodyText } from './OpenCodeMemberMessageDeliveryPorts';
import {
  assertOpenCodePromptDeliveryNotCancelled,
  OpenCodePromptDeliveryCancelledError,
} from './OpenCodePromptDeliveryCancellationGuard';
import { isOpenCodeSessionRefreshRetryRecord } from './OpenCodePromptDeliveryFollowUpPolicy';
import {
  buildOpenCodePromptDeliveryAttemptId,
  hashOpenCodePromptDeliveryPayload,
  isOpenCodePromptDeliveryAttemptDue,
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
  buildOpenCodeStalePendingPlainTextObservation,
  decideOpenCodeStalePendingResolution,
  getOpenCodeObservedSessionActivity,
} from './OpenCodePromptDeliveryStalePendingPolicy';
import {
  isOpenCodePromptDeliveryRetryAttemptDue,
  OPENCODE_PROMPT_DELIVERY_OBSERVE_DELAY_MS,
} from './OpenCodePromptDeliveryWatchdog';

import type { OpenCodeTeamRuntimeMessageResult } from '../../runtime';
import type {
  OpenCodeLeadTurnActivityNotification,
  OpenCodeMemberInboxDelivery,
  OpenCodeMemberMessageDeliveryInput,
  OpenCodeMemberMessageDeliveryServiceDependencies,
} from './OpenCodeMemberMessageDeliveryPorts';
import type {
  OpenCodePromptDeliveryLedgerRecord,
  OpenCodePromptDeliveryLedgerStore,
} from './OpenCodePromptDeliveryLedger';
import type { OpenCodeStalePendingResolution } from './OpenCodePromptDeliveryStalePendingPolicy';

const logger = createLogger('Service:OpenCodeMemberMessageDelivery');

function nowIso(): string {
  return new Date().toISOString();
}

export class OpenCodeMemberMessageDeliveryService {
  constructor(private readonly deps: OpenCodeMemberMessageDeliveryServiceDependencies) {}

  /**
   * Apply a stale-pending resolution to the ledger. `settle_plain_text` marks
   * the record responded (plain-text turn end); `fail_terminal` closes it so it
   * stops blocking the lane. Returns null when nothing was changed.
   */
  private async applyStalePendingResolution(input: {
    checkpoint: () => Promise<void>;
    ledger: OpenCodePromptDeliveryLedgerStore;
    ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
    resolution: OpenCodeStalePendingResolution;
    teamName: string;
    memberName: string;
    notifyActivity: (state: OpenCodeLeadTurnActivityNotification['state']) => void;
    eventContext: Record<string, unknown>;
  }): Promise<OpenCodePromptDeliveryLedgerRecord | null> {
    const { resolution } = input;
    await input.checkpoint();
    if (resolution.action === 'settle_plain_text') {
      const settled = await input.ledger.applyObservation({
        id: input.ledgerRecord.id,
        responseObservation: buildOpenCodeStalePendingPlainTextObservation({
          record: input.ledgerRecord,
          reason: resolution.reason,
        }),
        diagnostics: [resolution.reason],
        observedAt: nowIso(),
      });
      await input.checkpoint();
      this.deps.logOpenCodePromptDeliveryEvent(
        'opencode_prompt_delivery_response_observed',
        settled,
        {
          ...input.eventContext,
          reason: resolution.reason,
          stalePendingSettledAsPlainText: true,
        }
      );
      return settled;
    }
    if (resolution.action === 'fail_terminal') {
      const failed = await input.ledger.markFailedTerminal({
        id: input.ledgerRecord.id,
        reason: resolution.reason,
        diagnostics: resolution.diagnostics,
        failedAt: nowIso(),
      });
      await input.checkpoint();
      this.deps.logOpenCodePromptDeliveryEvent(
        'opencode_prompt_delivery_terminal_failure',
        failed,
        {
          ...input.eventContext,
          reason: resolution.reason,
          stalePending: true,
        }
      );
      input.notifyActivity('idle');
      return failed;
    }
    // 'none' and 'keep_observing' fall through to the regular follow-up
    // scheduling, which already logs each observe cycle.
    return null;
  }

  async deliver(
    teamName: string,
    input: OpenCodeMemberMessageDeliveryInput
  ): Promise<OpenCodeMemberInboxDelivery> {
    try {
      return await this.deliverCurrent(teamName, input);
    } catch (error) {
      if (!(error instanceof OpenCodePromptDeliveryCancelledError)) throw error;
      return {
        delivered: false,
        accepted: false,
        responsePending: false,
        reason: error.message,
        ledgerStatus: error.record?.status,
        ledgerRecordId: error.record?.id,
      };
    }
  }

  private async deliverCurrent(
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

    const assertCurrentRun = (): void => {
      const current =
        laneIdentity.laneKind === 'primary'
          ? this.deps.resolveDeliverableTrackedRuntimeRunId(teamName)
          : this.deps.getCurrentOpenCodeRuntimeRunId(teamName, laneIdentity.laneId);
      const hadTrackedRun =
        laneIdentity.laneKind === 'primary' ? trackedRunId : inMemorySecondaryLaneRunId;
      if (
        (current && runtimeRunId && current !== runtimeRunId) ||
        (hadTrackedRun && !current) ||
        this.deps.stoppingSecondaryRuntimeTeams.has(teamName)
      ) {
        throw new OpenCodePromptDeliveryCancelledError();
      }
    };
    if (!this.deps.openCodePromptDeliveryWatchdogScheduler.isEnabled()) {
      return await deliverOpenCodeMemberMessageWithoutWatchdog({
        ports: this.deps,
        assertCurrentRun,
        adapter,
        message: input,
        teamName,
        memberName: canonicalMemberName,
        laneId: laneIdentity.laneId,
        cwd,
        runtimeRunId,
        fileParts: openCodeFileParts,
        forceSessionRefreshReason: forceOpenCodeSessionRefreshReason,
        legacyBootstrapSessionToStamp: legacyOpenCodeBootstrapSessionToStamp,
        refreshedBootstrapSessionToStamp: refreshedOpenCodeBootstrapSessionToStamp,
        teamColor: config?.color,
        teamDisplayName: config?.name,
      });
    }

    const isLeadRecipient =
      laneIdentity.laneKind === 'primary' &&
      isOpenCodeLeadRecipient(canonicalMemberName, directory);
    const activityRunId = runtimeRunId;
    const notifyActivity = (state: OpenCodeLeadTurnActivityNotification['state']): void => {
      if (!isLeadRecipient || !activityRunId) return;
      try {
        this.deps.notifyOpenCodeLeadTurnActivity?.({
          teamName,
          memberName: canonicalMemberName,
          laneId: laneIdentity.laneId,
          runId: activityRunId,
          state,
        });
      } catch (error) {
        logger.warn(
          `[${teamName}] OpenCode lead turn activity (${state}) notification failed: ${getErrorMessage(error)}`
        );
      }
    };
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
      active = await recoverOpenCodeActiveDeliveryBlocker({
        assertCurrentRun,
        ports: this.deps,
        ledger,
        activeRecord: active,
        teamName,
        memberName: canonicalMemberName,
      });
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

    assertCurrentRun();
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
    const checkpoint = async (): Promise<void> => {
      await assertOpenCodePromptDeliveryNotCancelled(ledger, ledgerRecord);
      assertCurrentRun();
    };
    await checkpoint();
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
        checkpoint: assertCurrentRun,
        ledger,
        ledgerRecord,
        teamName,
        replyRecipient: input.replyRecipient,
        memberName: canonicalMemberName,
      });
      ledgerRecord = proof.ledgerRecord;
      await checkpoint();
      proof = await this.deps.openCodeVisibleReplyProofService.materializePlainTextReplyIfNeeded({
        checkpoint: assertCurrentRun,
        ledger,
        ledgerRecord,
        teamName,
        memberName: canonicalMemberName,
        visibleReply: proof.visibleReply,
      });
      ledgerRecord = proof.ledgerRecord;
      await checkpoint();
      let readAllowed = await this.deps.isOpenCodeDeliveryResponseReadCommitAllowed({
        teamName,
        memberName: canonicalMemberName,
        responseState: ledgerRecord.responseState,
        actionMode: ledgerRecord.actionMode ?? undefined,
        taskRefs: ledgerRecord.taskRefs,
        visibleReply: proof.visibleReply,
        ledgerRecord,
      });
      await checkpoint();
      if (readAllowed) {
        this.deps.logOpenCodePromptDeliveryEvent(
          'opencode_prompt_delivery_response_observed',
          ledgerRecord,
          { visibleReplySemanticallySufficient: true }
        );
        notifyActivity('idle');
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
      await checkpoint();

      if (ledgerRecord.status === 'failed_terminal') {
        this.deps.logOpenCodePromptDeliveryEvent(
          'opencode_prompt_delivery_terminal_failure',
          ledgerRecord
        );
        notifyActivity('idle');
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
        await checkpoint();
        this.deps.scheduleOpenCodePromptDeliveryWatchdog({
          teamName,
          memberName: canonicalMemberName,
          messageId,
          delayMs: Number.isFinite(nextAttemptMs)
            ? Math.max(500, nextAttemptMs - Date.now())
            : OPENCODE_PROMPT_DELIVERY_OBSERVE_DELAY_MS,
        });
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
        await checkpoint();
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
        await checkpoint();
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
        await checkpoint();
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
        await checkpoint();
        proof = await this.deps.openCodeVisibleReplyProofService.applyDestinationProof({
          checkpoint: assertCurrentRun,
          ledger,
          ledgerRecord,
          teamName,
          replyRecipient: input.replyRecipient,
          memberName: canonicalMemberName,
        });
        ledgerRecord = proof.ledgerRecord;
        await checkpoint();
        proof = await this.deps.openCodeVisibleReplyProofService.materializePlainTextReplyIfNeeded({
          checkpoint: assertCurrentRun,
          ledger,
          ledgerRecord,
          teamName,
          memberName: canonicalMemberName,
          visibleReply: proof.visibleReply,
        });
        ledgerRecord = proof.ledgerRecord;
        await checkpoint();
        readAllowed = await this.deps.isOpenCodeDeliveryResponseReadCommitAllowed({
          teamName,
          memberName: canonicalMemberName,
          responseState: ledgerRecord.responseState,
          actionMode: ledgerRecord.actionMode ?? undefined,
          taskRefs: ledgerRecord.taskRefs,
          visibleReply: proof.visibleReply,
          ledgerRecord,
        });
        await checkpoint();
        if (readAllowed) {
          this.deps.logOpenCodePromptDeliveryEvent(
            'opencode_prompt_delivery_response_observed',
            ledgerRecord,
            { visibleReplySemanticallySufficient: true }
          );
          notifyActivity('idle');
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

        if (
          hasOpenCodeAcceptedRuntimePrompt(ledgerRecord) &&
          getOpenCodeObservedSessionActivity(observed.diagnostics) !== 'idle' &&
          (ledgerRecord.responseState === 'pending' ||
            ledgerRecord.responseState === 'prompt_not_indexed')
        ) {
          notifyActivity('active');
        }

        // Stale-pending guard: an accepted prompt the bridge keeps reporting as
        // `pending` has no attempt budget, so bound it here. A lead plain-text
        // turn end settles non-user messages; stale idle records go terminal.
        const staleResolution = decideOpenCodeStalePendingResolution({
          record: ledgerRecord,
          laneKind: isLeadRecipient ? 'primary' : 'secondary',
          observation: responseObservation,
          observedDiagnostics: observed.diagnostics,
          nowMs: Date.now(),
          config: this.deps.openCodeStalePendingPolicyConfig,
        });
        const staleSettled = await this.applyStalePendingResolution({
          checkpoint,
          ledger,
          ledgerRecord,
          resolution: staleResolution,
          teamName,
          memberName: canonicalMemberName,
          notifyActivity,
          eventContext: { observedAfterAcceptedPrompt: true },
        });
        await checkpoint();
        if (staleSettled) {
          ledgerRecord = staleSettled;
          const settledReadAllowed =
            ledgerRecord.status === 'responded' &&
            (await this.deps.isOpenCodeDeliveryResponseReadCommitAllowed({
              teamName,
              memberName: canonicalMemberName,
              responseState: ledgerRecord.responseState,
              actionMode: ledgerRecord.actionMode ?? undefined,
              taskRefs: ledgerRecord.taskRefs,
              visibleReply: proof.visibleReply,
              ledgerRecord,
            }));
          await checkpoint();
          if (settledReadAllowed || ledgerRecord.status === 'failed_terminal') {
            notifyActivity('idle');
            return {
              delivered: settledReadAllowed,
              accepted: true,
              responsePending: false,
              responseState: ledgerRecord.responseState,
              ledgerStatus: ledgerRecord.status,
              ledgerRecordId: ledgerRecord.id,
              laneId: laneIdentity.laneId,
              visibleReplyMessageId: ledgerRecord.visibleReplyMessageId ?? undefined,
              visibleReplyCorrelation: ledgerRecord.visibleReplyCorrelation ?? undefined,
              ...(settledReadAllowed
                ? {}
                : {
                    reason: ledgerRecord.lastReason ?? 'opencode_prompt_delivery_failed_terminal',
                  }),
              diagnostics: ledgerRecord.diagnostics,
            };
          }
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
            notifyActivity('idle');
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
            notifyActivity('idle');
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
      text: buildOpenCodePromptBodyText(input),
      controlText: buildOpenCodePromptDeliveryRepairControlText({
        ledgerRecord,
        readAllowed: retryReadAllowed,
        pendingReason: retryPendingReason,
        controlUrl,
      }),
    });
    await checkpoint();
    let result: OpenCodeTeamRuntimeMessageResult;
    try {
      result = await this.deps.sendOpenCodeMemberMessageToRuntimeSerialized({
        teamName,
        laneId: laneIdentity.laneId,
        memberName: canonicalMemberName,
        send: async () => {
          await checkpoint();
          return await adapter.sendMessageToMember({
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
          });
        },
      });
    } catch (error) {
      await checkpoint();
      const diagnostic = `opencode_message_delivery_exception: ${getErrorMessage(error)}`;
      notifyActivity('idle');
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
        await checkpoint();
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
    await checkpoint();
    await this.deps.rememberOpenCodeRuntimePidFromBridge({
      teamName,
      memberName: canonicalMemberName,
      laneId: laneIdentity.laneId,
      runId: runtimeRunId,
      runtimeSessionId: result.sessionId,
      runtimePid: result.runtimePid,
      reason: 'opencode_delivery_runtime_pid_observed',
    });
    await checkpoint();
    if (result.ok && legacyOpenCodeBootstrapSessionToStamp) {
      await this.deps.stampOpenCodeAppMcpTransportEvidenceIfMissing(
        legacyOpenCodeBootstrapSessionToStamp
      );
    }
    await checkpoint();
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
    await checkpoint();
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
      await checkpoint();
      this.deps.emitOpenCodePromptDeliveryTaskLogChange(
        ledgerRecord,
        'opencode-prompt-delivery-session-evidence'
      );
      if (promptAccepted) {
        notifyActivity('active');
      }
      let proof = await this.deps.openCodeVisibleReplyProofService.applyDestinationProof({
        checkpoint: assertCurrentRun,
        ledger,
        ledgerRecord,
        teamName,
        replyRecipient: input.replyRecipient,
        memberName: canonicalMemberName,
      });
      ledgerRecord = proof.ledgerRecord;
      await checkpoint();
      proof = await this.deps.openCodeVisibleReplyProofService.materializePlainTextReplyIfNeeded({
        checkpoint: assertCurrentRun,
        ledger,
        ledgerRecord,
        teamName,
        memberName: canonicalMemberName,
        visibleReply: proof.visibleReply,
      });
      ledgerRecord = proof.ledgerRecord;
      await checkpoint();
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
      await checkpoint();
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
    await checkpoint();
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
        notifyActivity('idle');
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
        await checkpoint();
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
    await checkpoint();
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
    if (!promptAccepted || !responsePending) {
      // Settled in this frame: response read-committable, or the prompt was not
      // (or not provably) accepted. An accepted-but-pending turn stays 'active'
      // until a later observation/watchdog settles it.
      notifyActivity('idle');
    }
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
