import {
  appendProvisioningAssistantText,
  getCurrentLeadSessionId,
  getLiveLeadProcessMessages,
  pruneLiveLeadMessagesForCleanedRun,
  pushLiveLeadProcessMessage,
  pushLiveLeadTextMessage,
  resetLiveLeadTextBuffer,
  shiftProvisioningOutputIndexesAfterRemoval,
  type TeamProvisioningLeadAssistantOutputRun,
  type TeamProvisioningLeadTextRun,
  type TeamProvisioningLiveLeadMessageCleanupRun,
  type TeamProvisioningLiveLeadMessageRun,
} from './TeamProvisioningLeadProcessMessages';
import {
  captureLeadSendMessages,
  type TeamProvisioningLeadSendMessageCaptureLogger,
  type TeamProvisioningLeadSendMessageCapturePorts,
  type TeamProvisioningLeadSendMessageRun,
} from './TeamProvisioningLeadSendMessageCapture';

import type { InboxMessage, TeamChangeEvent } from '@shared/types';

export type TeamProvisioningLiveLeadMessagePortsFactoryRun = TeamProvisioningLeadSendMessageRun &
  TeamProvisioningLeadTextRun &
  TeamProvisioningLeadAssistantOutputRun &
  TeamProvisioningLiveLeadMessageRun &
  TeamProvisioningLiveLeadMessageCleanupRun;

export interface TeamProvisioningLiveLeadMessagePortsFactoryDeps<
  TRun extends TeamProvisioningLiveLeadMessagePortsFactoryRun,
> {
  liveLeadProcessMessages: Map<string, InboxMessage[]>;
  getTrackedRunId(teamName: string): string | null;
  getAliveRunId(teamName: string): string | null;
  getRun(runId: string): TRun | undefined;
  getRunLeadName(run: TRun): string;
  getCrossTeamSender(): TeamProvisioningLeadSendMessageCapturePorts['crossTeamSender'];
  persistSentMessage(teamName: string, message: InboxMessage): void;
  persistInboxMessage(teamName: string, recipient: string, message: InboxMessage): void;
  emitTeamChange(event: TeamChangeEvent): void;
  logger: TeamProvisioningLeadSendMessageCaptureLogger;
  nowIso(): string;
  nowMs(): number;
  cacheLimit: number;
  leadTextEmitThrottleMs: number;
}

export interface TeamProvisioningLiveLeadMessagePortsBoundary<
  TRun extends TeamProvisioningLiveLeadMessagePortsFactoryRun,
> {
  getLiveLeadProcessMessages(teamName: string): InboxMessage[];
  getCurrentLeadSessionId(teamName: string): string | null;
  pruneLiveLeadMessagesForCleanedRun(run: TRun): void;
  captureSendMessages(run: TRun, content: Record<string, unknown>[]): void;
  pushLiveLeadProcessMessage(teamName: string, message: InboxMessage): void;
  resolveCrossTeamReplyMetadata(
    teamName: string,
    toTeam: string
  ): { conversationId: string; replyToConversationId: string } | null;
  resetLiveLeadTextBuffer(run: TRun): void;
  appendProvisioningAssistantText(run: TRun, msg: Record<string, unknown>, text: string): void;
  shiftProvisioningOutputIndexesAfterRemoval(run: TRun, removedIndex: number): void;
  pushLiveLeadTextMessage(
    run: TRun,
    cleanText: string,
    stableMessageId?: string,
    messageTimestamp?: string,
    options?: { coalesceStreamChunk?: boolean }
  ): void;
}

export function createTeamProvisioningLiveLeadMessagePortsBoundary<
  TRun extends TeamProvisioningLiveLeadMessagePortsFactoryRun,
>(
  deps: TeamProvisioningLiveLeadMessagePortsFactoryDeps<TRun>
): TeamProvisioningLiveLeadMessagePortsBoundary<TRun> {
  const pushLiveLeadProcessMessageForTeam = (teamName: string, message: InboxMessage): void => {
    pushLiveLeadProcessMessage(teamName, message, {
      liveLeadProcessMessages: deps.liveLeadProcessMessages,
      getTrackedRunId: (teamName) => deps.getTrackedRunId(teamName),
      getRun: (runId) => deps.getRun(runId),
      cacheLimit: deps.cacheLimit,
    });
  };

  const resolveCrossTeamReplyMetadata = (
    teamName: string,
    toTeam: string
  ): { conversationId: string; replyToConversationId: string } | null => {
    const runId = deps.getAliveRunId(teamName);
    if (!runId) return null;
    const run = deps.getRun(runId);
    const hints = run?.activeCrossTeamReplyHints ?? [];
    if (hints.length === 0) return null;

    const matches = hints.filter((hint) => hint.toTeam === toTeam);
    if (matches.length !== 1) return null;

    return {
      conversationId: matches[0].conversationId,
      replyToConversationId: matches[0].conversationId,
    };
  };

  return {
    getLiveLeadProcessMessages: (teamName) =>
      getLiveLeadProcessMessages(teamName, {
        liveLeadProcessMessages: deps.liveLeadProcessMessages,
        getTrackedRunId: (teamName) => deps.getTrackedRunId(teamName),
        getRun: (runId) => deps.getRun(runId),
      }),
    getCurrentLeadSessionId: (teamName) =>
      getCurrentLeadSessionId(teamName, {
        getTrackedRunId: (teamName) => deps.getTrackedRunId(teamName),
        getRun: (runId) => deps.getRun(runId),
      }),
    pruneLiveLeadMessagesForCleanedRun: (run) =>
      pruneLiveLeadMessagesForCleanedRun(run, deps.liveLeadProcessMessages),
    captureSendMessages: (run, content) =>
      captureLeadSendMessages(run, content, {
        nowIso: deps.nowIso,
        nowMs: deps.nowMs,
        logger: deps.logger,
        crossTeamSender: deps.getCrossTeamSender(),
        resolveCrossTeamReplyMetadata,
        getTrackedRunId: (teamName) => deps.getTrackedRunId(teamName),
        pushLiveLeadProcessMessage: pushLiveLeadProcessMessageForTeam,
        persistSentMessage: (teamName, message) => deps.persistSentMessage(teamName, message),
        persistInboxMessage: (teamName, recipient, message) =>
          deps.persistInboxMessage(teamName, recipient, message),
        emitLeadMessageChange: (teamName, runId, detail) =>
          deps.emitTeamChange({ type: 'lead-message', teamName, runId, detail }),
        emitInboxChange: (teamName, detail) =>
          deps.emitTeamChange({ type: 'inbox', teamName, detail }),
      }),
    pushLiveLeadProcessMessage: pushLiveLeadProcessMessageForTeam,
    resolveCrossTeamReplyMetadata,
    resetLiveLeadTextBuffer,
    appendProvisioningAssistantText,
    shiftProvisioningOutputIndexesAfterRemoval,
    pushLiveLeadTextMessage: (run, cleanText, stableMessageId, messageTimestamp, options) =>
      pushLiveLeadTextMessage(run, cleanText, stableMessageId, messageTimestamp, options, {
        nowMs: deps.nowMs,
        nowIso: deps.nowIso,
        getRunLeadName: (run) => deps.getRunLeadName(run),
        pushLiveLeadProcessMessage: pushLiveLeadProcessMessageForTeam,
        emitTeamChange: (event) => deps.emitTeamChange(event),
        leadTextEmitThrottleMs: deps.leadTextEmitThrottleMs,
      }),
  };
}
