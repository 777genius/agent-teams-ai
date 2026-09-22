import { CROSS_TEAM_SENT_SOURCE, CROSS_TEAM_SOURCE } from '@shared/constants/crossTeam';
import { parsePermissionRequest } from '@shared/utils/inboxNoise';
import { isLeadMember } from '@shared/utils/leadDetection';

import {
  buildLeadActiveCrossTeamReplyHints,
  clearPendingCrossTeamReplyExpectation,
  createCrossTeamLeadSuppressionState,
  markCrossTeamReplyToOwnOutbound,
  rememberRecentCrossTeamLeadDeliveryMessageIds,
  wasRecentlyDeliveredCrossTeamLeadMessage,
} from './TeamProvisioningCrossTeamRelayHelpers';
import {
  buildLeadInboxRelayPrompt,
  DEFAULT_INBOX_RELAY_BATCH_SIZE,
  getLeadInboxRelayNoiseIds,
  getLeadRelayReadCommitBatch,
  hasStableInboxMessageId,
  planLeadInboxRelayReadOnlyMessages,
  type RelayInboxMessage,
  selectActionableLeadRelayUnread,
  selectLeadInboxRelayBatch,
  shouldDeferSameTeamMessage,
} from './TeamProvisioningInboxRelayPolicy';
import { scanLeadInboxPermissionRequests } from './TeamProvisioningLeadPermissionScan';
import { joinLeadRelayCaptureText } from './TeamProvisioningLeadProcessMessages';
import {
  cancelRunLeadRelayCapture,
  observeRunLeadRelayCancellation,
} from './TeamProvisioningLeadRelayCancellation';
import { projectLeadRelayReply } from './TeamProvisioningLeadRelayProjection';

import type { InboxMessage, TeamChangeEvent } from '@shared/types';
import type { ParsedPermissionRequest } from '@shared/utils/inboxNoise';

export interface LeadInboxRelayFlowRun {
  runId: string;
  startedAt: string;
  child: unknown | null;
  processKilled: boolean;
  cancelRequested: boolean;
  provisioningComplete: boolean;
  leadRelayCapture: LeadInboxRelayCapture | null;
  activeCrossTeamReplyHints: {
    toTeam: string;
    conversationId: string;
  }[];
}

export interface LeadInboxRelayCapture {
  leadName: string;
  startedAt: string;
  textParts: string[];
  textJoinMode?: 'block' | 'stream';
  recoveryMessageId?: string;
  requireTerminalResult?: boolean;
  terminalResultSucceeded?: boolean;
  replyVisibility?: 'user' | 'internal_activity';
  hasVisibleSendMessage?: boolean;
  hasUserVisibleSendMessage?: boolean;
  settled: boolean;
  idleHandle: NodeJS.Timeout | null;
  idleMs: number;
  touch?: () => void;
  resolveOnce: (text: string) => void;
  rejectOnce: (error: string) => void;
  timeoutHandle: NodeJS.Timeout;
}

export interface LeadInboxRelayConfigMember {
  agentType?: unknown;
  name?: string;
  role?: string;
}

export interface LeadInboxRelayConfig {
  members?: LeadInboxRelayConfigMember[];
}

export interface LeadInboxRelayFlowLogger {
  debug(message: string): void;
}

export interface LeadInboxRelayFlowPorts<TRun extends LeadInboxRelayFlowRun> {
  getAliveRunId(teamName: string): string | null | undefined;
  getProvisioningRunId(teamName: string): string | null | undefined;
  getRun(runId: string): TRun | undefined;
  isCurrentTrackedRun(run: TRun): boolean;
  readConfigForObservation(teamName: string): Promise<LeadInboxRelayConfig | null>;
  readLeadInboxMessages(teamName: string, leadName: string): Promise<InboxMessage[]>;
  markInboxMessagesRead(
    teamName: string,
    leadName: string,
    messages: { messageId: string }[]
  ): Promise<void>;
  handleTeammatePermissionRequest(
    run: TRun,
    permissionRequest: ParsedPermissionRequest,
    timestamp: string
  ): void;
  refreshMemberSpawnStatusesFromLeadInbox(run: TRun): Promise<void>;
  confirmSameTeamNativeMatches(
    teamName: string,
    leadName: string,
    messages: RelayInboxMessage[]
  ): Promise<{ nativeMatchedMessageIds: Set<string>; persisted: boolean }>;
  scheduleSameTeamPersistRetry(teamName: string): void;
  scheduleSameTeamDeferredRetry(teamName: string): void;
  resolveControlApiBaseUrl(): Promise<string | null>;
  sendMessageToRun(run: TRun, message: string): Promise<void>;
  hasAcceptedLeadWorkSyncReport(input: { teamName: string; leadName: string }): Promise<boolean>;
  scheduleLeadProofMissingWorkSyncRecovery(input: {
    teamName: string;
    leadName: string;
    message: InboxMessage & { messageId: string };
  }): Promise<boolean>;
  pushLiveLeadTextMessage(run: TRun, text: string, messageId: string, timestamp: string): void;
  pushLiveLeadProcessMessage(teamName: string, message: InboxMessage): void;
  persistSentMessage(teamName: string, message: InboxMessage): void;
  emitTeamChange(event: TeamChangeEvent): void;
  scheduleLeadInboxFollowUpRelay(teamName: string, delayMs?: number): void;
  rememberLeadRecoveryMessage(teamName: string, messageId: string): void;
  rememberSuccessfulLeadRecoveryMessage(teamName: string, messageId: string): void;
  relayedLeadInboxMessageIds: Map<string, Set<string>>;
  trimRelayedSet(relayedIds: Set<string>): Set<string>;
  pendingCrossTeamFirstReplies: Map<string, Map<string, number>>;
  recentCrossTeamLeadDeliveryMessageIds: Map<string, Map<string, number>>;
  sameTeamRunStartSkewMs: number;
  sameTeamNativeDeliveryGraceMs: number;
  recentCrossTeamDeliveryTtlMs: number;
  logger: LeadInboxRelayFlowLogger;
  nowIso(): string;
  nowMs(): number;
  setTimeout(callback: () => void, ms: number): NodeJS.Timeout;
  clearTimeout(handle: NodeJS.Timeout): void;
}

export interface LeadInboxRelayOptions {
  onlyMessageId?: string;
}

// A lead turn that is running tools produces no assistant text, so a short reply deadline used to
// declare a delivered message undelivered mid-turn. The deadline is now generous and activity
// extends it; the absolute cap still bounds a wedged lane.
const LEAD_RELAY_CAPTURE_TIMEOUT_MS = 120_000;
const LEAD_RELAY_CAPTURE_ABSOLUTE_CAP_MS = 600_000;
const LEAD_RELAY_NO_PROOF_RETRY_DELAY_MS = 10_000;
const LEAD_RELAY_ATTEMPTED_ID_LIMIT = 300;

const leadInboxRelayQueues = new WeakMap<Map<string, Set<string>>, Map<string, Promise<number>>>();

// Message ids already sent to the lead at least once, even without delivery proof, keyed by the
// same per-service identity map as the relay queues. A retry of such a message is marked as a
// redelivery in the relay prompt so a memoryless lead checks board state before repeating side
// effects it may already have performed.
const attemptedLeadRelayIdsRegistry = new WeakMap<
  Map<string, Set<string>>,
  Map<string, Set<string>>
>();

function getAttemptedLeadRelayIdsByTeam(
  identity: Map<string, Set<string>>
): Map<string, Set<string>> {
  let byTeam = attemptedLeadRelayIdsRegistry.get(identity);
  if (!byTeam) {
    byTeam = new Map();
    attemptedLeadRelayIdsRegistry.set(identity, byTeam);
  }
  return byTeam;
}

function markLeadRelayAttemptsAndCollectRedeliveries(
  identity: Map<string, Set<string>>,
  teamName: string,
  batch: readonly { messageId: string }[]
): Set<string> {
  const attemptedByTeam = getAttemptedLeadRelayIdsByTeam(identity);
  let attemptedIds = attemptedByTeam.get(teamName);
  if (!attemptedIds) {
    attemptedIds = new Set<string>();
    attemptedByTeam.set(teamName, attemptedIds);
  }
  const redeliveredMessageIds = new Set(
    batch
      .filter((relayMessage) => attemptedIds.has(relayMessage.messageId))
      .map((relayMessage) => relayMessage.messageId)
  );
  for (const relayMessage of batch) {
    attemptedIds.add(relayMessage.messageId);
  }
  while (attemptedIds.size > LEAD_RELAY_ATTEMPTED_ID_LIMIT) {
    const oldest = attemptedIds.values().next().value;
    if (oldest === undefined) break;
    attemptedIds.delete(oldest);
  }
  return redeliveredMessageIds;
}

export async function relayLeadInboxMessagesForTeam<TRun extends LeadInboxRelayFlowRun>(
  teamName: string,
  ports: LeadInboxRelayFlowPorts<TRun>,
  options: LeadInboxRelayOptions = {}
): Promise<number> {
  let queue = leadInboxRelayQueues.get(ports.relayedLeadInboxMessageIds);
  if (!queue) {
    queue = new Map<string, Promise<number>>();
    leadInboxRelayQueues.set(ports.relayedLeadInboxMessageIds, queue);
  }

  const previous = queue.get(teamName);
  const work = (async (): Promise<number> => {
    if (previous) {
      try {
        await previous;
      } catch {
        // A failed attempt must not prevent the queued relay from retrying unread messages.
      }
    }
    return runLeadInboxRelayForTeam(teamName, ports, options);
  })();
  queue.set(teamName, work);

  try {
    return await work;
  } finally {
    if (queue.get(teamName) === work) {
      queue.delete(teamName);
    }
  }
}

async function runLeadInboxRelayForTeam<TRun extends LeadInboxRelayFlowRun>(
  teamName: string,
  ports: LeadInboxRelayFlowPorts<TRun>,
  options: LeadInboxRelayOptions
): Promise<number> {
  const runId = ports.getAliveRunId(teamName) ?? ports.getProvisioningRunId(teamName);
  if (!runId) return 0;
  const run = ports.getRun(runId);
  if (!run?.child || run.processKilled || run.cancelRequested) return 0;
  const isStaleRelayRun = (): boolean =>
    !ports.isCurrentTrackedRun(run) || !run.child || run.processKilled || run.cancelRequested;

  let config: LeadInboxRelayConfig | null = null;
  try {
    config = await ports.readConfigForObservation(teamName);
  } catch {
    // config not ready yet during early provisioning - skip scan
  }
  if (isStaleRelayRun()) return 0;
  if (config) {
    const leadName = getLeadName(config);
    const permissionScanResult = await scanLeadInboxPermissionRequests(
      { teamName, leadName, run, isStaleRelayRun },
      {
        readLeadInboxMessages: ports.readLeadInboxMessages,
        handleTeammatePermissionRequest: ports.handleTeammatePermissionRequest,
        markInboxMessagesRead: ports.markInboxMessagesRead,
      }
    );
    if (permissionScanResult === 'stale') return 0;
  }

  if (!run.provisioningComplete) return 0;

  const relayedIds = ports.relayedLeadInboxMessageIds.get(teamName) ?? new Set<string>();

  if (!config) {
    try {
      config = await ports.readConfigForObservation(teamName);
    } catch {
      return 0;
    }
  }
  if (isStaleRelayRun()) return 0;
  if (!config) return 0;

  const leadName = getLeadName(config);
  let leadInboxMessages: InboxMessage[] = [];
  try {
    leadInboxMessages = await ports.readLeadInboxMessages(teamName, leadName);
  } catch {
    return 0;
  }
  if (isStaleRelayRun()) return 0;

  await ports.refreshMemberSpawnStatusesFromLeadInbox(run);
  if (isStaleRelayRun()) return 0;

  const unread = leadInboxMessages
    .filter((m): m is RelayInboxMessage => {
      if (m.read) return false;
      if (typeof m.text !== 'string' || m.text.trim().length === 0) return false;
      if (!hasStableInboxMessageId(m)) return false;
      return !relayedIds.has(m.messageId);
    })
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

  if (unread.length === 0) return 0;

  const { silentIdleIds, passiveIdleIds, coarseNonIdleNoiseIds } =
    getLeadInboxRelayNoiseIds(unread);

  const crossTeamSuppression = createCrossTeamLeadSuppressionState({
    leadInboxMessages,
    pendingReplies: ports.pendingCrossTeamFirstReplies,
    teamName,
    now: ports.nowMs(),
    ttlMs: ports.recentCrossTeamDeliveryTtlMs,
  });

  const wasRecentlyDeliveredCrossTeam = (message: InboxMessage): boolean => {
    return wasRecentlyDeliveredCrossTeamLeadMessage({
      message,
      recentMessageIds: ports.recentCrossTeamLeadDeliveryMessageIds,
      teamName,
      now: ports.nowMs(),
      ttlMs: ports.recentCrossTeamDeliveryTtlMs,
    });
  };
  const isCrossTeamReplyToOwnOutbound = (message: InboxMessage): boolean => {
    return markCrossTeamReplyToOwnOutbound(message, crossTeamSuppression);
  };

  const { permanentlyIgnored, passiveIdleUnread, readOnlyIgnoredIds, remainingUnread } =
    planLeadInboxRelayReadOnlyMessages({
      unread,
      silentIdleIds,
      passiveIdleIds,
      coarseNonIdleNoiseIds,
      isPermanentlyIgnored: (message) =>
        message.source === CROSS_TEAM_SENT_SOURCE ||
        isCrossTeamReplyToOwnOutbound(message) ||
        wasRecentlyDeliveredCrossTeam(message),
    });
  if (permanentlyIgnored.length > 0) {
    try {
      await ports.markInboxMessagesRead(teamName, leadName, permanentlyIgnored);
    } catch {
      // best-effort
    }
    for (const key of crossTeamSuppression.matchedTransientReplyKeys) {
      const [otherTeam, conversationId] = key.split('\0');
      if (otherTeam && conversationId) {
        clearPendingCrossTeamReplyExpectation(
          ports.pendingCrossTeamFirstReplies,
          teamName,
          otherTeam,
          conversationId
        );
      }
    }
  }

  if (passiveIdleUnread.length > 0) {
    try {
      await ports.markInboxMessagesRead(teamName, leadName, passiveIdleUnread);
      ports.logger.debug(
        `[${teamName}] lead relay marked ${passiveIdleUnread.length} passive idle message(s) read without relay`
      );
    } catch (error) {
      ports.logger.debug(
        `[${teamName}] lead relay failed to mark ${passiveIdleUnread.length} passive idle message(s) read: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  if (isStaleRelayRun()) return 0;

  const { nativeMatchedMessageIds, persisted: sameTeamPersisted } =
    await ports.confirmSameTeamNativeMatches(teamName, leadName, remainingUnread);

  if (isStaleRelayRun()) return 0;
  const runStartedAtMs = Date.parse(run.startedAt);
  const deferredByAge = remainingUnread.filter(
    (message) =>
      !nativeMatchedMessageIds.has(message.messageId) &&
      shouldDeferSameTeamMessage({
        message,
        leadName,
        runStartedAtMs,
        nowMs: ports.nowMs(),
        runStartSkewMs: ports.sameTeamRunStartSkewMs,
        nativeDeliveryGraceMs: ports.sameTeamNativeDeliveryGraceMs,
      })
  );
  const deferredIds = new Set(deferredByAge.map((m) => m.messageId));

  const permissionRequestIds = new Set(
    remainingUnread
      .filter((m) => !deferredIds.has(m.messageId) && parsePermissionRequest(m.text) !== null)
      .map((m) => m.messageId)
  );

  const actionableUnread = selectActionableLeadRelayUnread({
    remainingUnread,
    nativeMatchedMessageIds,
    deferredIds,
    permissionRequestIds,
  });
  const onlyMessageId = options.onlyMessageId?.trim();

  if (nativeMatchedMessageIds.size > 0 && !sameTeamPersisted) {
    ports.scheduleSameTeamPersistRetry(teamName);
  }
  if (deferredByAge.length > 0) {
    ports.scheduleSameTeamDeferredRetry(teamName);
  }

  const requestedMessage = onlyMessageId
    ? actionableUnread.find((message) => message.messageId === onlyMessageId)
    : undefined;
  const firstRecoveryMessage = actionableUnread.find(
    (message) => String(message.messageKind) === 'runtime_recovery_nudge'
  );
  const scopedActionableUnread = onlyMessageId
    ? requestedMessage
      ? [requestedMessage]
      : []
    : firstRecoveryMessage
      ? [firstRecoveryMessage]
      : actionableUnread;
  if (scopedActionableUnread.length === 0) return 0;

  const { batch, replyVisibility, hasPendingFollowUpRelay } = selectLeadInboxRelayBatch({
    actionableUnread: scopedActionableUnread,
    unread,
    readOnlyIgnoredIds,
    maxRelay: DEFAULT_INBOX_RELAY_BATCH_SIZE,
  });
  const recoveryMessageId = batch.find(
    (message) => String(message.messageKind) === 'runtime_recovery_nudge'
  )?.messageId;
  if (recoveryMessageId) {
    ports.rememberLeadRecoveryMessage(teamName, recoveryMessageId);
  }
  const teammateRoster = (config.members ?? [])
    .filter((member) => {
      const name = member.name?.trim();
      return name && name !== leadName;
    })
    .map((member) => ({
      name: member.name?.trim() ?? '',
      ...(member.role?.trim() ? { role: member.role.trim() } : {}),
    }));
  const workSyncControlUrl = await ports.resolveControlApiBaseUrl();
  if (isStaleRelayRun()) return 0;
  run.activeCrossTeamReplyHints = buildLeadActiveCrossTeamReplyHints(batch);
  const redeliveredMessageIds = markLeadRelayAttemptsAndCollectRedeliveries(
    ports.relayedLeadInboxMessageIds,
    teamName,
    batch
  );
  const message = buildLeadInboxRelayPrompt({
    teamName,
    leadName,
    batch,
    replyVisibility,
    teammates: teammateRoster,
    workSyncControlUrl,
    redeliveredMessageIds,
  });

  const capturePromise = startLeadRelayCapture(
    run,
    leadName,
    replyVisibility,
    recoveryMessageId,
    ports
  );

  // Cancellation stays owned until transport settles, even if reply capture finishes first.
  const cancellation = observeRunLeadRelayCancellation(run);
  const transportDeadline = ports.setTimeout(
    () => cancelRunLeadRelayCapture(run),
    LEAD_RELAY_CAPTURE_ABSOLUTE_CAP_MS
  );
  const finalizedCapture = finalizeLeadRelayCapture(run, capturePromise, ports);
  let captureResult: Awaited<typeof finalizedCapture>;
  try {
    const send = Promise.resolve().then(() => {
      if (cancellation.isCancelled() || isStaleRelayRun()) return;
      return ports.sendMessageToRun(run, message);
    });
    captureResult = await Promise.race([
      cancellation.cancelled,
      // Failed capture drains pending transport; successful capture requires transport success.
      finalizedCapture.then((result) =>
        result.deliveryConfirmed ? send.then(() => result) : result
      ),
      send.then(() => {
        ports.clearTimeout(transportDeadline);
        return finalizedCapture;
      }),
    ]);
  } catch {
    cancelRunLeadRelayCapture(run);
    await finalizedCapture;
    return 0;
  } finally {
    cancellation.dispose();
    ports.clearTimeout(transportDeadline);
  }

  if (isStaleRelayRun()) return 0;
  if (!captureResult.deliveryConfirmed) {
    run.activeCrossTeamReplyHints = [];
    ports.logger.debug(
      `[${teamName}] lead relay did not receive delivery proof; leaving ${batch.length} message(s) unread for retry`
    );
    ports.scheduleLeadInboxFollowUpRelay(teamName, LEAD_RELAY_NO_PROOF_RETRY_DELAY_MS);
    return 0;
  }
  if (recoveryMessageId && captureResult.terminalResultSucceeded) {
    ports.rememberSuccessfulLeadRecoveryMessage(teamName, recoveryMessageId);
  }

  rememberRecentCrossTeamLeadDeliveryMessageIds(
    ports.recentCrossTeamLeadDeliveryMessageIds,
    teamName,
    batch
      .filter((message) => message.source === CROSS_TEAM_SOURCE)
      .map((message) => message.messageId),
    ports.nowMs(),
    ports.recentCrossTeamDeliveryTtlMs
  );

  const readCommitBatch = await getLeadRelayReadCommitBatch({
    teamName,
    leadName,
    batch,
    hasAcceptedLeadWorkSyncReport: ports.hasAcceptedLeadWorkSyncReport,
    scheduleLeadProofMissingWorkSyncRecovery: (input) =>
      isStaleRelayRun()
        ? Promise.resolve(false)
        : ports.scheduleLeadProofMissingWorkSyncRecovery(input),
  });
  if (isStaleRelayRun()) return 0;
  for (const m of readCommitBatch) {
    relayedIds.add(m.messageId);
  }
  ports.relayedLeadInboxMessageIds.set(teamName, ports.trimRelayedSet(relayedIds));
  if (readCommitBatch.length > 0) {
    try {
      await ports.markInboxMessagesRead(teamName, leadName, readCommitBatch);
    } catch {
      // Best-effort: relay succeeded; marking read failed.
    }
  }

  if (isStaleRelayRun()) return 0;
  const replyProjection = projectLeadRelayReply({
    replyText: captureResult.replyText,
    relayPrompt: message,
    replyVisibility,
    capturedVisibleSendMessage: captureResult.capturedVisibleSendMessage,
    capturedUserVisibleSendMessage: captureResult.capturedUserVisibleSendMessage,
    leadName,
    runId,
    nowIso: ports.nowIso(),
    nowMs: ports.nowMs(),
  });
  if (replyProjection.kind === 'suppressed') {
    if (replyProjection.reason === 'internal_control') {
      ports.logger.debug(`[${teamName}] Suppressed internal lead relay echo`);
    } else if (replyProjection.reason === 'visible_duplicate') {
      ports.logger.debug(`[${teamName}] Suppressed lead relay text duplicated by visible message`);
    } else if (replyProjection.reason === 'unverified_state') {
      ports.logger.debug(`[${teamName}] Suppressed unverified lead relay state claim`);
    }
  } else if (replyProjection.kind === 'live_activity') {
    ports.pushLiveLeadTextMessage(
      run,
      replyProjection.text,
      replyProjection.messageId,
      replyProjection.timestamp
    );
  } else {
    ports.pushLiveLeadProcessMessage(teamName, replyProjection.message);
    ports.persistSentMessage(teamName, replyProjection.message);
    ports.emitTeamChange({
      type: 'inbox',
      teamName,
      detail: 'lead-process-reply',
    });
  }
  if (hasPendingFollowUpRelay) {
    ports.scheduleLeadInboxFollowUpRelay(teamName);
  }

  return batch.length;
}

function getLeadName(config: LeadInboxRelayConfig): string {
  return config.members?.find((m) => isLeadMember(m))?.name?.trim() || 'team-lead';
}

function startLeadRelayCapture<TRun extends LeadInboxRelayFlowRun>(
  run: TRun,
  leadName: string,
  replyVisibility: 'user' | 'internal_activity',
  recoveryMessageId: string | undefined,
  ports: Pick<LeadInboxRelayFlowPorts<TRun>, 'clearTimeout' | 'nowIso' | 'nowMs' | 'setTimeout'>
): Promise<string> {
  const captureTimeoutMs = LEAD_RELAY_CAPTURE_TIMEOUT_MS;
  // The target stream parser resolves ordinary captures after a short text-idle window. Recovery
  // delivery needs stronger proof: keep its idle deadline beyond the hard capture timeout so only
  // a terminal result can resolve it before the timeout rejects the delivery.
  const captureIdleMs = recoveryMessageId ? captureTimeoutMs + 1 : 800;
  const captureStartedAtMs = ports.nowMs();
  return new Promise<string>((resolve, reject) => {
    const onCaptureDeadline = (): void => {
      capture.rejectOnce('Timed out waiting for lead reply');
    };
    const timeoutHandle = ports.setTimeout(onCaptureDeadline, captureTimeoutMs);
    const capture: LeadInboxRelayCapture = {
      leadName,
      startedAt: ports.nowIso(),
      textParts: [],
      ...(recoveryMessageId ? { recoveryMessageId, requireTerminalResult: true } : {}),
      replyVisibility,
      hasVisibleSendMessage: false,
      hasUserVisibleSendMessage: false,
      settled: false,
      idleHandle: null,
      idleMs: captureIdleMs,
      timeoutHandle,
      // Any lead stream activity (text, tool_use, tool_result) proves the relayed prompt reached a
      // live lead turn. Extend the reply deadline instead of failing delivery mid-turn: a false
      // "not delivered" verdict re-sends the same message and a memoryless lead executes it again,
      // producing duplicate task sets and near-identical user messages.
      touch: () => {
        if (capture.settled) return;
        const remainingCapMs =
          LEAD_RELAY_CAPTURE_ABSOLUTE_CAP_MS - (ports.nowMs() - captureStartedAtMs);
        if (remainingCapMs <= 0) return;
        ports.clearTimeout(capture.timeoutHandle);
        // The re-armed deadline may never outlive the absolute cap: activity just before the cap
        // would otherwise buy another full base deadline and keep a wedged lane captured for far
        // longer than the cap promises.
        capture.timeoutHandle = ports.setTimeout(
          onCaptureDeadline,
          Math.min(captureTimeoutMs, remainingCapMs)
        );
      },
      resolveOnce: (text: string) => {
        if (capture.settled) return;
        if (recoveryMessageId) {
          capture.terminalResultSucceeded = true;
        }
        capture.settled = true;
        if (capture.idleHandle) {
          ports.clearTimeout(capture.idleHandle);
          capture.idleHandle = null;
        }
        ports.clearTimeout(capture.timeoutHandle);
        resolve(text);
      },
      rejectOnce: (error: string) => {
        if (capture.settled) return;
        capture.settled = true;
        if (capture.idleHandle) {
          ports.clearTimeout(capture.idleHandle);
          capture.idleHandle = null;
        }
        ports.clearTimeout(capture.timeoutHandle);
        reject(new Error(error));
      },
    };
    run.leadRelayCapture = capture;
  });
}

async function finalizeLeadRelayCapture<TRun extends LeadInboxRelayFlowRun>(
  run: TRun,
  capturePromise: Promise<string>,
  ports: Pick<LeadInboxRelayFlowPorts<TRun>, 'clearTimeout'>
): Promise<{
  replyText: string | null;
  capturedVisibleSendMessage: boolean;
  capturedUserVisibleSendMessage: boolean;
  deliveryConfirmed: boolean;
  terminalResultSucceeded: boolean;
}> {
  let replyText: string | null = null;
  let capturedVisibleSendMessage = false;
  let capturedUserVisibleSendMessage = false;
  let deliveryConfirmed = false;
  let terminalResultSucceeded = false;
  try {
    replyText = (await capturePromise).trim() || null;
    deliveryConfirmed = true;
    terminalResultSucceeded = run.leadRelayCapture?.terminalResultSucceeded === true;
  } catch {
    const partial = run.leadRelayCapture ? joinLeadRelayCaptureText(run.leadRelayCapture) : null;
    replyText = partial && partial.length > 0 ? partial : null;
  } finally {
    if (run.leadRelayCapture) {
      capturedVisibleSendMessage = run.leadRelayCapture.hasVisibleSendMessage === true;
      capturedUserVisibleSendMessage = run.leadRelayCapture.hasUserVisibleSendMessage === true;
      if (run.leadRelayCapture.idleHandle) {
        ports.clearTimeout(run.leadRelayCapture.idleHandle);
        run.leadRelayCapture.idleHandle = null;
      }
      ports.clearTimeout(run.leadRelayCapture.timeoutHandle);
      run.leadRelayCapture = null;
    }
  }
  return {
    replyText,
    capturedVisibleSendMessage,
    capturedUserVisibleSendMessage,
    deliveryConfirmed,
    terminalResultSucceeded,
  };
}
